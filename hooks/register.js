// session-meter: セッションの計測を JSONL に残し、プロンプトの上に1行出す。
//
// どの hook も記録するだけで、Claude Code の判断や入力は変えない。失敗した
// hook は .catch で「無かったもの」にし、本来の動作をそのまま進める。
//
// 記録先は ~/.claude/mod-metrics/<session-id>.jsonl。行はメモリに溜め、
// メインループの turn.complete と session.end でファイル全体を書き直す。
// 保存するたびに module が読み込み直されるので、session.start でファイル
// から行を読み戻す（圧縮の回数も行から数え直す）。

const MAX_ROWS = 5000;

let rows = [];
let file = null;
let dirty = false;
let capped = false;

// 帯に出す値
let info = { model: "", repoName: "", branch: "", effort: null, threshold: null, source: null };
let ctx = { tokens: 0, window: 0 };
let limits = [];
// 利用枠ごとに、記録済みの一番高い 10 ポイント刻みの線
let crossed = {};

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await setup($);
    return result;
  }).catch(fail);

  on("turn.step", async function* ($, e, next) {
    const r = yield* next(e);
    recordStep($, e, r);
    return r;
  }).catch(failStream);

  on("agent.spawn", async ($, e, next) => {
    const r = await next(e);
    push({ t: "spawn", type: e.subagentType, agentId: r.agentId, model: r.model, denied: r.deny ? true : undefined });
    return r;
  }).catch(fail);

  on("session.compact", async ($, e, next) => {
    // 結果に tokensBefore が無いときの予備。precompute では使わないので取らない
    let before = null;
    if (e.trigger !== "precompute" && !e.agentId) {
      try {
        before = await $.session.usage();
      } catch {
        // 取れなくても圧縮は進める
      }
    }
    const r = await next(e);
    if (e.trigger !== "precompute" && !r.skip) {
      try {
        // tokensBefore は core が記録しなかったときだけ無い。そのときはメインループに限り直前の計測で補う
        const tokens = r.tokensBefore ?? before?.context?.tokens ?? null;
        push({ t: "compact", trigger: e.trigger, agentId: e.agentId, tokens, after: r.tokensAfter, threshold: info.threshold });
        if (!e.agentId && r.tokensAfter != null) ctx.tokens = r.tokensAfter;
        $.ui.invalidate("ui.render");
        // /compact はターンではなく turn.complete が来ないので、ここで書き出す
        await flush($);
      } catch {
        // 記録に失敗しても、圧縮の結果はそのまま返す
      }
    }
    return r;
  }).catch(fail);

  on("session.measure", async ($, e, next) => {
    ctx = { tokens: e.context?.tokens ?? 0, window: e.context?.window ?? 0 };
    limits = e.rateLimits ?? [];
    for (const l of limits) {
      const key = l.kind + "@" + (l.resetsAt ?? "");
      const line = Math.floor(l.percentUsed / 10) * 10;
      if (line > 0 && line > (crossed[key] ?? 0)) {
        crossed[key] = line;
        push({ t: "ratelimit", kind: l.kind, percentUsed: l.percentUsed, line, resetsAt: l.resetsAt });
      }
    }
    $.ui.invalidate("ui.render");
    return next(e);
  }).catch(fail);

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (!e.agentId) {
      await flush($);
    }
    return r;
  }).catch(fail);

  on("session.end", async ($, e, next) => {
    await flush($);
    return next(e);
  }).catch(fail);

  on("command.run", { command: "metrics" }, async ($, e) => {
    return { text: summary() };
  }).catch(fail);

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.props?.hasSurvey || !info.model) {
      return next(e);
    }
    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, e.props?.bodyColumns ?? 80);
  }).catch(fail);
}

// 失敗した hook は無かったものにする（undefined を返す）。理由だけ transcript に薄く残す
function fail($, e, next) {
  $.ui.log("session-meter: " + (next.error?.kind ?? "error") + " " + (next.error?.message ?? ""));
  return undefined;
}

// turn.step 用。generator でなければならないので、下の結果をそのまま流す
async function* failStream($, e, next) {
  $.ui.log("session-meter: turn.step " + (next.error?.kind ?? "error") + " " + (next.error?.message ?? ""));
  return yield* next(e);
}

async function setup($) {
  const id = await $.session.id();
  const home = await $.env.get("HOME");
  file = home + "/.claude/mod-metrics/" + id + ".jsonl";

  rows = [];
  crossed = {};
  capped = false;
  if (await $.fs.exists(file)) {
    const text = await $.fs.read(file);
    for (const line of String(text).split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        rows.push(row);
        if (row.t === "ratelimit") {
          const key = row.kind + "@" + (row.resetsAt ?? "");
          crossed[key] = Math.max(crossed[key] ?? 0, row.line ?? 0);
        }
        if (row.t === "capped") capped = true;
      } catch {
        // 壊れた行は読み飛ばす
      }
    }
  }

  try {
    await $.command.register({ name: "metrics", description: "このセッションの計測（圧縮・cache・エージェント別・advisor）を表示する" });
  } catch {
    // 読み込み直しで登録済みのときもここに来る
  }

  const usage = await $.session.usage({ breakdown: "summary" });
  info.threshold = usage.context?.breakdown?.autoCompactThreshold ?? null;
  info.source = usage.context?.breakdown?.autocompactSource ?? null;
  ctx = { tokens: usage.context?.tokens ?? 0, window: usage.context?.window ?? 0 };
  limits = usage.rateLimits ?? [];

  info.model = await $.session.model();
  // effort はセッション単位で読む API がないので、最初の応答までは settings の値を出す。
  // 応答が来たら turn.step の e.effort（/effort での変更も反映される）で上書きする
  if (info.effort === null) {
    const settings = await $.settings.read();
    info.effort = settings.modelSettings?.[info.model]?.effortLevel ?? settings.effortLevel ?? null;
  }
  const repo = await $.session.repo();
  info.repoName = repo ? repo.root.split("/").pop() : "";
  info.branch = "";
  try {
    const r = await $.process.run(["git", "branch", "--show-current"], { timeoutMs: 3000 });
    if (r.exitCode === 0) info.branch = r.stdout.trim();
  } catch {
    // git がない、リポジトリ外など
  }

  push({ t: "start", model: info.model, repo: info.repoName, threshold: info.threshold, source: info.source });
  $.ui.invalidate("ui.render");
}

function recordStep($, e, r) {
  try {
    const u = r?.usage;
    const advisor = (r?.serverToolUses ?? []).filter((s) => s.name === "advisor").length;
    push({
      t: "step",
      agentId: e.agentId,
      model: u?.model ?? e.model,
      effort: e.effort,
      in: u?.input_tokens ?? 0,
      out: u?.output_tokens ?? 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheWrite: u?.cache_creation_input_tokens ?? 0,
      advisor: advisor || undefined,
    });
    if (!e.agentId && e.effort !== undefined && e.effort !== info.effort) {
      info.effort = e.effort;
      $.ui.invalidate("ui.render");
    }
  } catch {
    // 記録に失敗しても、モデルの応答はそのまま通す
  }
}

function push(row) {
  if (capped) return;
  if (rows.length >= MAX_ROWS) {
    rows.push({ t: "capped", at: Date.now(), max: MAX_ROWS });
    capped = true;
    dirty = true;
    return;
  }
  rows.push({ at: Date.now(), ...row });
  dirty = true;
}

async function flush($) {
  if (!file || !dirty) return;
  dirty = false;
  await $.fs.write(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function compactions() {
  return rows.filter((r) => r.t === "compact" && !r.agentId);
}

function band(Box, Text, columns) {
  const den = info.threshold ?? ctx.window;
  const pct = den ? Math.round((ctx.tokens / den) * 100) : 0;
  const ctxColor = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";

  const head = [{ text: info.model.replace(/^claude-/, ""), bold: true }];
  if (info.effort !== null) head.push({ text: String(info.effort), color: EFFORT_COLOR[info.effort] });
  if (info.repoName) head.push({ text: info.repoName + (info.branch ? "@" + info.branch : "") });

  const meter = [];
  if (den) meter.push({ text: "ctx " + short(ctx.tokens) + "/" + short(den) + " (" + pct + "%)", color: ctxColor });
  for (const l of limits) {
    const name = l.kind === "five_hour" ? "5h" : l.kind === "seven_day" ? "7d" : l.kind;
    const pctUsed = Math.round(l.percentUsed);
    const left = resetIn(l.resetsAt);
    meter.push({ text: name + " " + pctUsed + "%" + (left ? " (" + left + ")" : ""), color: pctUsed >= 80 ? "red" : pctUsed >= 50 ? "yellow" : undefined, dim: pctUsed < 50 });
  }
  meter.push({ text: "圧縮 " + compactions().length, dim: true });

  return Box({ flexDirection: "column", paddingX: 1, children: [line(Text, head, columns), line(Text, meter, columns)] });
}

// 幅に入らなければ後ろから落とす
function line(Text, segments, columns) {
  const sep = " · ";
  while (segments.length > 1 && width(segments.map((s) => s.text).join(sep)) + 2 > columns) {
    segments.pop();
  }
  const children = [];
  segments.forEach((s, i) => {
    if (i > 0) children.push(Text({ dimColor: true, children: [sep] }));
    children.push(Text({ color: s.color, bold: s.bold, dimColor: s.dim, children: [s.text] }));
  });
  return Text({ children });
}

function summary() {
  const steps = rows.filter((r) => r.t === "step");
  const spawns = rows.filter((r) => r.t === "spawn");
  const typeOf = {};
  for (const s of spawns) if (s.agentId) typeOf[s.agentId] = s.type;

  const sum = (list) => list.reduce((a, r) => ({
    in: a.in + r.in, out: a.out + r.out, cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite,
  }), { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
  const fmt = (t) => "in " + short(t.in) + " / out " + short(t.out) + " / cache read " + short(t.cacheRead) + " / cache write " + short(t.cacheWrite);

  const lines = [];
  const comp = compactions();
  lines.push("圧縮: " + comp.length + " 回" + (comp.length ? "（直前の context: " + comp.map((c) => short(c.tokens ?? 0) + " " + c.trigger).join(", ") + "）" : ""));
  lines.push("閾値: " + (info.threshold ? short(info.threshold) + "（" + info.source + "）" : "取得できず"));
  lines.push("メインループ: " + steps.filter((r) => !r.agentId).length + " リクエスト, " + fmt(sum(steps.filter((r) => !r.agentId))));

  const byType = {};
  for (const r of steps.filter((r) => r.agentId)) {
    const type = typeOf[r.agentId] ?? "(不明)";
    (byType[type] = byType[type] ?? []).push(r);
  }
  const counts = {};
  for (const s of spawns) counts[s.type] = (counts[s.type] ?? 0) + 1;
  const types = Object.keys({ ...byType, ...counts });
  if (types.length) {
    lines.push("サブエージェント:");
    for (const type of types) {
      lines.push("  " + type + ": 起動 " + (counts[type] ?? 0) + " 回, " + fmt(sum(byType[type] ?? [])));
    }
  }

  const adv = (list) => list.reduce((a, r) => a + (r.advisor ?? 0), 0);
  lines.push("advisor: メイン " + adv(steps.filter((r) => !r.agentId)) + " 回 / サブエージェント " + adv(steps.filter((r) => r.agentId)) + " 回");

  const rl = rows.filter((r) => r.t === "ratelimit");
  if (rl.length) lines.push("利用枠の線越え: " + rl.map((r) => r.kind + " " + r.line + "%").join(", "));
  if (capped) lines.push("記録は " + MAX_ROWS + " 行で打ち切り済み");
  lines.push("記録: " + (file ?? "(未設定)"));
  return lines.join("\n");
}

// statusline.sh と同じ色
const EFFORT_COLOR = { low: "green", medium: "yellow", high: "cyan", xhigh: "magenta", max: "red" };

// リセットまでの残り時間（statusline.sh と同じ書式: 3d17h / 4h25m / 12m）
function resetIn(iso) {
  if (!iso) return "";
  const sec = Math.floor((Date.parse(iso) - Date.now()) / 1000);
  if (!(sec > 0)) return "";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + "d" + h + "h";
  if (h > 0) return h + "h" + m + "m";
  return m + "m";
}

function short(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

// 全角は2桁として数える
function width(s) {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

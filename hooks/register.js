// session-meter: セッションの計測を JSONL に残し、プロンプトの上に2行出す。
//
// どの hook も記録するだけで、Claude Code の判断や入力は変えない。失敗した
// hook は .catch で「無かったもの」にし、本来の動作をそのまま進める。
//
// 記録先は ~/.claude/mod-metrics/<session-id>.jsonl。行はメモリに溜め、
// メインループの turn.complete と session.end でファイル全体を書き直す。
// 保存するたびに module が読み込み直されるので、session.start でファイル
// から行を読み戻す（圧縮の回数も行から数え直す）。
//
// /metrics            このセッションの集計
// /metrics 7d         直近7日の全セッションの集計
// /metrics prune 30d  更新から30日を過ぎた記録ファイルを消す（手で呼んだときだけ）

// fs.read と fs.write は 4 MiB を超えると失敗するので、余裕を見て 3 MiB で記録を打ち切る
const MAX_BYTES = 3 * 1024 * 1024;
// <session-id>.jsonl と、読み込めなかったときの退避先 <session-id>.<時刻>.jsonl
const FILE_NAME = /^[0-9a-f-]{36}(\.\d+)?\.jsonl$/;
const DAY = 86_400_000;

let rows = [];
let file = null;
let dir = null;
let sessionId = null;
// 書き出す内容の大きさ（バイト）。push のたびに足す
let bytes = 0;
// push のたびに増やす。書き出しの間に増えた行を取りこぼさないため
let seq = 0;
let flushedSeq = 0;
let capped = false;
// 「前回 Nm」を描き直すタイマーを動かしたか。/clear では module が続くので二重に動かさない
let ticking = false;
// 記録の失敗。/metrics と帯に出す。同じ内容のログは transcript に1回だけ出す
let health = { failures: 0, last: null };
const logged = new Set();

// 帯に出す値
let info = { model: "", repoName: "", branch: "", effort: null, threshold: null, source: null };
let ctx = { tokens: 0, window: 0 };
let limits = [];
// 利用枠ごとに、記録済みの一番高い 10 ポイント刻みの線
let crossed = {};
// 5h 枠のペース予測用。resetsAt ごとに、最初に見た時刻と使用率（メモリにだけ持つ）
let pace = {};
// 帯に出す予測（%）。100% に届かないときは null
let projected = null;
// 帯の描画のたびに全行を走査しないよう、最後のメインの応答時刻と圧縮回数を持つ
let lastMainAt = null;
let compactCount = 0;

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

  on("tool.call", async ($, e, next) => {
    const started = await $.clock.now();
    const r = await next(e);
    try {
      const ms = (await $.clock.now()) - started;
      push({ t: "tool", name: e.tool, agentId: e.agentId, ms, err: r.isError ? true : undefined, deny: r.deny ? true : undefined });
    } catch (err) {
      // 記録に失敗しても、ツールの結果はそのまま返す
      noteFailure($, "ツールの記録", err);
    }
    return r;
  }).catch(fail);

  on("session.compact", async ($, e, next) => {
    // 結果に tokensBefore が無いときの予備。precompute では使わないので取らない
    let before = null;
    if (e.trigger !== "precompute" && !e.agentId) {
      try {
        before = await $.session.usage();
      } catch (err) {
        // 取れなくても圧縮は進める
        noteFailure($, "圧縮前の使用量の取得", err);
      }
    }
    const r = await next(e);
    if (e.trigger !== "precompute" && !r.skip) {
      try {
        // tokensBefore は core が記録しなかったときだけ無い。そのときはメインループに限り直前の計測で補う
        const tokens = r.tokensBefore ?? before?.context?.tokens ?? null;
        push({ t: "compact", trigger: e.trigger, agentId: e.agentId, tokens, after: r.tokensAfter, threshold: info.threshold });
        if (!e.agentId) {
          compactCount++;
          if (r.tokensAfter != null) ctx.tokens = r.tokensAfter;
        }
        $.ui.invalidate("ui.render");
        // /compact はターンではなく turn.complete が来ないので、ここで書き出す
        await flush($);
      } catch (err) {
        // 記録に失敗しても、圧縮の結果はそのまま返す
        noteFailure($, "圧縮の記録", err);
      }
    }
    return r;
  }).catch(fail);

  on("session.measure", async ($, e, next) => {
    const now = await $.clock.now();
    ctx = { tokens: e.context?.tokens ?? 0, window: e.context?.window ?? 0 };
    limits = e.rateLimits ?? [];
    projected = null;
    for (const l of limits) {
      const key = l.kind + "@" + (l.resetsAt ?? "");
      const line = Math.floor(l.percentUsed / 10) * 10;
      if (line > 0 && line > (crossed[key] ?? 0)) {
        crossed[key] = line;
        push({ t: "ratelimit", kind: l.kind, percentUsed: l.percentUsed, line, resetsAt: l.resetsAt });
      }
      if (l.kind === "five_hour" && l.resetsAt) {
        const first = pace[l.resetsAt] ?? (pace[l.resetsAt] = { at: now, pct: l.percentUsed, warned: false });
        projected = projection(first, l, now);
        if (projected !== null && !first.warned) {
          first.warned = true;
          push({ t: "pace", kind: l.kind, percentUsed: l.percentUsed, projected, resetsAt: l.resetsAt });
        }
      }
    }
    $.ui.invalidate("ui.render");
    return next(e);
  }).catch(fail);

  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    // サブエージェントだけが動いている間も書き出す（新しい行がなければ何もしない）
    await flushSafely($);
    return r;
  }).catch(fail);

  on("session.end", async ($, e, next) => {
    const start = rows.find((r) => r.t === "start");
    push({ t: "end", reason: e.reason, durationMs: start ? Date.now() - start.at : undefined });
    try {
      await flush($);
    } catch (err) {
      noteFailure($, "書き出し", err);
    }
    const r = await next(e);
    // /clear と resume ではプロセスが別の session id で続き、session.start は来ない。
    // ここで記録先を新しい id に切り替えないと、次のセッションの行が古いファイルに混ざる。
    // session.end は core を含めて 1.5 秒しかないので、git などは呼ばず前の値を使う
    if ((e.reason === "clear" || e.reason === "resume") && dir) {
      const id = await $.session.id();
      if (id !== sessionId) {
        await openFile($, id);
        markStart();
        await flushSafely($);
      }
    }
    return r;
  }).catch(fail);

  on("command.run", { command: "metrics" }, async ($, e) => {
    const args = (e.args ?? "").trim().split(/\s+/).filter(Boolean);
    if (args[0] === "prune") {
      return { text: await prune($, args[1]) };
    }
    if (args[0]) {
      const days = parseDays(args[0]);
      if (!days) return { text: USAGE };
      return { text: await period($, days) };
    }
    return { text: summary() };
  }).catch(($, e, next) => {
    if (next.error?.kind === "re-entry") return undefined;
    noteFailure($, "/metrics", next.error?.message ?? next.error?.kind);
    return { text: "/metrics に失敗しました: " + (next.error?.message ?? next.error?.kind ?? "原因不明") };
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.props?.hasSurvey || !info.model) {
      return next(e);
    }
    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, e.props?.bodyColumns ?? 80);
  }).catch(fail);
}

const USAGE = "使い方: /metrics（このセッション） / /metrics 7d（直近7日） / /metrics prune 30d（30日より前の記録ファイルを消す）";

// 失敗した hook は無かったものにする（undefined を返す）。re-entry は hook が走らなかった
// だけで失敗ではないので数えない
function fail($, e, next) {
  if (next.error?.kind !== "re-entry") {
    noteFailure($, "hook " + next.event, (next.error?.kind ?? "error") + " " + (next.error?.message ?? ""));
  }
  return undefined;
}

// turn.step 用。generator でなければならないので、下の結果をそのまま流す
async function* failStream($, e, next) {
  if (next.error?.kind !== "re-entry") {
    noteFailure($, "hook turn.step", (next.error?.kind ?? "error") + " " + (next.error?.message ?? ""));
  }
  return yield* next(e);
}

// 記録の途中で失敗したことを数える。transcript に出すのは同じ内容の1回目だけで、
// 2回目以降は debug ログに回す（毎ツール・毎ターン同じ行が並ばないように）
function noteFailure($, where, err) {
  const message = where + "の失敗: " + (err?.message ?? String(err));
  health.failures++;
  health.last = message;
  try {
    if (logged.has(message)) {
      $.ui.log("session-meter: " + message, { to: "debug" });
    } else {
      logged.add(message);
      $.ui.log("session-meter: " + message);
    }
    $.ui.invalidate("ui.render");
  } catch {
    // ログが出せなくても、数は /metrics に残る
  }
}

async function setup($) {
  const home = await $.env.get("HOME");
  if (!home) {
    // 相対パス（undefined/.claude/...）に書かないよう、記録先が決まらなければ何もしない
    file = null;
    dir = null;
    noteFailure($, "準備", "HOME が取れないので記録しません");
    return;
  }
  dir = home + "/.claude/mod-metrics";
  const restoredEffort = await openFile($, await $.session.id());

  try {
    await $.command.register({ name: "metrics", description: "計測の集計（引数なし: このセッション、7d: 直近7日、prune 30d: 古い記録を消す）" });
  } catch {
    // 読み込み直しで登録済みのときもここに来る
  }

  // ここから先は帯と start 行に出す値。1つ取れなくても、ほかは進める
  try {
    const usage = await $.session.usage({ breakdown: "summary" });
    info.threshold = usage.context?.breakdown?.autoCompactThreshold ?? null;
    info.source = usage.context?.breakdown?.autocompactSource ?? null;
    ctx = { tokens: usage.context?.tokens ?? 0, window: usage.context?.window ?? 0 };
    limits = usage.rateLimits ?? [];
  } catch (err) {
    noteFailure($, "使用量の取得", err);
  }
  try {
    info.model = await $.session.model();
  } catch (err) {
    noteFailure($, "モデル名の取得", err);
  }
  // effort はセッション単位で読む API がないので、最初の応答までは settings の値を出す。
  // 応答が来たら turn.step の e.effort（/effort での変更も反映される）で上書きする
  if (restoredEffort !== undefined) {
    info.effort = restoredEffort;
  } else {
    try {
      const settings = await $.settings.read();
      info.effort = settings.modelSettings?.[info.model]?.effortLevel ?? settings.effortLevel ?? null;
    } catch (err) {
      noteFailure($, "settings の読み込み", err);
    }
  }
  try {
    const repo = await $.session.repo();
    info.repoName = repo ? repo.root.split("/").pop() : "";
  } catch (err) {
    noteFailure($, "リポジトリの取得", err);
  }
  info.branch = "";
  try {
    const r = await $.process.run(["git", "branch", "--show-current"], { timeoutMs: 3000 });
    if (r.exitCode === 0) info.branch = r.stdout.trim();
  } catch {
    // git がない、リポジトリ外など。失敗ではない
  }

  markStart();
  // 最初の応答より前に読み込み直されても start 行が残るよう、ここで書き出す
  await flushSafely($);

  // 「前回 Nm」を進めるため、1分ごとに描き直す。読み込み直すと古いタイマーは host が取り消す
  if (!ticking) {
    ticking = true;
    $.clock.every(60_000, () => $.ui.invalidate("ui.render"));
  }

  $.ui.invalidate("ui.render");
}

// 記録先を id のファイルにし、あれば行を読み戻す。最後のメインの応答の effort を返す。
// 読めなかったときは元のファイルを上書きしないよう、別名のファイルに書く
async function openFile($, id) {
  sessionId = id;
  file = dir + "/" + id + ".jsonl";
  rows = [];
  bytes = 0;
  seq = 0;
  flushedSeq = 0;
  crossed = {};
  capped = false;
  lastMainAt = null;
  compactCount = 0;
  health = { failures: 0, last: null };
  let text = null;
  try {
    if (await $.fs.exists(file)) text = await $.fs.read(file);
  } catch (err) {
    file = dir + "/" + id + "." + Date.now() + ".jsonl";
    noteFailure($, "記録の読み込み", err);
    return undefined;
  }
  let effort;
  for (const row of parseRows(text ?? "")) {
    rows.push(row);
    bytes += rowBytes(row);
    if (row.t === "ratelimit") {
      const key = row.kind + "@" + (row.resetsAt ?? "");
      crossed[key] = Math.max(crossed[key] ?? 0, row.line ?? 0);
    }
    if (row.t === "capped") capped = true;
    if (row.t === "step" && !row.agentId && !row.aborted) {
      lastMainAt = row.at;
      if (row.effort !== undefined) effort = row.effort;
    }
    if (row.t === "compact" && !row.agentId) compactCount++;
  }
  return effort;
}

// 読み込み直しでは start を重ねず、reload の行だけ残す
function markStart() {
  if (rows.some((r) => r.t === "start")) {
    push({ t: "reload" });
  } else {
    push({ t: "start", model: info.model, repo: info.repoName, threshold: info.threshold, source: info.source });
  }
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
    if (!e.agentId) {
      if (e.effort !== undefined) info.effort = e.effort;
      lastMainAt = Date.now();
      $.ui.invalidate("ui.render");
    }
  } catch (err) {
    // 記録に失敗しても、モデルの応答はそのまま通す
    noteFailure($, "応答の記録", err);
  }
}

function push(row) {
  if (capped) return;
  const full = { at: Date.now(), ...row };
  const size = rowBytes(full);
  if (bytes + size > MAX_BYTES) {
    const mark = { t: "capped", at: Date.now(), maxBytes: MAX_BYTES };
    rows.push(mark);
    bytes += rowBytes(mark);
    capped = true;
  } else {
    rows.push(full);
    bytes += size;
  }
  seq++;
}

// 書けたときだけ「書き出し済み」にする。失敗したら次の書き出しで同じ行をもう一度書く
async function flush($) {
  if (!file || seq === flushedSeq) return;
  const upTo = seq;
  await $.fs.write(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  flushedSeq = upTo;
}

async function flushSafely($) {
  try {
    await flush($);
  } catch (err) {
    noteFailure($, "書き出し", err);
  }
}

// JSON にしたときの UTF-8 のバイト数（改行を含む）
function rowBytes(row) {
  const json = JSON.stringify(row);
  let n = 1;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3;
  }
  return n;
}

function parseRows(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 壊れた行も捨てずに残す。ファイル全体を書き直すときに消えないように
      out.push({ t: "broken", raw: line });
    }
  }
  return out;
}

function parseDays(arg) {
  const m = /^(\d+)d$/.exec(arg ?? "");
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

// 記録ファイルの一覧（名前が session id のものだけ）
async function metricFiles($) {
  if (!dir || !(await $.fs.exists(dir))) return [];
  const entries = await $.fs.list(dir);
  return entries.filter((f) => f.kind === "file" && FILE_NAME.test(f.name));
}

async function period($, days) {
  const since = Date.now() - days * DAY;
  const all = [];
  // 期間より前に起動したセッションやエージェントも、リポジトリ名と種類は引けるようにする
  const repoOf = {};
  const spawnOf = {};
  let unreadable = 0;
  const take = (list, sid) => {
    for (const row of list) {
      if (row.t === "start") repoOf[sid] = row.repo || "(リポジトリ外)";
      if (row.t === "spawn" && row.agentId) spawnOf[row.agentId] = row;
      if (row.at >= since) all.push({ ...row, sid });
    }
  };
  for (const f of await metricFiles($)) {
    const sid = f.name.slice(0, 36);
    // いまのセッションは、まだ書き出していない行があるのでメモリから取る
    if (sid === sessionId) continue;
    if (f.mtimeMs < since) continue;
    try {
      take(parseRows(await $.fs.read(dir + "/" + f.name)), sid);
    } catch {
      unreadable++;
    }
  }
  take(rows, sessionId);
  const sessions = new Set(all.map((r) => r.sid)).size;
  return "直近 " + days + " 日（" + sessions + " セッション）\n" + report(all, { byRepo: true, repoOf, spawnOf })
    + (unreadable ? "\n読めなかった記録ファイル: " + unreadable + " 件" : "");
}

async function prune($, arg) {
  const days = parseDays(arg);
  if (!days) return USAGE;
  const before = Date.now() - days * DAY;
  // いまのセッションのファイル（退避先を含む）は消さない
  const old = (await metricFiles($)).filter((f) => f.mtimeMs < before && f.name.slice(0, 36) !== sessionId);
  if (!old.length) return days + " 日より前の記録ファイルはありません";
  const r = await $.process.run(["rm", "--", ...old.map((f) => dir + "/" + f.name)], { timeoutMs: 10000 });
  if (r.exitCode !== 0) return "削除に失敗しました: " + r.stderr.trim();
  const bytes = old.reduce((a, f) => a + f.size, 0);
  return days + " 日より前の記録ファイルを " + old.length + " 件（" + short(bytes) + "B）消しました";
}

function summary() {
  const all = rows.map((r) => ({ ...r, sid: sessionId }));
  const lines = [report(all, { rateLimits: true })];
  lines.push("閾値: " + (info.threshold ? short(info.threshold) + "（" + info.source + "）" : "取得できず"));
  if (capped) lines.push("記録は " + short(MAX_BYTES) + "B で打ち切り済み");
  const unsaved = seq - flushedSeq;
  lines.push("記録の状態: " + (health.failures
    ? "失敗 " + health.failures + " 回（最後: " + health.last + "）"
    : "正常") + (unsaved ? "、未保存 " + unsaved + " 行" : ""));
  lines.push("記録: " + (file ?? "(未設定)"));
  return lines.join("\n");
}

// 行の配列（sid 付き）から集計を作る。このセッション用と期間集計で共通
function report(list, opts = {}) {
  const steps = list.filter((r) => r.t === "step");
  const spawns = list.filter((r) => r.t === "spawn");
  const spawnOf = { ...opts.spawnOf };
  for (const s of spawns) if (s.agentId) spawnOf[s.agentId] = s;
  const isMain = (r) => !r.agentId;
  const lines = [];

  const comp = list.filter((r) => r.t === "compact" && isMain(r));
  const auto = comp.filter((c) => c.trigger === "auto").length;
  lines.push("圧縮: " + comp.length + " 回" + (comp.length ? "（auto " + auto + " / manual " + (comp.length - auto) + "）" : ""));
  if (comp.length && !opts.byRepo) {
    lines.push("  " + comp.map((c) => short(c.tokens ?? 0) + (c.after != null ? "→" + short(c.after) : "") + " " + c.trigger).join(", "));
  }

  const rebuilt = rebuilds(list);
  const main = steps.filter(isMain);
  lines.push("メインループ: " + main.length + " リクエスト, " + fmt(sum(main)) + ", " + cacheText(main, rebuilt));

  if (opts.byRepo) {
    const repoOf = { ...opts.repoOf };
    for (const r of list) if (r.t === "start") repoOf[r.sid] = r.repo || "(リポジトリ外)";
    const byRepo = group(main, (r) => repoOf[r.sid] ?? "(不明)");
    if (Object.keys(byRepo).length) {
      lines.push("リポジトリ別（メインループ）:");
      for (const [repo, l] of sorted(byRepo, (l) => total(sum(l)))) {
        lines.push("  " + repo + ": " + l.length + " リクエスト, " + short(total(sum(l))) + " tokens");
      }
    }
  }

  // エージェントの種類とモデルごと
  const keyOf = (s) => (s.type ?? "(不明)") + (s.model ? " [" + s.model.replace(/^claude-/, "") + "]" : "");
  const byKey = group(steps.filter((r) => r.agentId), (r) => (spawnOf[r.agentId] ? keyOf(spawnOf[r.agentId]) : "(不明)"));
  const counts = {};
  for (const s of spawns) counts[keyOf(s)] = (counts[keyOf(s)] ?? 0) + 1;
  const keys = Object.keys({ ...byKey, ...counts });
  if (keys.length) {
    lines.push("サブエージェント:");
    for (const key of keys.sort((a, b) => total(sum(byKey[b] ?? [])) - total(sum(byKey[a] ?? [])))) {
      const l = byKey[key] ?? [];
      const n = counts[key] ?? 0;
      const avg = n ? ", 1回あたり " + short(Math.round(total(sum(l)) / n)) : "";
      lines.push("  " + key + ": 起動 " + n + " 回" + avg + ", " + fmt(sum(l)) + ", " + cacheText(l, rebuilt));
    }
  }

  const adv = (l) => l.reduce((a, r) => a + (r.advisor ?? 0), 0);
  lines.push("advisor: メイン " + adv(main) + " 回 / サブエージェント " + adv(steps.filter((r) => r.agentId)) + " 回");

  const tools = list.filter((r) => r.t === "tool");
  if (tools.length) {
    lines.push("ツール（合計時間の長い順、上位10）:");
    for (const [name, l] of sorted(group(tools, (r) => r.name), (l) => l.reduce((a, r) => a + (r.ms ?? 0), 0)).slice(0, 10)) {
      const errs = l.filter((r) => r.err || r.deny).length;
      lines.push("  " + name + ": " + l.length + " 回" + (errs ? "（失敗 " + errs + "）" : "") + ", 合計 " + duration(l.reduce((a, r) => a + (r.ms ?? 0), 0)));
    }
  }

  const broken = list.filter((r) => r.t === "broken").length;
  if (broken) lines.push("壊れた行: " + broken + " 行（読み飛ばして集計）");

  if (opts.rateLimits) {
    const rl = list.filter((r) => r.t === "ratelimit");
    if (rl.length) lines.push("利用枠の線越え: " + rl.map((r) => r.kind + " " + r.line + "%").join(", "));
  }
  return lines.join("\n");
}

// cache を作り直したリクエスト。同じループ（セッションのメインか、サブエージェント）の
// 2回目以降で、cacheWrite が cacheRead を上回ったもの。初回と圧縮直後は書き込むのが当然なので除く
function rebuilds(list) {
  const seen = new Set();
  const out = new Set();
  for (const r of list) {
    const loop = r.agentId ?? "main:" + r.sid;
    if (r.t === "compact") {
      seen.delete(loop);
      continue;
    }
    if (r.t !== "step") continue;
    if (seen.has(loop) && r.cacheWrite > r.cacheRead) out.add(r);
    seen.add(loop);
  }
  return out;
}

function cacheText(steps, rebuilt) {
  const t = sum(steps);
  const input = t.in + t.cacheRead + t.cacheWrite;
  const n = steps.filter((r) => rebuilt.has(r)).length;
  return "cache から " + (input ? Math.round((t.cacheRead / input) * 100) : 0) + "%" + (n ? "（作り直し " + n + " 回）" : "");
}

function sum(list) {
  return list.reduce((a, r) => ({
    in: a.in + (r.in ?? 0), out: a.out + (r.out ?? 0), cacheRead: a.cacheRead + (r.cacheRead ?? 0), cacheWrite: a.cacheWrite + (r.cacheWrite ?? 0),
  }), { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
}

function total(t) {
  return t.in + t.out + t.cacheRead + t.cacheWrite;
}

function fmt(t) {
  return "in " + short(t.in) + " / out " + short(t.out) + " / cache read " + short(t.cacheRead) + " / cache write " + short(t.cacheWrite);
}

function group(list, keyFn) {
  const out = {};
  for (const r of list) (out[keyFn(r)] = out[keyFn(r)] ?? []).push(r);
  return out;
}

function sorted(groups, scoreFn) {
  return Object.entries(groups).sort((a, b) => scoreFn(b[1]) - scoreFn(a[1]));
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
  // 幅が狭くても落ちないよう、ctx の次に置く
  if (health.failures) meter.push({ text: "⚠ 記録", color: "yellow" });
  for (const l of limits) {
    const name = l.kind === "five_hour" ? "5h" : l.kind === "seven_day" ? "7d" : l.kind;
    const pctUsed = Math.round(l.percentUsed);
    const left = resetIn(l.resetsAt);
    meter.push({ text: name + " " + pctUsed + "%" + (left ? " (" + left + ")" : ""), color: pctUsed >= 80 ? "red" : pctUsed >= 50 ? "yellow" : undefined, dim: pctUsed < 50 });
    if (l.kind === "five_hour" && projected !== null) meter.push({ text: "→ 予測 " + projected + "%", color: "red" });
  }
  if (lastMainAt) meter.push({ text: "前回 " + (ago(lastMainAt) || "今"), dim: true });
  meter.push({ text: "圧縮 " + compactCount, dim: true });

  return Box({ flexDirection: "column", paddingX: 1, children: [line(Text, head, columns), line(Text, meter, columns)] });
}

// 5h 枠をこのままの速さで使うと、リセット時に何 % になるか。100% に届くときだけ返す。
// 最初の観測から10分たつまでは、速さが当てにならないので出さない
function projection(first, l, now) {
  const reset = Date.parse(l.resetsAt);
  if (!(reset > now) || now - first.at < 600_000) return null;
  const rate = (l.percentUsed - first.pct) / (now - first.at);
  if (!(rate > 0)) return null;
  const projected = Math.round(l.percentUsed + rate * (reset - now));
  return projected >= 100 ? projected : null;
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

// statusline.sh と同じ色
const EFFORT_COLOR = { low: "green", medium: "yellow", high: "cyan", xhigh: "magenta", max: "red" };

// リセットまでの残り時間（statusline.sh と同じ書式: 3d17h / 4h25m / 12m）
function resetIn(iso) {
  if (!iso) return "";
  return span(Math.floor((Date.parse(iso) - Date.now()) / 1000));
}

// 経過時間（同じ書式。1分未満は空）
function ago(at) {
  return span(Math.floor((Date.now() - at) / 1000));
}

function span(sec) {
  if (!(sec >= 60)) return "";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + "d" + h + "h";
  if (h > 0) return h + "h" + m + "m";
  return m + "m";
}

function duration(ms) {
  if (ms < 1000) return ms + "ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  return span(Math.floor(ms / 1000));
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

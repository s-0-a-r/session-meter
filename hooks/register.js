// session-meter: records per-session metrics to JSONL and draws two lines above the prompt.
//
// Every hook only records. None of them changes Claude Code's decisions or inputs. A hook
// that fails is turned into "no hook" via .catch, so the original behavior carries on.
//
// Records go to ~/.claude/mod-metrics/<session-id>.jsonl. Rows are kept in memory, and the
// whole file is rewritten on the main loop's turn.complete and on session.end. The module
// is reloaded on every save, so session.start reads the rows back from the file (and
// recounts compactions from them).
//
// /metrics            summary of this session
// /metrics 7d         summary of all sessions in the last 7 days
// /metrics prune 30d  delete record files not updated for 30 days (only when run by hand)

// fs.read and fs.write fail above 4 MiB, so stop recording at 3 MiB to leave headroom
const MAX_BYTES = 3 * 1024 * 1024;
// <session-id>.jsonl, plus <session-id>.<time>.jsonl used when the original could not be read
const FILE_NAME = /^[0-9a-f-]{36}(\.\d+)?\.jsonl$/;
const DAY = 86_400_000;

let rows = [];
let file = null;
let dir = null;
let sessionId = null;
// Size in bytes of what will be written. Added to on every push
let bytes = 0;
// Incremented on every push, so rows added while a write is in flight are not lost
let seq = 0;
let flushedSeq = 0;
let capped = false;
// Whether the timer that redraws "last Nm" is running. The module survives /clear, so don't start it twice
let ticking = false;
// Waiting to switch to the new session id after /clear or resume
let switchPending = false;
// The switch in progress. Several hooks may call follow at once; switch only once
let following = null;
// Recording failures, shown in /metrics and the band. The same log message goes to the transcript only once
let health = { failures: 0, last: null };
const logged = new Set();

// Values shown in the band
let info = { model: "", repoName: "", branch: "", effort: null, threshold: null, source: null };
let ctx = { tokens: 0, window: 0 };
let limits = [];
// Per rate limit, the highest 10-point line already recorded
let crossed = {};
// For the 5h pace projection: per resetsAt, the first time and percentage seen (memory only)
let pace = {};
// Projection (%) shown in the band. null when it does not reach 100%
let projected = null;
// Last main-loop response time and compaction count, so the band need not scan every row on each render
let lastMainAt = null;
let compactCount = 0;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await setup($);
    return result;
  }).catch(fail);

  on("turn.step", async function* ($, e, next) {
    await follow($);
    const r = yield* next(e);
    recordStep($, e, r);
    return r;
  }).catch(failStream);

  on("agent.spawn", async ($, e, next) => {
    await follow($);
    const r = await next(e);
    push({ t: "spawn", type: e.subagentType, agentId: r.agentId, model: r.model, denied: r.deny ? true : undefined });
    return r;
  }).catch(fail);

  on("tool.call", async ($, e, next) => {
    await follow($);
    const started = await $.clock.now();
    const r = await next(e);
    try {
      const ms = (await $.clock.now()) - started;
      push({ t: "tool", name: e.tool, agentId: e.agentId, ms, err: r.isError ? true : undefined, deny: r.deny ? true : undefined });
    } catch (err) {
      // Even if recording fails, return the tool result unchanged
      noteFailure($, "recording a tool call", err);
    }
    return r;
  }).catch(fail);

  on("session.compact", async ($, e, next) => {
    await follow($);
    // Fallback for when the result has no tokensBefore. Not needed for precompute, so skip it there
    let before = null;
    if (e.trigger !== "precompute" && !e.agentId) {
      try {
        before = await $.session.usage();
      } catch (err) {
        // Let the compaction proceed anyway
        noteFailure($, "reading usage before compaction", err);
      }
    }
    const r = await next(e);
    if (e.trigger !== "precompute" && !r.skip) {
      try {
        // tokensBefore is missing only when core did not record it. Then, for the main loop only, use the last measurement
        const tokens = r.tokensBefore ?? before?.context?.tokens ?? null;
        push({ t: "compact", trigger: e.trigger, agentId: e.agentId, tokens, after: r.tokensAfter, threshold: info.threshold });
        if (!e.agentId) {
          if (rows.at(-1)?.t === "compact") compactCount++;
          if (r.tokensAfter != null) ctx.tokens = r.tokensAfter;
        }
        $.ui.invalidate("ui.render");
        // /compact is not a turn, so no turn.complete follows. Write here
        await flush($);
      } catch (err) {
        // Even if recording fails, return the compaction result unchanged
        noteFailure($, "recording a compaction", err);
      }
    }
    return r;
  }).catch(fail);

  on("session.measure", async ($, e, next) => {
    await follow($);
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
    await follow($);
    const r = await next(e);
    // Also write while only subagents are running (does nothing if there are no new rows)
    await flushSafely($);
    return r;
  }).catch(fail);

  on("session.end", async ($, e, next) => {
    const start = rows.find((r) => r.t === "start");
    push({ t: "end", reason: e.reason, durationMs: start ? Date.now() - start.at : undefined });
    try {
      await flush($);
    } catch (err) {
      noteFailure($, "writing records", err);
    }
    const r = await next(e);
    // After /clear and resume the process continues under a different session id, and no
    // session.start arrives. Without switching to the new id, the next session's rows would
    // end up in the old file. Inside session.end, $.session.id() can still return the old id
    // (confirmed on a real machine), so only set a flag here and switch at the start of the next hook
    if (e.reason === "clear" || e.reason === "resume") {
      // Show ctx as unknown until the next measurement, rather than the previous session's value
      ctx = { tokens: null, window: ctx.window };
      lastMainAt = null;
      compactCount = 0;
      $.ui.invalidate("ui.render");
      if (dir) {
        switchPending = true;
        await follow($);
      }
    }
    return r;
  }).catch(fail);

  on("command.run", { command: "metrics" }, async ($, e) => {
    await follow($);
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
    return { text: "/metrics failed: " + (next.error?.message ?? next.error?.kind ?? "unknown error") };
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    const lines = e.props?.hasSurvey ? [] : bandLines();
    if (!lines.length) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, lines, e.props?.bodyColumns ?? 80);
  }).catch(failRender);
}

const USAGE = "Usage: /metrics (this session) / /metrics 7d (last 7 days) / /metrics prune 30d (delete record files older than 30 days)";

// Turn a failed hook into "no hook" (return undefined). re-entry only means the hook did not
// run, which is not a failure, so it is not counted
function fail($, e, next) {
  if (next.error?.kind !== "re-entry") {
    noteFailure($, "hook " + next.event, (next.error?.kind ?? "error") + " " + (next.error?.message ?? ""));
  }
  return undefined;
}

// For band rendering. Asking for a redraw would fail again and keep rendering in a loop, so only count it
function failRender($, e, next) {
  if (next.error?.kind !== "re-entry") {
    health.failures++;
    health.last = "hook ui.render failed: " + (next.error?.kind ?? "error") + " " + (next.error?.message ?? "");
  }
  return undefined;
}

// For turn.step. It must be a generator, so pass the result from below through as is
async function* failStream($, e, next) {
  if (next.error?.kind !== "re-entry") {
    noteFailure($, "hook turn.step", (next.error?.kind ?? "error") + " " + (next.error?.message ?? ""));
  }
  return yield* next(e);
}

// Count a recording failure. Only the first occurrence of a message goes to the transcript;
// repeats go to the debug log (so the same line does not appear on every tool call and turn)
function noteFailure($, where, err) {
  const message = where + " failed: " + (err?.message ?? String(err));
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
    // Even if logging fails, the count stays in /metrics
  }
}

async function setup($) {
  const home = await $.env.get("HOME");
  if (!home) {
    // Without a destination, do nothing, rather than writing to a relative path (undefined/.claude/...)
    file = null;
    dir = null;
    noteFailure($, "setup", "HOME is not set, so nothing will be recorded");
    return;
  }
  dir = home + "/.claude/mod-metrics";
  const restoredEffort = await openFile($, await $.session.id());

  try {
    await $.command.register({ name: "metrics", description: "Session metrics (no args: this session, 7d: last 7 days, prune 30d: delete old records)" });
  } catch {
    // Also lands here on reload, when the command is already registered
  }

  // Values for the band and the start row from here on. If one is unavailable, carry on with the rest
  try {
    const usage = await $.session.usage({ breakdown: "summary" });
    info.threshold = usage.context?.breakdown?.autoCompactThreshold ?? null;
    info.source = usage.context?.breakdown?.autocompactSource ?? null;
    ctx = { tokens: usage.context?.tokens ?? 0, window: usage.context?.window ?? 0 };
    limits = usage.rateLimits ?? [];
  } catch (err) {
    noteFailure($, "reading usage", err);
  }
  try {
    info.model = await $.session.model();
  } catch (err) {
    noteFailure($, "reading the model name", err);
  }
  // There is no API to read effort per session, so show the settings value until the first
  // response. Once a response arrives, turn.step's e.effort (which reflects /effort) replaces it
  if (restoredEffort !== undefined) {
    info.effort = restoredEffort;
  } else {
    try {
      const settings = await $.settings.read();
      info.effort = settings.modelSettings?.[info.model]?.effortLevel ?? settings.effortLevel ?? null;
    } catch (err) {
      noteFailure($, "reading settings", err);
    }
  }
  try {
    const repo = await $.session.repo();
    info.repoName = repo ? repo.root.split("/").pop() : "";
  } catch (err) {
    noteFailure($, "reading the repository", err);
  }
  info.branch = "";
  try {
    const r = await $.process.run(["git", "branch", "--show-current"], { timeoutMs: 3000 });
    if (r.exitCode === 0) info.branch = r.stdout.trim();
  } catch {
    // No git, outside a repository, etc. Not a failure
  }

  markStart();
  // Write now, so the start row survives a reload before the first response
  await flushSafely($);

  // Redraw every minute to advance "last Nm". On reload the host cancels the old timer
  if (!ticking) {
    ticking = true;
    $.clock.every(60_000, () => $.ui.invalidate("ui.render"));
  }

  $.ui.invalidate("ui.render");
}

// Point recording at the file for id and read its rows back if it exists. Returns the effort of
// the last main-loop response. If the file cannot be read, write to a differently named file so
// the original is not overwritten.
// When carry is true (switching on /clear or resume), keep the failure count and the crossed
// rate-limit lines. Rate limits span sessions, so lines already crossed are not written again
async function openFile($, id, carry = false) {
  const prev = { health, crossed };
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
  health = carry ? prev.health : { failures: 0, last: null };
  if (carry) crossed = prev.crossed;
  let text = null;
  try {
    if (await $.fs.exists(file)) text = await $.fs.read(file);
  } catch (err) {
    file = dir + "/" + id + "." + Date.now() + ".jsonl";
    noteFailure($, "reading records", err);
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
    if (row.t === "step" && !row.agentId) {
      lastMainAt = row.at;
      if (row.effort !== undefined) effort = row.effort;
    }
    if (row.t === "compact" && !row.agentId) compactCount++;
  }
  return effort;
}

// Only while a switch is pending, ask for the id and move to the new file if it changed.
// session.end has only 1.5 s, so reuse the previous values instead of calling git and the like
async function follow($) {
  if (!switchPending) return;
  following ??= switchFile($).finally(() => {
    following = null;
  });
  await following;
}

async function switchFile($) {
  try {
    const id = await $.session.id();
    if (!id || id === sessionId) return;
    switchPending = false;
    // Write out the rest of the previous session before moving. If that fails, record how many rows were lost
    await flushSafely($);
    const lost = seq - flushedSeq;
    await openFile($, id, true);
    if (lost > 0) noteFailure($, "writing the previous session's records", "lost " + count(lost, "row") + " that could not be written");
    markStart();
    await flushSafely($);
  } catch (err) {
    noteFailure($, "switching the record file", err);
  }
}

// On reload, don't add another start row; leave only a reload row
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
    if (!u) {
      // An aborted response has no usage. Mark it so it is not counted as a zero-token request
      push({ t: "step", agentId: e.agentId, model: e.model, effort: e.effort, aborted: true, advisor: advisor || undefined });
    } else push({
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
    // Even if recording fails, pass the model's response through unchanged
    noteFailure($, "recording a response", err);
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

// Mark rows as written only after the write succeeds. On failure, the next flush writes them again
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
    noteFailure($, "writing records", err);
  }
}

// UTF-8 byte length of the row as JSON (including the newline)
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
      const row = JSON.parse(line);
      // null or number rows would break on row.t, so treat them like broken rows
      out.push(row && typeof row === "object" && !Array.isArray(row) ? row : { t: "broken", raw: line });
    } catch {
      // Keep broken rows instead of dropping them, so rewriting the whole file does not erase them
      out.push({ t: "broken", raw: line });
    }
  }
  return out;
}

function parseDays(arg) {
  const m = /^(\d+)d$/.exec(arg ?? "");
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

// Record files (only those named after a session id)
async function metricFiles($) {
  if (!dir || !(await $.fs.exists(dir))) return [];
  const entries = await $.fs.list(dir);
  return entries.filter((f) => f.kind === "file" && FILE_NAME.test(f.name));
}

async function period($, days) {
  const since = Date.now() - days * DAY;
  const all = [];
  // Look up repository names and agent types even for sessions and agents started before the period
  const repoOf = {};
  const spawnOf = {};
  let unreadable = 0;
  const take = (list, sid) => {
    for (const row of list) {
      if (row.t === "start") repoOf[sid] = row.repo || "(no repo)";
      if (row.t === "spawn" && row.agentId) spawnOf[row.agentId] = row;
      if (row.at >= since) all.push({ ...row, sid });
    }
  };
  for (const f of await metricFiles($)) {
    const sid = f.name.slice(0, 36);
    // The current session may have unwritten rows, so take it from memory
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
  return "Last " + count(days, "day") + " (" + count(sessions, "session") + ")\n" + report(all, { byRepo: true, repoOf, spawnOf })
    + (unreadable ? "\nUnreadable record files: " + unreadable : "");
}

async function prune($, arg) {
  const days = parseDays(arg);
  if (!days) return USAGE;
  const before = Date.now() - days * DAY;
  // Never delete the current session's files (including fallback files)
  const old = (await metricFiles($)).filter((f) => f.mtimeMs < before && f.name.slice(0, 36) !== sessionId);
  if (!old.length) return "No record files older than " + count(days, "day");
  const r = await $.process.run(["rm", "--", ...old.map((f) => dir + "/" + f.name)], { timeoutMs: 10000 });
  if (r.exitCode !== 0) return "Delete failed: " + r.stderr.trim();
  const bytes = old.reduce((a, f) => a + f.size, 0);
  return "Deleted " + count(old.length, "record file") + " older than " + count(days, "day") + " (" + short(bytes) + "B)";
}

function summary() {
  const all = rows.map((r) => ({ ...r, sid: sessionId }));
  const lines = [report(all, { rateLimits: true })];
  lines.push("Threshold: " + (info.threshold ? short(info.threshold) + " (" + info.source + ")" : "unavailable"));
  if (capped) lines.push("Recording stopped at " + short(MAX_BYTES) + "B");
  const unsaved = seq - flushedSeq;
  lines.push("Recording: " + (health.failures
    ? count(health.failures, "failure") + " (last: " + health.last + ")"
    : "OK") + (unsaved ? ", " + count(unsaved, "row") + " unsaved" : ""));
  lines.push("File: " + (file ?? "(none)"));
  return lines.join("\n");
}

// Build a summary from rows (with sid). Shared by the per-session and per-period views
function report(list, opts = {}) {
  // Aborted responses have no tokens, so keep them out of request counts and totals and count them separately
  const steps = list.filter((r) => r.t === "step" && !r.aborted);
  const aborted = list.filter((r) => r.t === "step" && r.aborted);
  const spawns = list.filter((r) => r.t === "spawn");
  const spawnOf = { ...opts.spawnOf };
  for (const s of spawns) if (s.agentId) spawnOf[s.agentId] = s;
  const isMain = (r) => !r.agentId;
  const lines = [];

  const comp = list.filter((r) => r.t === "compact" && isMain(r));
  const auto = comp.filter((c) => c.trigger === "auto").length;
  lines.push("Compactions: " + comp.length + (comp.length ? " (auto " + auto + " / manual " + (comp.length - auto) + ")" : ""));
  if (comp.length && !opts.byRepo) {
    // Show missing values as ?, not 0
    lines.push("  " + comp.map((c) => (c.tokens != null ? short(c.tokens) : "?") + (c.after != null ? "→" + short(c.after) : "") + " " + c.trigger).join(", "));
  }

  const rebuilt = rebuilds(list);
  const main = steps.filter(isMain);
  const abortedMain = aborted.filter(isMain).length;
  lines.push("Main loop: " + count(main.length, "request") + (abortedMain ? " (+" + abortedMain + " aborted)" : "") + ", " + fmt(sum(main)) + ", " + cacheText(main, rebuilt));

  if (opts.byRepo) {
    const repoOf = { ...opts.repoOf };
    for (const r of list) if (r.t === "start") repoOf[r.sid] = r.repo || "(no repo)";
    const byRepo = group(main, (r) => repoOf[r.sid] ?? "(unknown)");
    if (Object.keys(byRepo).length) {
      lines.push("By repository (main loop):");
      for (const [repo, l] of sorted(byRepo, (l) => total(sum(l)))) {
        lines.push("  " + repo + ": " + count(l.length, "request") + ", " + short(total(sum(l))) + " tokens");
      }
    }
  }

  // Per agent type and model
  const keyOf = (s) => (s.type ?? "(unknown)") + (s.model ? " [" + s.model.replace(/^claude-/, "") + "]" : "");
  const byKey = group(steps.filter((r) => r.agentId), (r) => (spawnOf[r.agentId] ? keyOf(spawnOf[r.agentId]) : "(unknown)"));
  const counts = {};
  for (const s of spawns) counts[keyOf(s)] = (counts[keyOf(s)] ?? 0) + 1;
  const keys = Object.keys({ ...byKey, ...counts });
  if (keys.length) {
    lines.push("Subagents:");
    for (const key of keys.sort((a, b) => total(sum(byKey[b] ?? [])) - total(sum(byKey[a] ?? [])))) {
      const l = byKey[key] ?? [];
      const n = counts[key] ?? 0;
      const avg = n ? ", " + short(Math.round(total(sum(l)) / n)) + " per spawn" : "";
      lines.push("  " + key + ": " + count(n, "spawn") + avg + ", " + fmt(sum(l)) + ", " + cacheText(l, rebuilt));
    }
  }

  const adv = (l) => l.reduce((a, r) => a + (r.advisor ?? 0), 0);
  lines.push("advisor: main " + adv(main) + " / subagents " + adv(steps.filter((r) => r.agentId)));

  const tools = list.filter((r) => r.t === "tool");
  if (tools.length) {
    lines.push("Tools (by total time, top 10):");
    for (const [name, l] of sorted(group(tools, (r) => r.name), (l) => l.reduce((a, r) => a + (r.ms ?? 0), 0)).slice(0, 10)) {
      const errs = l.filter((r) => r.err || r.deny).length;
      lines.push("  " + name + ": " + count(l.length, "call") + (errs ? " (" + errs + " failed)" : "") + ", total " + duration(l.reduce((a, r) => a + (r.ms ?? 0), 0)));
    }
  }

  const broken = list.filter((r) => r.t === "broken").length;
  if (broken) lines.push("Broken rows: " + broken + " (skipped)");

  if (opts.rateLimits) {
    const rl = list.filter((r) => r.t === "ratelimit");
    if (rl.length) lines.push("Rate limit lines crossed: " + rl.map((r) => r.kind + " " + r.line + "%").join(", "));
  }
  return lines.join("\n");
}

// Requests that rebuilt the cache: from the second request of the same loop (the session's main
// loop or a subagent) on, those whose cacheWrite exceeds cacheRead. The first request and the one
// right after a compaction are expected to write, so they are excluded
function rebuilds(list) {
  const seen = new Set();
  const out = new Set();
  for (const r of list) {
    const loop = r.agentId ?? "main:" + r.sid;
    if (r.t === "compact") {
      seen.delete(loop);
      continue;
    }
    if (r.t !== "step" || r.aborted) continue;
    if (seen.has(loop) && r.cacheWrite > r.cacheRead) out.add(r);
    seen.add(loop);
  }
  return out;
}

function cacheText(steps, rebuilt) {
  const t = sum(steps);
  const input = t.in + t.cacheRead + t.cacheWrite;
  const n = steps.filter((r) => rebuilt.has(r)).length;
  return (input ? Math.round((t.cacheRead / input) * 100) : 0) + "% from cache" + (n ? " (" + count(n, "rebuild") + ")" : "");
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

function band(Box, Text, lines, columns) {
  return Box({ flexDirection: "column", paddingX: 1, children: lines.map((segments) => line(Text, segments, columns)) });
}

// Band lines (each a list of { text, color, bold, dim } segments). Empty when there is nothing to show.
// Even without a model name, show the second line if recording failed (so the failure is noticed)
function bandLines() {
  if (!info.model && !health.failures && !capped) return [];
  const den = info.threshold ?? ctx.window;
  const known = ctx.tokens !== null;
  const pct = den && known ? Math.round((ctx.tokens / den) * 100) : 0;
  const ctxColor = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";

  const lines = [];
  if (info.model) {
    const head = [{ text: info.model.replace(/^claude-/, ""), bold: true }];
    if (info.effort !== null) head.push({ text: String(info.effort), color: EFFORT_COLOR[info.effort] });
    if (info.repoName) head.push({ text: info.repoName + (info.branch ? "@" + info.branch : "") });
    lines.push(head);
  }

  const meter = [];
  if (den) {
    meter.push(known ? { text: "ctx " + short(ctx.tokens) + "/" + short(den) + " (" + pct + "%)", color: ctxColor } : { text: "ctx ?/" + short(den), dim: true });
  }
  // Placed right after ctx so it survives on narrow terminals
  if (health.failures || capped) meter.push({ text: "⚠ recording", color: "yellow" });
  for (const l of limits) {
    const name = l.kind === "five_hour" ? "5h" : l.kind === "seven_day" ? "7d" : l.kind;
    const pctUsed = Math.round(l.percentUsed);
    const left = resetIn(l.resetsAt);
    meter.push({ text: name + " " + pctUsed + "%" + (left ? " (" + left + ")" : ""), color: pctUsed >= 80 ? "red" : pctUsed >= 50 ? "yellow" : undefined, dim: pctUsed < 50 });
    if (l.kind === "five_hour" && projected !== null) meter.push({ text: "→ " + projected + "% at reset", color: "red" });
  }
  if (lastMainAt) meter.push({ text: "last " + (ago(lastMainAt) || "now"), dim: true });
  meter.push({ text: "compact " + compactCount, dim: true });
  lines.push(meter);
  return lines;
}

// What % the 5h limit reaches at reset if usage continues at the current rate. Returned only when it
// reaches 100%. Not shown until 10 minutes after the first observation, since the rate is unreliable before then
function projection(first, l, now) {
  const reset = Date.parse(l.resetsAt);
  if (!(reset > now) || now - first.at < 600_000) return null;
  const rate = (l.percentUsed - first.pct) / (now - first.at);
  if (!(rate > 0)) return null;
  const projected = Math.round(l.percentUsed + rate * (reset - now));
  return projected >= 100 ? projected : null;
}

// Drop segments from the end until the line fits
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

const EFFORT_COLOR = { low: "green", medium: "yellow", high: "cyan", xhigh: "magenta", max: "red" };

// Time left until reset (format: 3d17h / 4h25m / 12m)
function resetIn(iso) {
  if (!iso) return "";
  return span(Math.floor((Date.parse(iso) - Date.now()) / 1000));
}

// Elapsed time (same format; empty under a minute)
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

function count(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

function short(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

// Count full-width characters as two columns (repo and branch names may contain them)
function width(s) {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

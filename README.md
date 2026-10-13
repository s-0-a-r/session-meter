# session-meter

A Claude Code mod that records what happens in each session and shows a two-line band above the prompt.

```
opus-5-5 · medium · my-repo@main
ctx 79k/287k (28%) · 5h 14% (1h50m) · 7d 16% (16h40m) · last 25m · compact 0
```

The first line is the model, effort and repository. The second line shows context usage against the autocompact threshold (not the whole window), so you can see how close the next automatic compaction is. It also shows rate limit usage with time until reset, a projection when the 5-hour limit would run out before it resets, time since the last response, and the number of compactions in this session. `⚠ recording` appears if writing the records failed.

## What it records

Each session is written to `~/.claude/mod-metrics/<session-id>.jsonl`:

- compactions, with tokens before and after and the threshold at the time
- every model request (main loop and subagents) with input, output and cache tokens, and advisor calls
- subagent spawns, by type and model
- tool calls, with duration and whether they failed
- rate limits each time they cross a 10% line

The mod only observes. It never changes Claude Code's inputs or decisions, and a failure inside the mod falls back to Claude Code's normal behavior.

Recording stops at 3 MiB per session.

## /metrics

```
/metrics            summary of the current session
/metrics 7d         summary of all sessions in the last 7 days, by repository
/metrics prune 30d  delete record files not updated for 30 days
```

Nothing is deleted automatically. Run `prune` when you want to clean up.

## Install

Requires Claude Code 2.1.287 or later (mods are on by default from that version).

```sh
claude plugin marketplace add s-0-a-r/session-meter
claude plugin install session-meter@s0ar-mods
```

## Development

```sh
claude plugin validate --strict .
claude plugin test .
```

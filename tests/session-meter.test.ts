import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, model: 'claude-test' }
const DIR = '/home/test/.claude/mod-metrics'
const SID = '00000000-0000-0000-0000-000000000001'
const OTHER = '00000000-0000-0000-0000-000000000002'
const DAY = 86_400_000

type Files = Record<string, { text: string; mtimeMs?: number }>
// APIs to make fail. writeFailures is how many of the first writes fail
type Faults = { read?: boolean; readPaths?: string[]; list?: boolean; writeFailures?: number; usage?: boolean; noHome?: boolean }

// Stub every API session.start calls. files is a fake file system (path -> contents)
function stubSession(on: any, files: Files = {}, faults: Faults = {}) {
  const written: string[] = []
  const runs: string[][] = []
  mock.env(on, faults.noHome ? {} : { HOME: '/home/test' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const id = { value: SID }
  on('session.id', () => ({ value: id.value }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.repo', () => ({ value: { root: '/work/repo', remote: null, internal: false } }))
  const calls = { usage: 0, git: 0, invalidate: 0, logs: [] as string[], debug: [] as string[] }
  on('session.usage', () => {
    calls.usage++
    if (faults.usage) throw new Error('usage unavailable')
    return {
    value: { startedAt: 0, context: { tokens: 1000, window: 1000000, breakdown: { autoCompactThreshold: 320000, autocompactSource: 'env' } }, rateLimits: [] },
    }
  })
  const counts = { settingsRead: 0 }
  on('settings.read', () => {
    counts.settingsRead++
    return { value: { effortLevel: 'high' } }
  })
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv ?? e.command ?? e)
    if ((e.argv ?? [])[0] === 'git') calls.git++
    return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
  })
  on('fs.exists', ($: any, e: any) => ({ value: e.path === DIR ? Object.keys(files).length > 0 : e.path in files }))
  on('fs.read', ($: any, e: any) => {
    if (faults.read || faults.readPaths?.includes(e.path)) throw new Error('EACCES: permission denied')
    return { value: files[e.path]?.text ?? '' }
  })
  on('fs.list', ($: any, e: any) => {
    if (faults.list) throw new Error('EIO: i/o error')
    return {
    value: Object.entries(files)
      .filter(([p]) => p.startsWith(e.path + '/'))
      .map(([p, f]) => ({ name: p.slice(e.path.length + 1), kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs ?? Date.now(), isLink: false })),
    }
  })
  const writes: { path: string; text: string }[] = []
  let writeFailures = faults.writeFailures ?? 0
  on('fs.write', ($: any, e: any) => {
    if (writeFailures > 0) {
      writeFailures--
      throw new Error('ENOSPC: no space left on device')
    }
    written.push(e.text)
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => {
    if (e.to === 'debug') calls.debug.push(e.text)
    else calls.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => {
    calls.invalidate++
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  return { written, writes, runs, clock, id, counts, calls }
}

function lastRows(written: string[]) {
  return written.at(-1)!.trim().split('\n').map((l) => JSON.parse(l))
}

function jsonl(rows: object[]) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
}

async function start($: any) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

async function step($: any, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return s.value
}

function stubStep(on: any, usages: object[] = [USAGE]) {
  let i = 0
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    const usage = usages[Math.min(i++, usages.length - 1)]
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage, serverToolUses: [{ id: 's1', name: 'advisor', input: {}, startedAt: 0, endedAt: 1 }] }
  })
}

async function metrics($: any, args = '') {
  return (await $.command.run({ command: 'metrics', args })).text as string
}

test('a compaction writes its compact row without waiting for turn.complete', async ($, on) => {
  const { written } = stubSession(on)
  const MSGS = [{ role: 'user', text: 'hi', toolUses: [] }]
  on('session.compact', () => ({ messages: MSGS, tokensBefore: 290000, tokensAfter: 30000 }))
  await start($)
  await $.session.compact({ trigger: 'auto', messages: MSGS })

  expect(lastRows(written).find((r) => r.t === 'compact')).toMatchObject({ trigger: 'auto', tokens: 290000, after: 30000, threshold: 320000 })
})

test('turn.step passes its result through unchanged', async ($, on) => {
  stubSession(on)
  stubStep(on)
  await start($)
  const result = await step($)
  expect(result.answer).toBe('ok')
  expect(result.usage).toEqual(USAGE)
})

test('/metrics matches spawns and steps by agentId', async ($, on) => {
  stubSession(on)
  stubStep(on)
  on('agent.spawn', () => ({ model: 'claude-test', agentId: 'a1' }))
  await start($)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'find x', description: 'find', subagentType: 'Explore' })
  await step($, 'a1')
  await step($)

  const text = await metrics($)
  expect(text).toContain('Explore [test]: 1 spawn, 1k per spawn')
  expect(text).toContain('cache read 1k')
  expect(text).toContain('advisor: main 1 / subagents 1')
})

test('a reload writes a reload row instead of another start row', async ($, on) => {
  const { written } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start', repo: 'repo' }]) } })
  await start($)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })

  const rows = lastRows(written)
  expect(rows.filter((r) => r.t === 'start').length).toBe(1)
  expect(rows.at(-1)).toMatchObject({ t: 'reload' })
})

test('session.end records the reason and duration', async ($, on) => {
  const { written } = stubSession(on)
  await start($)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: SID })

  const end = lastRows(written).find((r) => r.t === 'end')
  expect(end).toMatchObject({ reason: 'prompt_input_exit' })
  expect(typeof end.durationMs).toBe('number')
})

test('tool.call passes its result through and records name, time, and failure', async ($, on) => {
  const { clock } = stubSession(on)
  on('tool.call', async ($: any, e: any) => {
    await clock.sleep(1500)
    return { ref: 1, result: {}, text: 'boom', isError: true }
  })
  await start($)
  const pending = $.tool.call({ tool: 'Bash', command: 'false' } as any)
  await clock.advance(1500)
  const r = await pending
  expect(r.text).toBe('boom')

  const text = await metrics($)
  expect(text).toContain('Bash: 1 call (1 failed), total 1.5s')
})

test('from the second request of a loop, cacheWrite above cacheRead counts as a rebuild', async ($, on) => {
  stubSession(on)
  stubStep(on, [
    { ...USAGE, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 },
    { ...USAGE, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 },
    { ...USAGE, cache_read_input_tokens: 100, cache_creation_input_tokens: 6000 },
  ])
  await start($)
  await step($)
  await step($)
  await step($)

  expect(await metrics($)).toContain('(1 rebuild)')
})

test('/metrics 7d counts only rows in the period, across other sessions', async ($, on) => {
  const now = Date.now()
  stubSession(on, {
    [DIR + '/' + OTHER + '.jsonl']: {
      text: jsonl([
        { at: now - 10 * DAY, t: 'step', in: 999, out: 0, cacheRead: 0, cacheWrite: 0 },
        { at: now - DAY, t: 'start', repo: 'other-repo' },
        { at: now - DAY, t: 'step', in: 7, out: 0, cacheRead: 0, cacheWrite: 0 },
      ]),
    },
    [DIR + '/notes.txt']: { text: 'ignore me' },
  })
  stubStep(on)
  await start($)
  await step($)

  const text = await metrics($, '7d')
  expect(text).toContain('2 sessions')
  expect(text).toContain('Main loop: 2 requests, in 17 /')
  expect(text).toContain('other-repo: 1 request')
})

test('/metrics prune deletes only old files by absolute path, and does nothing without days', async ($, on) => {
  const now = Date.now()
  const { runs } = stubSession(on, {
    [DIR + '/' + OTHER + '.jsonl']: { text: '{}\n', mtimeMs: now - 40 * DAY },
    [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }]), mtimeMs: now - 40 * DAY },
    [DIR + '/00000000-0000-0000-0000-000000000003.jsonl']: { text: '{}\n', mtimeMs: now - DAY },
  })
  await start($)
  const before = runs.length

  expect(await metrics($, 'prune')).toContain('Usage')
  expect(runs.length).toBe(before)

  expect(await metrics($, 'prune 30d')).toContain('Deleted 1 record file ')
  expect(runs.at(-1)).toEqual(['rm', '--', DIR + '/' + OTHER + '.jsonl'])
})

test('the start row is written at startup, before the first response', async ($, on) => {
  const { written } = stubSession(on)
  await start($)
  expect(lastRows(written).map((r) => r.t)).toEqual(['start'])
})

test('a reload takes effort from the last main-loop response', async ($, on) => {
  const { counts } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }, { at: 2, t: 'step', effort: 'max', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }]) } })
  await start($)
  expect(counts.settingsRead).toBe(0)
})

test('after /clear, rows go to the file for the new session id', async ($, on) => {
  const { writes, id } = stubSession(on)
  stubStep(on)
  await start($)
  id.value = OTHER
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  await step($)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })

  const old = writes.filter((w) => w.path.endsWith(SID + '.jsonl')).at(-1)!
  const fresh = writes.filter((w) => w.path.endsWith(OTHER + '.jsonl')).at(-1)!
  expect(old.text).toContain('"t":"end"')
  expect(old.text).not.toContain('"t":"step"')
  expect(fresh.text).toContain('"t":"start"')
  expect(fresh.text).toContain('"t":"step"')
})

test('writes one pace row when the 5h limit would pass 100% before reset at this rate', async ($, on) => {
  const { written, clock } = stubSession(on)
  on('session.measure', () => ({ changed: ['rateLimits'] }))
  const resetsAt = new Date(clock.now() + 4 * 3_600_000).toISOString()
  const measure = (pct: number) => $.session.measure({ context: { tokens: 1000, window: 1000000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }], changed: ['rateLimits'] } as any)
  await start($)
  await measure(10)
  await clock.advance(5 * 60_000)
  await measure(20)
  await clock.advance(15 * 60_000)
  await measure(30)
  await measure(31)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })

  const paces = lastRows(written).filter((r) => r.t === 'pace')
  expect(paces.length).toBe(1)
  expect(paces[0].projected).toBeGreaterThanOrEqual(100)
})

test('no pace row when usage is slow', async ($, on) => {
  const { written, clock } = stubSession(on)
  on('session.measure', () => ({ changed: ['rateLimits'] }))
  const resetsAt = new Date(clock.now() + 4 * 3_600_000).toISOString()
  const measure = (pct: number) => $.session.measure({ context: { tokens: 1000, window: 1000000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }], changed: ['rateLimits'] } as any)
  await start($)
  await measure(10)
  await clock.advance(20 * 60_000)
  await measure(11)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })

  expect(lastRows(written).some((r) => r.t === 'pace')).toBe(false)
})

test('/metrics 7d resolves repo names and agent types for sessions started before the period', async ($, on) => {
  const now = Date.now()
  stubSession(on, {
    [DIR + '/' + OTHER + '.jsonl']: {
      text: jsonl([
        { at: now - 10 * DAY, t: 'start', repo: 'old-repo' },
        { at: now - 10 * DAY, t: 'spawn', type: 'Plan', agentId: 'p1', model: 'claude-test' },
        { at: now - DAY, t: 'step', in: 5, out: 0, cacheRead: 0, cacheWrite: 0 },
        { at: now - DAY, t: 'step', agentId: 'p1', in: 3, out: 0, cacheRead: 0, cacheWrite: 0 },
      ]),
    },
  })
  await start($)
  const text = await metrics($, '7d')
  expect(text).toContain('old-repo: 1 request')
  expect(text).toContain('Plan [test]')
  expect(text).not.toContain('(unknown)')
})

test('when the record file cannot be read, writes to a different file instead of the original', async ($, on) => {
  const { writes, calls } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }]) } }, { read: true })
  await start($)
  expect(writes.some((w) => w.path === DIR + '/' + SID + '.jsonl')).toBe(false)
  expect(writes.at(-1)!.path).toMatch(new RegExp('^' + DIR + '/' + SID + '\\.\\d+\\.jsonl$'))
  expect(calls.logs.some((l) => l.includes('reading records'))).toBe(true)
})

test('broken rows survive a rewrite', async ($, on) => {
  const { written } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: '{"at":1,"t":"start"}\n{not json\n' } })
  await start($)
  expect(lastRows(written).find((r) => r.t === 'broken')).toMatchObject({ raw: '{not json' })
})

test('after a failed write, the next write includes the same rows', async ($, on) => {
  const { written } = stubSession(on, {}, { writeFailures: 1 })
  stubStep(on)
  await start($)
  expect(written.length).toBe(0)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  expect(lastRows(written).map((r) => r.t)).toEqual(['start'])
})

test('stops recording before 3 MiB and writes a single capped row', async ($, on) => {
  const { written } = stubSession(on)
  on('tool.call', () => ({ ref: 1, result: {}, text: '' }))
  await start($)
  const big = 'x'.repeat(200_000)
  for (let i = 0; i < 20; i++) await $.tool.call({ tool: 'mcp__' + big + i } as any)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  const rows = lastRows(written)
  expect(rows.filter((r) => r.t === 'capped').length).toBe(1)
  expect(written.at(-1)!.length).toBeLessThan(3 * 1024 * 1024)
})

test('/clear switches to the new file without calling git or usage', async ($, on) => {
  const { writes, id, calls } = stubSession(on, {}, {})
  await start($)
  const before = { usage: calls.usage, git: calls.git }
  id.value = OTHER
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  expect(calls.usage).toBe(before.usage)
  expect(calls.git).toBe(before.git)
  expect(writes.at(-1)!.path).toBe(DIR + '/' + OTHER + '.jsonl')
})

test('/clear switches to the new file even if the previous write failed', async ($, on) => {
  const { writes, id } = stubSession(on, {}, { writeFailures: 2 })
  await start($)
  id.value = OTHER
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  expect(writes.at(-1)!.path).toBe(DIR + '/' + OTHER + '.jsonl')
})

test('without usage, the start row is still written with the model name', async ($, on) => {
  const { written } = stubSession(on, {}, { usage: true })
  await start($)
  expect(lastRows(written)[0]).toMatchObject({ t: 'start', model: 'claude-test', repo: 'repo' })
})

test('writes nothing when HOME is not set', async ($, on) => {
  const { writes, calls } = stubSession(on, {}, { noHome: true })
  stubStep(on)
  await start($)
  await step($)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  expect(writes.length).toBe(0)
  expect(calls.logs.some((l) => l.includes('HOME'))).toBe(true)
})

test('two /clears still leave a single redraw timer', async ($, on) => {
  const { id, clock, calls } = stubSession(on)
  await start($)
  id.value = OTHER
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = '00000000-0000-0000-0000-000000000003'
  await $.session.end({ reason: 'clear', sessionId: OTHER, resume: OTHER })
  await clock.settle()
  const before = calls.invalidate
  await clock.advance(60_000)
  expect(calls.invalidate - before).toBe(1)
})

test('a failed write shows the failure count and unsaved rows in /metrics', async ($, on) => {
  stubSession(on, {}, { writeFailures: 1 })
  await start($)
  expect(await metrics($)).toMatch(/Recording: 1 failure \(last: writing records failed: [^)]*\), 1 row unsaved/)
})

test('/metrics shows OK when nothing failed', async ($, on) => {
  stubSession(on)
  await start($)
  expect(await metrics($)).toContain('Recording: OK')
})

test('the same failure goes to the transcript once, then to the debug log', async ($, on) => {
  const { calls } = stubSession(on, {}, { writeFailures: 3 })
  await start($)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  expect(calls.logs.filter((l) => l.includes('writing records failed')).length).toBe(1)
  expect(calls.debug.filter((l) => l.includes('writing records failed')).length).toBe(2)
})

test('period summary skips unreadable files and reports how many', async ($, on) => {
  const now = Date.now()
  const bad = DIR + '/00000000-0000-0000-0000-000000000003.jsonl'
  stubSession(on, {
    [DIR + '/' + OTHER + '.jsonl']: { text: jsonl([{ at: now - DAY, t: 'step', in: 7, out: 0, cacheRead: 0, cacheWrite: 0 }]) },
    [bad]: { text: '{}\n' },
  }, { readPaths: [bad] })
  await start($)
  const text = await metrics($, '7d')
  expect(text).toContain('Main loop: 1 request')
  expect(text).toContain('Unreadable record files: 1')
})

test('/metrics replies with the reason when it fails', async ($, on) => {
  stubSession(on, { [DIR + '/' + OTHER + '.jsonl']: { text: '{}\n' } }, { list: true })
  await start($)
  expect(await metrics($, '7d')).toContain('/metrics failed: ')
})

test('aborted responses are counted separately, not as requests or tokens', async ($, on) => {
  stubSession(on)
  let n = 0
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: n++ === 0 ? USAGE : null, serverToolUses: [] }
  })
  await start($)
  await step($)
  await step($)
  const text = await metrics($)
  expect(text).toContain('Main loop: 1 request (+1 aborted), in 10 /')
})

test('shows ? when tokens before compaction are unknown', async ($, on) => {
  stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }, { at: 2, t: 'compact', trigger: 'manual', tokens: null, after: 18000 }]) } })
  await start($)
  expect(await metrics($)).toContain('?→18k manual')
})

test('writes to the new file from the next response even if session.end still sees the old id', async ($, on) => {
  const { writes, id } = stubSession(on)
  stubStep(on)
  await start($)
  // On a real machine session.end still returns the old id; it changes by the next turn
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  await step($)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })

  const old = writes.filter((w) => w.path.endsWith(SID + '.jsonl')).at(-1)!
  const fresh = writes.filter((w) => w.path.endsWith(OTHER + '.jsonl')).at(-1)!
  expect(old.text).toContain('"t":"end"')
  expect(old.text).not.toContain('"t":"step"')
  expect(fresh.text).toContain('"t":"start"')
  expect(fresh.text).toContain('"t":"step"')
})

test('flushes the old file before switching, and records lost rows if that fails', async ($, on) => {
  // The writes at startup, in session.end, and before the switch all fail
  const { writes, id } = stubSession(on, {}, { writeFailures: 3 })
  await start($)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  const text = await metrics($)
  expect(writes.at(-1)!.path).toBe(DIR + '/' + OTHER + '.jsonl')
  expect(text).toContain("writing the previous session's records failed: lost 2 rows that could not be written")
})

test('if the write before switching succeeds, the old rows stay in the old file', async ($, on) => {
  const { writes, id } = stubSession(on, {}, { writeFailures: 2 })
  await start($)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  await metrics($)
  const old = writes.filter((w) => w.path.endsWith(SID + '.jsonl')).at(-1)!
  expect(old.text).toContain('"t":"end"')
})

test('while a switch is pending, tool rows go to the new file', async ($, on) => {
  const { writes, id } = stubSession(on)
  on('tool.call', () => ({ ref: 1, result: {}, text: 'ok', isError: false }))
  await start($)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  await $.tool.call({ tool: 'Bash', command: 'true' } as any)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  const old = writes.filter((w) => w.path.endsWith(SID + '.jsonl')).at(-1)!
  const fresh = writes.filter((w) => w.path.endsWith(OTHER + '.jsonl')).at(-1)!
  expect(old.text).not.toContain('"t":"tool"')
  expect(fresh.text).toContain('"t":"tool"')
})

test('after /clear, rate-limit lines already crossed are not written again', async ($, on) => {
  const { writes, id, clock } = stubSession(on)
  on('session.measure', () => ({ changed: ['rateLimits'] }))
  const resetsAt = new Date(clock.now() + 4 * 3_600_000).toISOString()
  const measure = (pct: number) => $.session.measure({ context: { tokens: 1000, window: 1000000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }], changed: ['rateLimits'] } as any)
  await start($)
  await measure(72)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  await measure(73)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  const fresh = writes.filter((w) => w.path.endsWith(OTHER + '.jsonl')).at(-1)!
  expect(fresh.text).not.toContain('"t":"ratelimit"')
})

test('null or number rows do not stop loading and are kept as broken rows', async ($, on) => {
  const { written } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }]) + 'null\n42\n' + jsonl([{ at: 2, t: 'step', in: 1, out: 1, cacheRead: 0, cacheWrite: 0 }]) } })
  await start($)
  const rows = lastRows(written)
  expect(rows.filter((r) => r.t === 'broken').map((r) => r.raw)).toEqual(['null', '42'])
  expect(rows.some((r) => r.t === 'step')).toBe(true)
})

// Render the band in the terminal and return its text
async function bandText($: any) {
  const ui = await $.ui.mount({ plugin: 'session-meter', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 200 } as any })
  const found = await ui.findAll({ type: 'Text' })
  return found.map((f: any) => f.text).join(' ')
}

test('band: shows the model name and ctx', async ($, on) => {
  stubSession(on)
  await start($)
  const text = await bandText($)
  expect(text).toContain('test')
  expect(text).toMatch(/ctx \d/)
})

test('band: shows ⚠ recording on failures even without a model name', async ($, on) => {
  stubSession(on, {}, { noHome: true })
  await start($)
  expect(await bandText($)).toContain('⚠ recording')
})

test('band: right after /clear, shows ctx ? until the next measurement', async ($, on) => {
  const { id } = stubSession(on)
  on('session.measure', () => ({ changed: ['context'] }))
  await start($)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  expect(await bandText($)).toMatch(/ctx \?\//)
  await $.session.measure({ context: { tokens: 1000, window: 1000000 }, rateLimits: [], changed: ['context'] } as any)
  expect(await bandText($)).toMatch(/ctx 1/)
})

const STATUSLINE = { options: { display: 'statusline' } }

// The status file is written without anyone waiting for it, so let it finish first
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
const statusWrites = (writes: { path: string; text: string }[]) => writes.filter((w) => w.path.endsWith('.status'))

test('statusline: the band draws nothing and the status file gets both lines', STATUSLINE, async ($, on) => {
  const { writes } = stubSession(on)
  // What the engine draws when the plugin passes: a marker, so any band text would show up beside it
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: ['engine default'] }))
  await start($)
  await settle()

  expect(await bandText($)).toBe('engine default')
  const status = statusWrites(writes).at(-1)!
  expect(status.path).toBe(DIR + '/' + SID + '.status')
  const lines = plain(status.text).split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe('test · high · repo@main')
  expect(lines[1]).toMatch(/^ctx 1k\/320k \(0%\) · compact 0$/)
  expect(status.text).toContain('\x1b[1mtest\x1b[0m')
})

test('statusline: a burst of changes ends with the latest state in the file', STATUSLINE, async ($, on) => {
  const { writes } = stubSession(on)
  on('session.measure', () => ({ changed: ['context'] }))
  await start($)
  for (const tokens of [5000, 6000, 7000, 160000]) {
    await $.session.measure({ context: { tokens, window: 1000000 }, rateLimits: [], changed: ['context'] } as any)
  }
  await settle()

  expect(plain(statusWrites(writes).at(-1)!.text)).toContain('ctx 160k/320k (50%)')
})

test('statusline: after /clear, the next write goes to the new session id', STATUSLINE, async ($, on) => {
  const { writes, id } = stubSession(on)
  on('session.measure', () => ({ changed: ['context'] }))
  await start($)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  await $.session.measure({ context: { tokens: 1000, window: 1000000 }, rateLimits: [], changed: ['context'] } as any)
  await settle()

  expect(statusWrites(writes).at(-1)!.path).toBe(DIR + '/' + OTHER + '.status')
})

test('statusline: a failed status write is counted and shown in /metrics', STATUSLINE, async ($, on) => {
  // The first write is the start row, the second is the status file
  stubSession(on, {}, { writeFailures: 2 })
  await start($)
  await settle()

  expect(await metrics($)).toContain('2 failures (last: writing the status file failed')
})

test('statusline: /metrics prune also deletes old status files, and /metrics 7d does not read them as records', STATUSLINE, async ($, on) => {
  const now = Date.now()
  const { runs } = stubSession(on, {
    [DIR + '/' + OTHER + '.status']: { text: 'ctx 1k/320k', mtimeMs: now - 40 * DAY },
    [DIR + '/00000000-0000-0000-0000-000000000003.status']: { text: 'ctx 1k/320k', mtimeMs: now - DAY },
    [DIR + '/' + SID + '.status']: { text: 'ctx 1k/320k', mtimeMs: now - 40 * DAY },
  })
  await start($)

  expect(await metrics($, '7d')).toContain('1 session)')
  expect(await metrics($, 'prune 30d')).toContain('Deleted 1 record file ')
  expect(runs.at(-1)).toEqual(['rm', '--', DIR + '/' + OTHER + '.status'])
})

test('band mode writes no status file', async ($, on) => {
  const { writes } = stubSession(on)
  on('session.measure', () => ({ changed: ['context'] }))
  await start($)
  await $.session.measure({ context: { tokens: 5000, window: 1000000 }, rateLimits: [], changed: ['context'] } as any)
  await settle()

  expect(statusWrites(writes)).toEqual([])
  expect(await bandText($)).toContain('test')
})

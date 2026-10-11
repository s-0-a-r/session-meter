import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, model: 'claude-test' }
const DIR = '/home/test/.claude/mod-metrics'
const SID = '00000000-0000-0000-0000-000000000001'
const OTHER = '00000000-0000-0000-0000-000000000002'
const DAY = 86_400_000

type Files = Record<string, { text: string; mtimeMs?: number }>

// session.start が呼ぶ API をまとめて差し替える。files は仮のファイルシステム（パス → 中身）
function stubSession(on: any, files: Files = {}) {
  const written: string[] = []
  const runs: string[][] = []
  mock.env(on, { HOME: '/home/test' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: SID }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.repo', () => ({ value: { root: '/work/repo', remote: null, internal: false } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1000, window: 1000000, breakdown: { autoCompactThreshold: 320000, autocompactSource: 'env' } }, rateLimits: [] },
  }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv ?? e.command ?? e)
    return { value: { exitCode: 0, stdout: 'main\n', stderr: '' } }
  })
  on('fs.exists', ($: any, e: any) => ({ value: e.path === DIR ? Object.keys(files).length > 0 : e.path in files }))
  on('fs.read', ($: any, e: any) => ({ value: files[e.path]?.text ?? '' }))
  on('fs.list', ($: any, e: any) => ({
    value: Object.entries(files)
      .filter(([p]) => p.startsWith(e.path + '/'))
      .map(([p, f]) => ({ name: p.slice(e.path.length + 1), kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs ?? Date.now(), isLink: false })),
  }))
  on('fs.write', ($: any, e: any) => {
    written.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  return { written, runs, clock }
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

test('圧縮すると、turn.complete を待たずに compact の行が書かれる', async ($, on) => {
  const { written } = stubSession(on)
  const MSGS = [{ role: 'user', text: 'hi', toolUses: [] }]
  on('session.compact', () => ({ messages: MSGS, tokensBefore: 290000, tokensAfter: 30000 }))
  await start($)
  await $.session.compact({ trigger: 'auto', messages: MSGS })

  expect(lastRows(written).find((r) => r.t === 'compact')).toMatchObject({ trigger: 'auto', tokens: 290000, after: 30000, threshold: 320000 })
})

test('turn.step の結果は変えずに通す', async ($, on) => {
  stubSession(on)
  stubStep(on)
  await start($)
  const result = await step($)
  expect(result.answer).toBe('ok')
  expect(result.usage).toEqual(USAGE)
})

test('spawn と step を agentId で突き合わせて /metrics に出す', async ($, on) => {
  stubSession(on)
  stubStep(on)
  on('agent.spawn', () => ({ model: 'claude-test', agentId: 'a1' }))
  await start($)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'find x', description: 'find', subagentType: 'Explore' })
  await step($, 'a1')
  await step($)

  const text = await metrics($)
  expect(text).toContain('Explore [test]: 起動 1 回, 1回あたり 1k')
  expect(text).toContain('cache read 1k')
  expect(text).toContain('advisor: メイン 1 回 / サブエージェント 1 回')
})

test('読み込み直しでは start を重ねず reload の行を書く', async ($, on) => {
  const { written } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start', repo: 'repo' }]) } })
  await start($)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })

  const rows = lastRows(written)
  expect(rows.filter((r) => r.t === 'start').length).toBe(1)
  expect(rows.at(-1)).toMatchObject({ t: 'reload' })
})

test('session.end で終了理由と長さを書く', async ($, on) => {
  const { written } = stubSession(on)
  await start($)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SID, resume: SID })

  const end = lastRows(written).find((r) => r.t === 'end')
  expect(end).toMatchObject({ reason: 'prompt_input_exit' })
  expect(typeof end.durationMs).toBe('number')
})

test('tool.call は結果を変えずに通し、名前・時間・失敗を記録する', async ($, on) => {
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
  expect(text).toContain('Bash: 1 回（失敗 1）, 合計 1.5s')
})

test('同じループの2回目以降で cacheWrite が cacheRead を上回ると、作り直しと数える', async ($, on) => {
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

  expect(await metrics($)).toContain('（作り直し 1 回）')
})

test('/metrics 7d は期間内の行だけを、ほかのセッションの記録と合わせて数える', async ($, on) => {
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
  expect(text).toContain('2 セッション')
  expect(text).toContain('メインループ: 2 リクエスト, in 17 /')
  expect(text).toContain('other-repo: 1 リクエスト')
})

test('/metrics prune は古いファイルだけを絶対パスで消し、日数がなければ何もしない', async ($, on) => {
  const now = Date.now()
  const { runs } = stubSession(on, {
    [DIR + '/' + OTHER + '.jsonl']: { text: '{}\n', mtimeMs: now - 40 * DAY },
    [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }]), mtimeMs: now - 40 * DAY },
    [DIR + '/00000000-0000-0000-0000-000000000003.jsonl']: { text: '{}\n', mtimeMs: now - DAY },
  })
  await start($)
  const before = runs.length

  expect(await metrics($, 'prune')).toContain('使い方')
  expect(runs.length).toBe(before)

  expect(await metrics($, 'prune 30d')).toContain('1 件')
  expect(runs.at(-1)).toEqual(['rm', '--', DIR + '/' + OTHER + '.jsonl'])
})

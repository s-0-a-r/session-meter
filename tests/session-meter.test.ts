import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, model: 'claude-test' }
const DIR = '/home/test/.claude/mod-metrics'
const SID = '00000000-0000-0000-0000-000000000001'
const OTHER = '00000000-0000-0000-0000-000000000002'
const DAY = 86_400_000

type Files = Record<string, { text: string; mtimeMs?: number }>
// 失敗させたい API。writeFailures は先頭から何回失敗させるか
type Faults = { read?: boolean; readPaths?: string[]; list?: boolean; writeFailures?: number; usage?: boolean; noHome?: boolean }

// session.start が呼ぶ API をまとめて差し替える。files は仮のファイルシステム（パス → 中身）
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

test('最初の応答より前でも、起動した時点で start 行が書き出される', async ($, on) => {
  const { written } = stubSession(on)
  await start($)
  expect(lastRows(written).map((r) => r.t)).toEqual(['start'])
})

test('読み込み直しでは、最後のメインの応答の effort を引き継ぐ', async ($, on) => {
  const { counts } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }, { at: 2, t: 'step', effort: 'max', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }]) } })
  await start($)
  expect(counts.settingsRead).toBe(0)
})

test('/clear のあとは、新しい session id のファイルに書く', async ($, on) => {
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

test('5h 枠がこの速さだとリセット前に 100% を超えるとき、pace の行を1回だけ書く', async ($, on) => {
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

test('ゆっくり使っているときは pace の行を書かない', async ($, on) => {
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

test('/metrics 7d は、期間より前に起動したセッションのリポジトリ名とエージェントの種類も引ける', async ($, on) => {
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
  expect(text).toContain('old-repo: 1 リクエスト')
  expect(text).toContain('Plan [test]')
  expect(text).not.toContain('(不明)')
})

test('記録ファイルが読めないと、元のファイルには書かず別名のファイルに書く', async ($, on) => {
  const { writes, calls } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }]) } }, { read: true })
  await start($)
  expect(writes.some((w) => w.path === DIR + '/' + SID + '.jsonl')).toBe(false)
  expect(writes.at(-1)!.path).toMatch(new RegExp('^' + DIR + '/' + SID + '\\.\\d+\\.jsonl$'))
  expect(calls.logs.some((l) => l.includes('記録の読み込み'))).toBe(true)
})

test('壊れた行は、書き直したあとも残る', async ($, on) => {
  const { written } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: '{"at":1,"t":"start"}\n{not json\n' } })
  await start($)
  expect(lastRows(written).find((r) => r.t === 'broken')).toMatchObject({ raw: '{not json' })
})

test('書き出しに失敗しても、次の書き出しで同じ行を書く', async ($, on) => {
  const { written } = stubSession(on, {}, { writeFailures: 1 })
  stubStep(on)
  await start($)
  expect(written.length).toBe(0)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  expect(lastRows(written).map((r) => r.t)).toEqual(['start'])
})

test('3 MiB を超える前に記録を打ち切り、capped の行を1つだけ書く', async ($, on) => {
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

test('/clear では git も usage も呼ばずに新しいファイルへ切り替える', async ($, on) => {
  const { writes, id, calls } = stubSession(on, {}, {})
  await start($)
  const before = { usage: calls.usage, git: calls.git }
  id.value = OTHER
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  expect(calls.usage).toBe(before.usage)
  expect(calls.git).toBe(before.git)
  expect(writes.at(-1)!.path).toBe(DIR + '/' + OTHER + '.jsonl')
})

test('/clear の前の書き出しが失敗しても、新しいファイルに切り替える', async ($, on) => {
  const { writes, id } = stubSession(on, {}, { writeFailures: 2 })
  await start($)
  id.value = OTHER
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  expect(writes.at(-1)!.path).toBe(DIR + '/' + OTHER + '.jsonl')
})

test('使用量が取れなくても、start 行を書き、帯のモデル名は入る', async ($, on) => {
  const { written } = stubSession(on, {}, { usage: true })
  await start($)
  expect(lastRows(written)[0]).toMatchObject({ t: 'start', model: 'claude-test', repo: 'repo' })
})

test('HOME が無いときは何も書かない', async ($, on) => {
  const { writes, calls } = stubSession(on, {}, { noHome: true })
  stubStep(on)
  await start($)
  await step($)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  expect(writes.length).toBe(0)
  expect(calls.logs.some((l) => l.includes('HOME'))).toBe(true)
})

test('/clear を2回しても、描き直しのタイマーは1つ', async ($, on) => {
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

test('書き出しに失敗すると /metrics に失敗の回数と未保存の行数が出る', async ($, on) => {
  stubSession(on, {}, { writeFailures: 1 })
  await start($)
  expect(await metrics($)).toMatch(/記録の状態: 失敗 1 回（最後: 書き出しの失敗: [^）]*）、未保存 1 行/)
})

test('失敗がなければ /metrics は「正常」', async ($, on) => {
  stubSession(on)
  await start($)
  expect(await metrics($)).toContain('記録の状態: 正常')
})

test('同じ失敗は transcript に1回だけ出し、2回目からは debug ログに回す', async ($, on) => {
  const { calls } = stubSession(on, {}, { writeFailures: 3 })
  await start($)
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, usage: null })
  expect(calls.logs.filter((l) => l.includes('書き出しの失敗')).length).toBe(1)
  expect(calls.debug.filter((l) => l.includes('書き出しの失敗')).length).toBe(2)
})

test('期間集計で読めないファイルがあっても、残りを集計して件数を出す', async ($, on) => {
  const now = Date.now()
  const bad = DIR + '/00000000-0000-0000-0000-000000000003.jsonl'
  stubSession(on, {
    [DIR + '/' + OTHER + '.jsonl']: { text: jsonl([{ at: now - DAY, t: 'step', in: 7, out: 0, cacheRead: 0, cacheWrite: 0 }]) },
    [bad]: { text: '{}\n' },
  }, { readPaths: [bad] })
  await start($)
  const text = await metrics($, '7d')
  expect(text).toContain('メインループ: 1 リクエスト')
  expect(text).toContain('読めなかった記録ファイル: 1 件')
})

test('/metrics の処理が失敗しても、理由を答える', async ($, on) => {
  stubSession(on, { [DIR + '/' + OTHER + '.jsonl']: { text: '{}\n' } }, { list: true })
  await start($)
  expect(await metrics($, '7d')).toContain('/metrics に失敗しました: ')
})

test('中断した応答はリクエスト数とトークンに入れず、中断の回数として出す', async ($, on) => {
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
  expect(text).toContain('メインループ: 1 リクエスト（ほかに中断 1 回）, in 10 /')
})

test('圧縮前のトークン数が取れなかったときは ? と出す', async ($, on) => {
  stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }, { at: 2, t: 'compact', trigger: 'manual', tokens: null, after: 18000 }]) } })
  await start($)
  expect(await metrics($)).toContain('?→18k manual')
})

test('session.end の時点で id がまだ古くても、次の応答から新しいファイルに書く', async ($, on) => {
  const { writes, id } = stubSession(on)
  stubStep(on)
  await start($)
  // 実機では session.end の中ではまだ古い id が返り、次のターンまでに変わる
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

test('切り替えの前に前のファイルへ書き出し、それでも書けなければ失った行数を残す', async ($, on) => {
  // 起動時・session.end・切り替え前の3回の書き出しが失敗する
  const { writes, id } = stubSession(on, {}, { writeFailures: 3 })
  await start($)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  const text = await metrics($)
  expect(writes.at(-1)!.path).toBe(DIR + '/' + OTHER + '.jsonl')
  expect(text).toContain('前のセッションの記録の失敗: 2 行を書き出せずに失いました')
})

test('切り替え前に1回書ければ、前のセッションの行は前のファイルに残る', async ($, on) => {
  const { writes, id } = stubSession(on, {}, { writeFailures: 2 })
  await start($)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: SID })
  id.value = OTHER
  await metrics($)
  const old = writes.filter((w) => w.path.endsWith(SID + '.jsonl')).at(-1)!
  expect(old.text).toContain('"t":"end"')
})

test('切り替え待ちのときは、ツールの記録も新しいファイルに入る', async ($, on) => {
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

test('/clear のあと、すでに越えた利用枠の線を新しいファイルに書き直さない', async ($, on) => {
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

test('null や数値の行があっても読み込みを止めず、壊れた行として残す', async ($, on) => {
  const { written } = stubSession(on, { [DIR + '/' + SID + '.jsonl']: { text: jsonl([{ at: 1, t: 'start' }]) + 'null\n42\n' + jsonl([{ at: 2, t: 'step', in: 1, out: 1, cacheRead: 0, cacheWrite: 0 }]) } })
  await start($)
  const rows = lastRows(written)
  expect(rows.filter((r) => r.t === 'broken').map((r) => r.raw)).toEqual(['null', '42'])
  expect(rows.some((r) => r.t === 'step')).toBe(true)
})

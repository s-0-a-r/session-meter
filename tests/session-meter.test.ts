import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, model: 'claude-test' }

// session.start が呼ぶ API をまとめて差し替え、書き込まれた内容を返す
function stubSession(on: any) {
  const written: string[] = []
  mock.env(on, { HOME: '/home/test' })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'sess1' }))
  on('session.model', () => ({ value: 'claude-test' }))
  on('session.repo', () => ({ value: { root: '/work/repo', remote: null, internal: false } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1000, window: 1000000, breakdown: { autoCompactThreshold: 320000, autocompactSource: 'env' } }, rateLimits: [] },
  }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '' } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($: any, e: any) => {
    written.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  return written
}

async function step($: any, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
  return s.value
}

function stubStep(on: any) {
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: USAGE, serverToolUses: [{ id: 's1', name: 'advisor', input: {}, startedAt: 0, endedAt: 1 }] }
  })
}

test('圧縮すると compact の行が書かれる', async ($, on) => {
  const written = stubSession(on)
  const MSGS = [{ role: 'user', text: 'hi', toolUses: [] }]
  on('session.compact', () => ({ messages: MSGS, tokensBefore: 290000, tokensAfter: 30000 }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // turn.complete を待たずに、圧縮の hook の中で書き出されること
  await $.session.compact({ trigger: 'auto', messages: MSGS })

  const rows = written.at(-1)!.trim().split('\n').map((l) => JSON.parse(l))
  expect(rows.find((r) => r.t === 'compact')).toMatchObject({ trigger: 'auto', tokens: 290000, after: 30000, threshold: 320000 })
})

test('turn.step の結果は変えずに通す', async ($, on) => {
  stubSession(on)
  stubStep(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const result = await step($)
  expect(result.answer).toBe('ok')
  expect(result.usage).toEqual(USAGE)
})

test('spawn と step を agentId で突き合わせて /metrics に出す', async ($, on) => {
  stubSession(on)
  stubStep(on)
  on('agent.spawn', () => ({ model: 'claude-test', agentId: 'a1' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'find x', description: 'find', subagentType: 'Explore' })
  await step($, 'a1')
  await step($)

  const answer = await $.command.run({ command: 'metrics', args: '' })
  expect(answer.text).toContain('Explore: 起動 1 回')
  expect(answer.text).toContain('cache read 1k')
  expect(answer.text).toContain('advisor: メイン 1 回 / サブエージェント 1 回')
})

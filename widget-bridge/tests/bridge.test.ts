import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Snapshot } from '../types'

const CODE = 'abcdefghijklmnop1234'

type Sent = { url: string; method?: string; auth?: string; body: Snapshot }

// The engine beneath the mod, and a widget that records what reaches it and
// answers `reply()` (or is not running at all when `down` is set).
function engine(on: On, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, stored)
  const sent: Sent[] = []
  const world = { down: false, reply: () => '{}' as string, aborted: [] as string[], hold: null as Promise<void> | null }
  on('session.start', () => ({ cwd: '/home/me/projects/shop' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 20_000, window: 200_000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }], cost: { usd: 0.4 } },
  }))
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.abort', (_$, e) => {
    world.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash' && world.hold) await world.hold
    return { result: 'ok', text: e.tool === 'TaskCreate' ? 'Task #4 created successfully' : 'ok' } as never
  })
  on('http.fetch', (_$, e) => {
    const x = e as { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }
    if (world.down) throw new Error('ECONNREFUSED')
    sent.push({ url: x.url, method: x.init?.method, auth: x.init?.headers?.authorization, body: JSON.parse(x.init?.body ?? '{}') })
    return { value: { status: 200, ok: true, headers: {}, text: world.reply() } }
  })
  return { clock, sent, world }
}

const start = ($: Engine) => $.session.start({ source: 'startup', cwd: '/home/me/projects/shop', sessionId: 'sess-1' } as never)

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'widget', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const lastBody = (sent: Sent[]) => sent[sent.length - 1]!.body

test('unpaired, nothing leaves the session', async ($, on) => {
  const { clock, sent } = engine(on)
  await start($)
  await $.turn.start({ text: 'build the cart', turnId: 't1' })
  await clock.advance(10_000)
  expect(sent.length).toBe(0)
  expect((await run($, '')).text).toMatch(/Not paired/)
})

test('pairing sends the session to 127.0.0.1 with the code', async ($, on) => {
  const { sent } = engine(on)
  await start($)
  expect((await run($, 'pair nope')).text).toMatch(/not a pairing code/)
  expect((await run($, `pair ${CODE}`)).text).toMatch(/Paired/)
  expect(sent[0]!.url).toBe('http://127.0.0.1:47615/v1/sessions')
  expect(sent[0]!.method).toBe('POST')
  expect(sent[0]!.auth).toBe(`Bearer ${CODE}`)
  expect(lastBody(sent)).toMatchObject({ id: 'sess-1', project: 'shop', status: 'idle', ctx: 10 })
  // The code is kept for the next session, never in the readable state.
  expect(JSON.stringify(lastBody(sent))).not.toContain(CODE)
})

test('a paired session reports what runs, the task list and how it ended', async ($, on) => {
  const { clock, sent, world } = engine(on, { link: { token: CODE, port: 47615, isOn: true } })
  await start($)
  await $.turn.start({ text: 'build   the\ncart page', turnId: 't1' })
  await clock.advance(500)
  expect(lastBody(sent)).toMatchObject({ status: 'running', turnId: 't1', prompt: 'build the cart page' })

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Model', status: 'completed', activeForm: 'Writing the model' },
      { content: 'Page', status: 'in_progress', activeForm: 'Building the page' },
      { content: 'Tests', status: 'pending', activeForm: 'Testing' },
    ],
  } as never)
  await clock.advance(500)
  expect(lastBody(sent).todos).toMatchObject({ done: 1, total: 3, current: 'Building the page' })

  // While a tool runs, the beat carries it.
  let release = () => {}
  world.hold = new Promise(r => (release = r))
  const call = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' } as never)
  await clock.advance(3000)
  expect(lastBody(sent).tool).toMatchObject({ name: 'Bash', label: 'Run the tests' })
  release()
  await call

  await $.turn.complete({ answer: 'done', durationMs: 42_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(500)
  expect(lastBody(sent)).toMatchObject({ status: 'idle', last: { status: 'ok', ms: 42_000 } })
  expect(lastBody(sent).tool).toBeUndefined()
})

test('TaskCreate and TaskUpdate count as the task list', async ($, on) => {
  const { clock, sent } = engine(on, { link: { token: CODE, port: 47615, isOn: true } })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write the API' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'in_progress', activeForm: 'Writing the API' } as never)
  await clock.advance(500)
  expect(lastBody(sent).todos).toMatchObject({ done: 0, total: 1, current: 'Writing the API' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'completed' } as never)
  await clock.advance(500)
  expect(lastBody(sent).todos).toMatchObject({ done: 1, total: 1 })
})

test('the widget Stop button stops only the turn it saw', async ($, on) => {
  const { clock, world } = engine(on, { link: { token: CODE, port: 47615, isOn: true } })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  world.reply = () => JSON.stringify({ commands: [{ kind: 'stop', turnId: 'old' }, { kind: 'rm -rf', turnId: 't1' }] })
  await clock.advance(3000)
  expect(world.aborted).toEqual([])
  world.reply = () => JSON.stringify({ commands: [{ kind: 'stop', turnId: 't1' }] })
  await clock.advance(3000)
  expect(world.aborted).toEqual(['t1'])
})

test('a widget that is not running is retried slowly, and /widget says so', async ($, on) => {
  const { clock, sent, world } = engine(on, { link: { token: CODE, port: 47615, isOn: true } })
  world.down = true
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(500)
  expect((await run($, '')).text).toMatch(/not running/)
  world.down = false
  await clock.advance(9000)
  expect(sent.length).toBe(0)
  await clock.advance(30_000)
  expect(sent.length).toBeGreaterThan(0)
})

test('/widget off, port and unpair', async ($, on) => {
  const { clock, sent } = engine(on, { link: { token: CODE, port: 47615, isOn: true } })
  await start($)
  expect((await run($, 'port 80')).text).toMatch(/1024 to 65535/)
  await run($, 'port 50000')
  expect(sent[sent.length - 1]!.url).toBe('http://127.0.0.1:50000/v1/sessions')
  await run($, 'off')
  const n = sent.length
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(10_000)
  expect(sent.length).toBe(n)
  await run($, 'on')
  expect(sent.length).toBe(n + 1)
  expect((await run($, 'unpair')).text).toMatch(/Unpaired/)
  await clock.advance(20_000)
  expect(sent.length).toBe(n + 1)
})

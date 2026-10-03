import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'context-gauge',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type Measure = ReturnType<typeof measure>

const measure = (tokens: number, fiveHour: number) => ({
  context: { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
  rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour }],
  cost: { usd: 1.84 },
  changed: ['context', 'rateLimits', 'cost'] as ('context' | 'rateLimits' | 'cost')[],
})

// Toasts the plugin showed, newest last.
const toasts: string[] = []

// What the engine last measured; `session.usage` answers the same figures.
let last: Measure = measure(0, 0)

// The engine beneath the plugin: clock, usage figures, measurement, turns.
function engine(on: On, onAbort: (turnId: string) => void = () => {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.usage', () => ({
    value: { startedAt: 0, context: last.context, rateLimits: last.rateLimits, cost: last.cost },
  }))
  on('session.measure', (_$, e) => ({ changed: [...e.changed] }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.abort', (_$, e) => {
    onAbort(e.turnId)
    return { value: undefined }
  })
  return clock
}

// The text a drawing shows: its Text elements, or its Svg's alt where it draws one.
async function shown(ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const svgs = (await ui.findAll({ type: 'Svg' })).map(t => String(t.props.alt))
  return [...texts, ...svgs].join(' | ')
}

async function measured($: Engine, m: Measure) {
  last = m
  await $.session.measure(m)
}

test('band shows context and 5h, and turns red near auto-compact', async ($, on) => {
  engine(on)
  await measured($, measure(60_000, 42))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await shown(ui)).toMatch(/30%/)
    expect(await shown(ui)).toMatch(/42%/)
    expect(await shown(ui)).not.toMatch(/compacts soon/)
    await ui.unmount()
  }
  expect(await (await $.ui.mount({ ...BAND, surface: 'desktop' })).find({ type: 'Svg' })).toBeDefined()
  await measured($, measure(190_000, 42))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await shown(ui)).toMatch(/compacts soon/)
    await ui.unmount()
  }
})

test('a running turn shows a Stop button that aborts it', async ($, on) => {
  let aborted = ''
  engine(on, id => (aborted = id))
  await measured($, measure(60_000, 10))
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.press({ key: 'stop' })
  expect(aborted).toBe('t1')
  await ui.unmount()
})

test('on mobile the /gauge output row is the live gauge', async ($, on) => {
  engine(on)
  await measured($, measure(60_000, 42))
  const row = {
    plugin: 'context-gauge',
    component: 'CommandOutput',
    props: { command: 'gauge', args: '', text: 'Context gauge (live).', isErrored: false },
  } as const
  const ui = await $.ui.mount({ ...row, surface: 'mobile' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await shown(ui)).toMatch(/context 30%.*5 hour 42%/)
  await measured($, measure(120_000, 55))
  expect(await shown(ui)).toMatch(/context 60%.*5 hour 55%/)
  await ui.unmount()
})

test('the side pane draws and folds', async ($, on) => {
  engine(on)
  await measured($, measure(60_000, 42))
  const pane = {
    plugin: 'context-gauge',
    component: 'Pane',
    requestId: 'gauge',
    props: { title: 'Gauge', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane, surface })
    expect(await shown(ui)).toMatch(/42%/)
    expect(await ui.find({ type: 'Text', text: /this session/ })).toBeDefined()
    await ui.press({ key: 'fold' })
    expect(await ui.find({ type: 'Text', text: /this session/ })).toBeUndefined()
    await ui.press({ key: 'fold' })
    await ui.unmount()
  }
})

test('/gauge answers a text snapshot for clients that draw text', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  await measured($, measure(60_000, 42))
  const r = await $.command.run({
    command: 'gauge',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(r.text).toMatch(/🟢 CONTEXT .* 30%  60k \/ 200k/)
  expect(r.text).toMatch(/🟢 5 HOUR .* 42%/)
  expect(r.text).toMatch(/clients: terminal/)
})

test('with no client drawing, a gauge line goes under each answer', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: [] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await measured($, measure(60_000, 42))
  await $.turn.start({ text: 'go', turnId: 't2' })
  const r = await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(r.text).toBe('🟢 ctx 30%  ·  🟢 5h 42%  ·  $1.84  ·  ⏱ 5s')
})

test('with a terminal attached, the answer is left alone', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await measured($, measure(60_000, 42))
  await $.turn.start({ text: 'go', turnId: 't3' })
  const r = await $.turn.complete({ answer: 'done', durationMs: 5000, isAborted: false, turnId: 't3', reason: 'answer' })
  expect(r.text).toBe('done')
})

test('auto wrap-up waits for a running task, then fires once', async ($, on) => {
  const clock = engine(on)
  toasts.length = 0
  const sent = () => toasts.filter(t => /wrap-up prompt (not )?sent/.test(t)).length
  await measured($, measure(60_000, 10))
  await $.command.run({ command: 'gauge', args: 'wrap on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  // Idle past the threshold: nothing arms.
  await measured($, measure(60_000, 95))
  await clock.advance(15_000)
  expect(toasts.some(t => /wrap-up prompt in/.test(t))).toBe(false)

  // A task starts: the countdown runs, then the wrap-up is sent into the turn.
  // (The test kit stands in for no session.append, so it reports "not sent".)
  await $.turn.start({ text: 'go', turnId: 't4' })
  expect(toasts.some(t => /5h 95%: wrap-up prompt in 10s/.test(t))).toBe(true)
  await clock.advance(11_000)
  expect(sent()).toBe(1)

  // Once per limit window.
  await $.turn.start({ text: 'again', turnId: 't5' })
  await clock.advance(11_000)
  expect(sent()).toBe(1)
})

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'gauge', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

test('the settings page sets each wrap-up rule and the /compact rule', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: [] }))
  await measured($, measure(60_000, 10))
  const row = {
    plugin: 'context-gauge',
    component: 'CommandOutput',
    props: { command: 'gauge', args: 'settings', text: '', isErrored: false },
  } as const
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...row, surface })
    expect(await ui.find({ key: 'wrap5h-toggle' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...row, surface: 'desktop' })
  await ui.press({ key: 'wrap5h-toggle' })
  await ui.press({ key: 'wrap5h-up' })
  await ui.press({ key: 'wrap7d-down' })
  await ui.press({ key: 'compact-mode' })
  await ui.press({ key: 'compact-down' })
  await ui.unmount()
  const text = (await run($, 'settings')).text
  expect(text).toMatch(/5-hour limit   at 95%/)
  expect(text).toMatch(/weekly limit   off/)
  expect(text).toMatch(/\/compact       auto at 65%/)
})

test('/gauge wrap and /gauge compact set the rules by command', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: [] }))
  expect((await run($, 'wrap 7d 92')).text).toBe('Wrap-up: 5h off, 7d at 92%.')
  expect((await run($, 'wrap 5h on')).text).toBe('Wrap-up: 5h at 90%, 7d at 92%.')
  expect((await run($, 'compact 80')).text).toBe('/compact rule: remind at 80%.')
  expect((await run($, 'compact off')).text).toBe('/compact rule: off.')
})

test('the /compact rule reminds once when idle past it', async ($, on) => {
  engine(on)
  toasts.length = 0
  await run($, 'compact 70')
  await measured($, measure(150_000, 10))
  await measured($, measure(152_000, 10))
  expect(toasts.filter(t => /Context 75%: a good point to \/compact/.test(t))).toHaveLength(1)
})

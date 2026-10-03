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

// The /context breakdown session.usage answers, when a test sets one.
let breakdown: unknown = undefined

// Toasts the plugin showed, newest last.
const toasts: string[] = []

// What the engine last measured; `session.usage` answers the same figures.
let last: Measure = measure(0, 0)

// The engine beneath the plugin: clock, usage figures, measurement, turns.
function engine(on: On, onAbort: (turnId: string) => void = () => {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { ...last.context, breakdown: breakdown as never },
      rateLimits: last.rateLimits,
      cost: last.cost,
    },
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
  expect(await shown(ui)).toMatch(/context 30%.*5h 42%/)
  await measured($, measure(120_000, 55))
  expect(await shown(ui)).toMatch(/context 60%.*5h 55%/)
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

test('display style and text size are set from the settings page', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: [] }))
  await measured($, measure(60_000, 42))
  const row = {
    plugin: 'context-gauge',
    component: 'CommandOutput',
    props: { command: 'gauge', args: 'settings', text: '', isErrored: false },
  } as const
  const svgOf = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const source = String((await ui.find({ type: 'Svg' }))?.props.source)
    await ui.unmount()
    return source
  }
  const classic = await svgOf()
  expect(classic).toMatch(/>Context</)
  expect(classic).toMatch(/scale\(1\.18\)/)
  const ui = await $.ui.mount({ ...row, surface: 'desktop' })
  await ui.press({ key: 'tab-display' })
  await ui.press({ key: 'look-style' })
  await ui.press({ key: 'look-size-up' })
  await ui.unmount()
  const minimal = await svgOf()
  expect(minimal).toMatch(/>CONTEXT</)
  expect(minimal).toMatch(/scale\(1\.36\)/)
  expect((await run($, 'settings')).text).toMatch(/DISPLAY  minimal, text L/)
  expect((await run($, 'look classic')).text).toBe('Display style: classic.')
  expect((await run($, 'size s')).text).toBe('Text size: S.')
})

test('the Terminal look draws the original text bars on desktop too', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: [] }))
  await measured($, measure(60_000, 42))
  expect((await run($, 'look terminal')).text).toBe('Display style: terminal.')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '◆ ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▰▰' })).toBeDefined()
  expect(await shown(ui)).toMatch(/42%/)
  await ui.unmount()
})

test('the pane lists the context breakdown with numbers and recent turns as text', async ($, on) => {
  engine(on)
  breakdown = {
    categories: [
      { name: 'Messages', tokens: 120_000 },
      { name: 'System prompt', tokens: 8_000 },
      { name: 'Free space', tokens: 500_000 },
    ],
    autoCompactThreshold: 190_000,
    isAutoCompactEnabled: true,
  }
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await measured($, measure(60_000, 42))
  await $.turn.start({ text: 'go', turnId: 't9' })
  await $.turn.complete({ answer: 'ok', durationMs: 3000, isAborted: false, turnId: 't9', reason: 'answer' })
  const pane = {
    plugin: 'context-gauge',
    component: 'Pane',
    requestId: 'gauge',
    props: { title: 'Gauge', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('|')
  breakdown = undefined
  expect(texts).toMatch(/Messages  \|120k/)
  expect(texts).toMatch(/System prompt  \|8k/)
  expect(texts).not.toMatch(/Free space/)
  expect(texts).toMatch(/● \|3s/)
  expect(texts).not.toMatch(/[▁▂▃▄▅▆▇█]/)
  await ui.unmount()
})

// Commands the plugin ran, as `/name args`; each answers with a line of text.
function commands(on: On) {
  const ran: string[] = []
  on('command.run', (_$, e) => {
    ran.push(`/${e.command} ${e.args}`.trim())
    return { text: e.command === 'fast' ? 'Fast mode ON' : `ran ${e.command}` }
  })
  return ran
}

test('the slider switches model and effort, and keeps Fable locked without Max', async ($, on) => {
  const clock = engine(on)
  const ran = commands(on)
  toasts.length = 0
  on('session.surfaces', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  await measured($, measure(60_000, 10))

  // Desktop draws the draggable Client; a release on position 3 switches.
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const slider = await ui.find({ type: 'Client' })
  expect(String(slider?.props.module)).toMatch(/slider\.tsx$/)
  expect((slider?.props.props as { labels: string[] }).labels).toEqual(['Sonnet low', 'Sonnet high', 'Opus med', 'Opus xhigh', 'Fable high'])
  await ui.unmount()

  await run($, 'model 3')
  await clock.advance(1)
  expect(ran).toEqual(['/model opus', '/effort medium'])

  await run($, 'model 5')
  await clock.advance(1)
  expect(ran).toHaveLength(2)
  expect(toasts.some(t => /Fable high is for Max plans/.test(t))).toBe(true)

  await run($, 'max on')
  await run($, 'model 5')
  await clock.advance(1)
  expect(ran.slice(2)).toEqual(['/model fable', '/effort high'])

  await run($, 'fast')
  await clock.advance(1)
  expect(ran[4]).toBe('/fast')
  expect(toasts.some(t => /Fast mode ON/.test(t))).toBe(true)
})

test('the slider can be hidden, and mobile gets buttons in the /gauge row', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: [] }))
  await measured($, measure(60_000, 10))
  const row = {
    plugin: 'context-gauge',
    component: 'CommandOutput',
    props: { command: 'gauge', args: '', text: '', isErrored: false },
  } as const
  const phone = await $.ui.mount({ ...row, surface: 'mobile' })
  expect(await phone.find({ key: 'model-0' })).toBeDefined()
  await phone.unmount()
  await run($, 'models off')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Client' })).toBeUndefined()
  await band.unmount()
})

test('each prompt becomes a timeline line, colored by how its turn ended', async ($, on) => {
  engine(on)
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface places panes' } }))
  await measured($, measure(60_000, 10))

  await $.turn.start({ text: 'fix the band layout', turnId: 'a' })
  await $.turn.complete({ answer: 'done', durationMs: 4000, isAborted: false, turnId: 'a', reason: 'answer' })
  await $.turn.start({ text: 'run the tests', turnId: 'b' })
  await $.turn.complete({ answer: '', durationMs: 2000, isAborted: true, turnId: 'b', reason: 'aborted' })
  await $.turn.start({ text: 'deploy', turnId: 'c' })
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'c', reason: 'error' })

  const text = (await run($, 'timeline')).text
  expect(text).toMatch(/🔴 .* deploy/)
  expect(text).toMatch(/🟡 .* run the tests/)
  expect(text).toMatch(/🟢 .* fix the band layout/)

  const pane = {
    plugin: 'context-gauge',
    component: 'Pane',
    requestId: 'gauge-timeline',
    props: { title: 'Timeline', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  const ui = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await ui.find({ key: 'tl-turn-a' })).toBeDefined()
  expect((await ui.find({ key: 'tl-turn-b' }))?.text).toBe('run the tests')
  await ui.unmount()
})

test('dragging the slider across positions switches on release', async ($, on) => {
  const clock = engine(on)
  const ran = commands(on)
  on('session.surfaces', () => ({ value: [] }))
  await measured($, measure(60_000, 10))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.resize({ columns: 70, rows: 1 })
  // Five positions over 70 cells: 14 each. Press on 1, drag to 4, let go.
  await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 45, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 45, y: 0, button: 'left' })
  await clock.advance(1)
  expect(ran).toEqual(['/model opus', '/effort xhigh'])
  await ui.unmount()
})

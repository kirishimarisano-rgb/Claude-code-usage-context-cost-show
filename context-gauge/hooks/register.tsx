import { atom, read, update } from 'claude-code'
import type {
  ClientProps,
  ElementConstructor,
  InputProps,
  EngineInterface,
  Register,
  RenderChildren,
  RenderInput,
  SessionRateLimit,
  SvgProps,
  Timer,
} from 'claude-code'

import { alt, PALETTE, pill, readings, stack, strip } from './svg'
import type {
  CompactMode,
  Current,
  EffortName,
  Entry,
  FooterMode,
  GaugeSettings,
  Limit,
  Live,
  Look,
  LookStyle,
  Meter,
  ModelPrefs,
  Phase,
  SettingsTab,
  Slot,
  ToolRow,
  TurnRow,
  WrapRule,
} from '../types'

const PANE = 'gauge'
const SETTINGS_PANE = 'gauge-settings'
const TIMELINE_PANE = 'gauge-timeline'
const PICKER_PANE = 'gauge-model'
const YSK = 'cc-plugin-you-should-know@builtin'

const DEFAULTS: GaugeSettings = {
  wrap5h: { isOn: false, at: 90 },
  wrap7d: { isOn: false, at: 95 },
  compact: { mode: 'remind', at: 70 },
  footer: 'auto',
  look: { style: 'classic', size: 'm' },
  models: {
    isShown: true,
    hasMax: false,
    slots: [
      { model: 'sonnet', effort: 'low' },
      { model: 'sonnet', effort: 'high' },
      { model: 'opus', effort: 'medium' },
      { model: 'opus', effort: 'xhigh' },
      { model: 'fable', effort: 'high' },
    ],
  },
  timeline: { isAiSummary: false, isMarked: true, isStrip: true },
}

const meter = atom({ plugin: 'context-gauge', key: 'meter' } as const, null)
const live = atom({ plugin: 'context-gauge', key: 'live' } as const, null)
const history = atom({ plugin: 'context-gauge', key: 'history' } as const, [])
const isCollapsed = atom({ plugin: 'context-gauge', key: 'isCollapsed' } as const, false)
const settings = atom({ plugin: 'context-gauge', key: 'settings' } as const, DEFAULTS)
const wrap = atom({ plugin: 'context-gauge', key: 'wrap' } as const, { pending: null, fired: [] as string[] })
const tick = atom({ plugin: 'context-gauge', key: 'tick' } as const, 0)
// The context percent the /compact rule last acted at; cleared once the
// context drops below the rule again (after a compaction).
const compactAt = atom({ plugin: 'context-gauge', key: 'compactAt' } as const, null as number | null)
const current = atom({ plugin: 'context-gauge', key: 'current' } as const, {
  slot: null,
  fast: null,
  styles: [],
  youShouldKnow: null,
} as Current)
const timeline = atom({ plugin: 'context-gauge', key: 'timeline' } as const, [] as Entry[])
const settingsTab = atom({ plugin: 'context-gauge', key: 'settingsTab' } as const, 'usage' as SettingsTab)
const isPickerOpen = atom({ plugin: 'context-gauge', key: 'isPickerOpen' } as const, false)

const WRAP_DELAY_MS = 10_000
const NOTIFY_AFTER_MS = 20_000
const WRAP_PROMPT = [
  '[context-gauge] The usage limit is almost reached.',
  'Stop starting new work now. Finish only the step in progress, then wrap up:',
  '1. Leave the code in a working state; save or commit what is done if the task allows it.',
  '2. Write a short handoff: what was done, what is left, and the exact next step.',
  'Keep it brief.',
].join('\n')

// The text palette follows the chosen look, in the same tones the SVG meters use.
const paletteFor = (style: LookStyle) => ({
  ...PALETTE[style],
  accent: style === 'minimal' ? '#a39bd6' : '#c96442',
  rule: '#4a4d55',
})
let C = paletteFor('classic')

// Read the settings while drawing (so a change redraws) and adopt their palette.
async function lookOf($: EngineInterface) {
  const s = await read($, settings)
  C = paletteFor(s.look.style)
  return s.look
}

// ---------- formatting ----------

const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const bar = (ratio: number, width: number, on = '━', off = '─') => {
  const n = Math.max(0, Math.min(width, Math.round(ratio * width)))
  return [on.repeat(n), off.repeat(width - n)] as const
}

const tone = (ratio: number, warnAt: number, hotAt: number) =>
  ratio >= hotAt ? C.hot : ratio >= warnAt ? C.warn : C.ok

const limitLabel = (kind: string) =>
  kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind

const resetIn = (l: Limit, now: number) => {
  if (!l.resetsAt) return ''
  const at = Date.parse(l.resetsAt)
  return Number.isNaN(at) ? '' : `↻${dur(at - now)}`
}

// How close the context is to the point auto-compaction runs.
const ctxRatio = (m: Meter) => {
  const limit = m.isAutoCompact && m.threshold ? m.threshold : m.window
  return m.tokens === undefined ? 0 : m.tokens / limit
}

// Claude's own auto-compaction point, as a percent of the window.
const autoCompactPercent = (m: Meter | null) =>
  m?.isAutoCompact && m.threshold ? Math.round((m.threshold / m.window) * 100) : null

const PHASE: Record<Phase, string> = {
  waiting: '◌ waiting',
  thinking: '◐ thinking',
  responding: '◑ writing',
  tool: '⚙ tools',
}

const COMPACT_LABEL: Record<CompactMode, string> = { off: 'Off', remind: 'Remind', auto: 'Auto' }
const FOOTER_LABEL: Record<FooterMode, string> = { auto: 'Auto', on: 'On', off: 'Off' }
const nextCompact: Record<CompactMode, CompactMode> = { off: 'remind', remind: 'auto', auto: 'off' }
const nextFooter: Record<FooterMode, FooterMode> = { auto: 'on', on: 'off', off: 'auto' }
const STYLE_LABEL: Record<LookStyle, string> = { classic: 'Classic', minimal: 'Minimal', terminal: 'Terminal' }
const nextStyle: Record<LookStyle, LookStyle> = { classic: 'minimal', minimal: 'terminal', terminal: 'classic' }
const SIZES: Look['size'][] = ['s', 'm', 'l']
const stepSize = (size: Look['size'], d: number) => SIZES[Math.max(0, Math.min(2, SIZES.indexOf(size) + d))]!

const clampPct = (n: number) => Math.max(30, Math.min(100, Math.round(n)))

// The surface's `Svg`, where it draws one (every surface but the terminal).
// The Terminal look draws text everywhere, as the terminal does.
const svgOf = ($: EngineInterface, e: RenderInput, style: LookStyle) =>
  e.surface === 'terminal' || style === 'terminal' ? undefined : ($.ui.resolve(e) as { Svg?: ElementConstructor<SvgProps> }).Svg

// ---------- plumbing ----------

let ticker: Timer | null = null
let wrapTimer: Timer | null = null
let isCompacting = false

async function ensureTicker($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(1000, () => {
    void (async () => {
      const [l, w] = [await read($, live), await read($, wrap)]
      if (!l && !w.pending) {
        ticker?.cancel()
        ticker = null
        return
      }
      await update($, tick, n => n + 1)
    })()
  })
}

// Close the running phase's clock and start another.
async function shift($: EngineInterface, phase: Phase) {
  const now = await $.clock.now()
  await update($, live, l => {
    if (!l) return l
    const spent = now - l.phaseSince
    const add = {
      waiting: { waitMs: l.waitMs + spent },
      thinking: { thinkMs: l.thinkMs + spent },
      responding: { respondMs: l.respondMs + spent },
      tool: { toolMs: l.toolMs + spent },
    }[l.phase]
    return { ...l, ...add, phase, phaseSince: now }
  })
}

async function refreshBreakdown($: EngineInterface) {
  // `summary` is a local estimate: no request is sent.
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  await update($, meter, m => ({
    tokens: usage.context.tokens,
    window: usage.context.window,
    percent: usage.context.percent,
    limits: usage.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })),
    usd: usage.cost?.usd,
    delta: m?.delta,
    threshold: b?.autoCompactThreshold,
    isAutoCompact: b?.isAutoCompactEnabled ?? m?.isAutoCompact ?? true,
    categories: (b?.categories ?? [])
      .filter(c => c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens })),
  }))
}

// ---------- settings ----------

async function loadSettings($: EngineInterface) {
  const saved = (await $.store.get('settings')) as Partial<GaugeSettings> | undefined
  // 0.3 and before kept one wrap-up switch for both windows.
  const old = (await $.store.get('wrap')) as { isOn?: boolean; atPercent?: number } | undefined
  const oldFooter = await $.store.get('footer')
  const s: GaugeSettings = {
    wrap5h: saved?.wrap5h ?? (old ? { isOn: Boolean(old.isOn), at: old.atPercent ?? 90 } : DEFAULTS.wrap5h),
    wrap7d: saved?.wrap7d ?? (old ? { isOn: Boolean(old.isOn), at: old.atPercent ?? 95 } : DEFAULTS.wrap7d),
    compact: saved?.compact ?? DEFAULTS.compact,
    footer:
      saved?.footer ?? (oldFooter === 'on' || oldFooter === 'off' || oldFooter === 'auto' ? oldFooter : DEFAULTS.footer),
    look: saved?.look ?? DEFAULTS.look,
    models: { ...DEFAULTS.models, ...saved?.models },
    timeline: { ...DEFAULTS.timeline, ...saved?.timeline },
  }
  await update($, settings, () => s)
}

async function changeSettings($: EngineInterface, fn: (s: GaugeSettings) => GaugeSettings) {
  const s = await update($, settings, fn)
  await $.store.set('settings', s)
  if (!s.wrap5h.isOn && !s.wrap7d.isOn) await cancelWrap($)
  else await checkWrap($, (await $.session.usage()).rateLimits)
  await update($, compactAt, () => null)
  return s
}

const setRule = (which: 'wrap5h' | 'wrap7d', change: Partial<WrapRule>) => (s: GaugeSettings) => ({
  ...s,
  [which]: { ...s[which], ...change, at: clampPct(change.at ?? s[which].at) },
})

// ---------- wrap-up ----------

async function checkWrap($: EngineInterface, limits: readonly SessionRateLimit[]) {
  const s = await read($, settings)
  const w = await read($, wrap)
  // Only while a task runs: idle, there is nothing to wrap up, and the one
  // chance per limit window is kept for the next task.
  if (w.pending || !(await read($, live))) return
  const rule = (kind: string) => (kind === 'five_hour' ? s.wrap5h : kind === 'seven_day' ? s.wrap7d : null)
  const hit = limits.find(l => {
    const r = rule(l.kind)
    return r?.isOn && l.percentUsed >= r.at
  })
  if (!hit) return
  const key = `${hit.kind}@${hit.resetsAt ?? ''}`
  if (w.fired.includes(key)) return
  const label = `${limitLabel(hit.kind)} ${hit.percentUsed}%`
  const deadline = (await $.clock.now()) + WRAP_DELAY_MS
  await update($, wrap, x => ({ ...x, pending: { deadline, key, label } }))
  $.ui.toast(`${label}: wrap-up prompt in ${WRAP_DELAY_MS / 1000}s (cancel above the prompt)`, {
    timeoutMs: WRAP_DELAY_MS,
  })
  wrapTimer?.cancel()
  wrapTimer = $.clock.after(WRAP_DELAY_MS, () => void fireWrap($))
  await ensureTicker($)
}

async function cancelWrap($: EngineInterface) {
  wrapTimer?.cancel()
  wrapTimer = null
  await update($, wrap, x => (x.pending ? { ...x, fired: [...x.fired, x.pending.key].slice(-20), pending: null } : x))
}

async function fireWrap($: EngineInterface) {
  wrapTimer?.cancel()
  wrapTimer = null
  const w = await read($, wrap)
  if (!w.pending) return
  await update($, wrap, x => ({ ...x, fired: [...x.fired, w.pending!.key].slice(-20), pending: null }))
  if (await read($, live)) {
    // Joins the running turn: the model reads it at its next step.
    try {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: WRAP_PROMPT }] } })
      $.ui.toast(`${w.pending.label}: wrap-up prompt sent`)
    } catch (error) {
      $.ui.toast(`${w.pending.label}: wrap-up prompt not sent (${String(error).slice(0, 80)})`, { timeoutMs: 8000 })
    }
  } else {
    $.ui.toast(`${w.pending.label}: limit nearly used (idle, nothing to wrap up)`, { timeoutMs: 8000 })
  }
}

// ---------- the /compact rule ----------

// Runs when the session is idle: reminds once, or compacts, past the rule.
async function checkCompact($: EngineInterface) {
  const s = await read($, settings)
  const m = await read($, meter)
  if (s.compact.mode === 'off' || !m || m.percent === undefined || (await read($, live)) || isCompacting) return
  if (m.percent < s.compact.at) {
    await update($, compactAt, () => null)
    return
  }
  if ((await read($, compactAt)) !== null) return
  await update($, compactAt, () => m.percent ?? null)
  if (s.compact.mode === 'remind') {
    $.ui.toast(`Context ${m.percent}%: a good point to /compact`, { timeoutMs: 8000 })
    return
  }
  isCompacting = true
  $.ui.toast(`Context ${m.percent}%: compacting…`, { timeoutMs: 6000 })
  try {
    await $.session.compact()
    await refreshBreakdown($)
  } catch (error) {
    $.ui.toast(`Compaction did not run (${String(error).slice(0, 80)})`, { timeoutMs: 8000 })
  } finally {
    isCompacting = false
  }
}

// ---------- models and modes ----------

// Aliases follow the newest version; full ids pin one. Any other id can be typed in settings.
const MODEL_CHOICES = [
  'sonnet',
  'opus',
  'haiku',
  'fable',
  'sonnet[1m]',
  'opus[1m]',
  'fable[1m]',
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-haiku-4-5',
  'claude-fable-5-1',
]
const EFFORTS: EffortName[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_SHORT: Record<EffortName, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' }

const modelLabel = (m: string) => {
  const one = m.endsWith('[1m]') ? ' 1M' : ''
  const base = m.replace('[1m]', '')
  const pinned = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(base)
  const name = pinned ? `${pinned[1]} ${pinned[2]}.${pinned[3]}` : base
  return name.charAt(0).toUpperCase() + name.slice(1) + one
}
const slotLabel = (slot: Slot) => `${modelLabel(slot.model)} ${EFFORT_SHORT[slot.effort]}`
const isLocked = (slot: Slot, prefs: ModelPrefs) => /fable/i.test(slot.model) && !prefs.hasMax

// A request's model id ('claude-opus-5-5') to the family a slot names ('opus').
const familyOf = (id?: string) =>
  !id ? undefined
  : /fable/i.test(id) ? 'fable'
  : /opus/i.test(id) ? 'opus'
  : /sonnet/i.test(id) ? 'sonnet'
  : /haiku/i.test(id) ? 'haiku'
  : undefined

// The slot the session runs on: the one switched to here, else one matching the last request.
function activeSlot(c: Current, prefs: ModelPrefs) {
  if (c.slot !== null) return c.slot
  const family = familyOf(c.model)
  const i = prefs.slots.findIndex(x => familyOf(x.model) === family && x.effort === c.effort)
  return i === -1 ? null : i
}

const firstLine = (text: string | undefined) => (text ?? '').split('\n').find(l => l.trim())?.trim().slice(0, 140) ?? ''

// Switching runs the built-in commands, which cannot run inside a command's
// own hook: the /gauge forms defer them past it.
const later = ($: EngineInterface, fn: () => Promise<void>) => void $.clock.after(0, () => void fn())

async function applySlot($: EngineInterface, i: number) {
  const s = await read($, settings)
  const slot = s.models.slots[i]
  if (!slot) return
  if (isLocked(slot, s.models)) {
    $.ui.toast(`${slotLabel(slot)} is for Max plans. On Max? Unlock it in /gauge settings → Models.`, { timeoutMs: 7000 })
    return
  }
  try {
    await $.command.run({ command: 'model', args: slot.model })
    await $.command.run({ command: 'effort', args: slot.effort })
    await update($, current, c => ({ ...c, slot: i, model: slot.model, effort: slot.effort }))
    await update($, isPickerOpen, () => false)
    $.ui.toast(`→ ${slotLabel(slot)}`)
  } catch (error) {
    $.ui.toast(`Could not switch to ${slotLabel(slot)} (${String(error).slice(0, 80)})`, { timeoutMs: 7000 })
  }
}

async function toggleFast($: EngineInterface) {
  try {
    const r = await $.command.run({ command: 'fast' })
    const text = firstLine(r.text)
    const isOn = /unavailable|\boff\b|disabled/i.test(text) ? false : /\bon\b|enabled/i.test(text) ? true : null
    await update($, current, c => ({ ...c, fast: isOn ?? (c.fast === null ? null : !c.fast) }))
    $.ui.toast(text || 'Fast mode toggled', { timeoutMs: 6000 })
  } catch (error) {
    $.ui.toast(`Fast mode did not change (${String(error).slice(0, 80)})`, { timeoutMs: 7000 })
  }
}

async function youShouldKnowOn($: EngineInterface) {
  try {
    const enabled = (await $.settings.read()).enabledPlugins as Record<string, unknown> | undefined
    return enabled?.[YSK] === true
  } catch {
    return null
  }
}

async function loadModes($: EngineInterface) {
  const rows = await $.config.list()
  const style = rows.find(r => r.key === 'outputStyle')
  const ysk = await youShouldKnowOn($)
  await update($, current, c => ({
    ...c,
    outputStyle: style ? String(style.value) : c.outputStyle,
    styles: style?.options ? [...style.options] : c.styles,
    youShouldKnow: ysk,
  }))
}

async function setStyle($: EngineInterface, wanted?: string) {
  const c = await read($, current)
  const list = c.styles.length ? c.styles : ['default', 'Concise', 'Explanatory', 'Learning']
  const next =
    wanted !== undefined
      ? list.find(x => x.toLowerCase() === wanted.toLowerCase())
      : list[(Math.max(0, list.indexOf(c.outputStyle ?? 'default')) + 1) % list.length]
  if (!next) return `Output styles: ${list.join(', ')}.`
  try {
    await $.config.set({ key: 'outputStyle', value: next })
    await update($, current, x => ({ ...x, outputStyle: next }))
    return `Output style: ${next}.`
  } catch (error) {
    return `Output style did not change (${String(error).slice(0, 80)}).`
  }
}

async function setYouShouldKnow($: EngineInterface, isOn: boolean) {
  try {
    const r = await $.command.run({ command: 'plugin', args: `${isOn ? 'enable' : 'disable'} ${YSK}` })
    await update($, current, c => ({ ...c, youShouldKnow: isOn }))
    $.ui.toast(firstLine(r.text) || `You should know ${isOn ? 'on' : 'off'}`, { timeoutMs: 6000 })
    const actual = await youShouldKnowOn($)
    if (actual !== null) await update($, current, c => ({ ...c, youShouldKnow: actual }))
  } catch (error) {
    $.ui.toast(`You should know did not change (${String(error).slice(0, 80)})`, { timeoutMs: 7000 })
  }
}

// ---------- timeline ----------

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path
const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const updateRunning = ($: EngineInterface, fn: (x: Entry) => Entry) =>
  update($, timeline, list => {
    const i = list.map(x => x.status).lastIndexOf('running')
    return i === -1 ? list : list.map((x, j) => (j === i ? fn(x) : x))
  })

async function summarize($: EngineInterface, id: string, prompt: string, answer: string) {
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 60,
    prompt: [
      'In one short line (at most 12 words, in the language of the request), say what was done.',
      `Request: ${prompt.slice(0, 600)}`,
      `Result: ${answer.slice(0, 1500)}`,
    ].join('\n'),
  })
  if (r.isAnswered && r.text.trim()) {
    await update($, timeline, list => list.map(x => (x.id === id ? { ...x, summary: firstLine(r.text) } : x)))
  }
}

const openTimeline = ($: EngineInterface) => $.ui.open({ id: TIMELINE_PANE, title: 'Timeline' })

// The model picker opens as a small dialog: it takes the keys, Esc closes it.
const openPicker = ($: EngineInterface) =>
  $.ui.open({ id: PICKER_PANE, title: 'Model', focus: true, closeOnEscape: true, rows: 9 })

async function jumpTo($: EngineInterface, id: string) {
  if (id.startsWith('turn-')) {
    $.ui.toast('This line has no message to jump to.', { timeoutMs: 4000 })
    return
  }
  const r = await $.ui.scroll({ to: { requestId: id }, block: 'start' })
  if (r.deny) $.ui.toast(`Could not jump there (${r.deny})`, { timeoutMs: 5000 })
}

// ---------- actions ----------

async function stopTurn($: EngineInterface) {
  const l = await read($, live)
  if (l) await $.turn.abort({ turnId: l.turnId })
}

async function toggleCollapsed($: EngineInterface) {
  const v = await update($, isCollapsed, c => !c)
  await $.store.set('isCollapsed', v)
}

const openSettings = ($: EngineInterface) => $.ui.open({ id: SETTINGS_PANE, title: 'Gauge settings' })

const COMMANDS = [
  '/gauge                     live gauge',
  '/gauge pane                side pane',
  '/gauge settings            settings',
  '/gauge wrap 5h 90|on|off   wrap-up at the 5-hour limit',
  '/gauge wrap 7d 95|on|off   wrap-up at the weekly limit',
  '/gauge compact 70|remind|auto|off   when to /compact',
  '/gauge footer auto|on|off  line under each answer',
  '/gauge look classic|minimal|terminal  display style',
  '/gauge size s|m|l          text size',
  '/gauge model 1-5           switch to a slider position',
  '/gauge model               the model picker',
  '/gauge models on|off       show or hide the model chip',
  '/gauge max on|off          you have a Max plan (unlocks Fable)',
  '/gauge fast                toggle fast mode',
  '/gauge style [name]        next output style, or one by name',
  '/gauge ysk on|off          the You should know side agent',
  '/gauge timeline            the session timeline',
  '/gauge summary on|off      AI summaries on the timeline (uses tokens)',
  '/gauge marks on|off        timeline marks on your messages',
  '/gauge strip on|off        timeline strip above the prompt',
].join('\n')

async function onSlide($: EngineInterface, e: { data: unknown }) {
  const slot = (e.data as { slot?: unknown } | null)?.slot
  if (typeof slot === 'number') later($, () => applySlot($, slot))
  return {}
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gauge',
      description: 'Usage gauge; `pane`, `settings`, `timeline`, `model 1-5`, `fast`, `style`, `wrap …`, `compact …`',
      argumentHint: '[pane | settings | timeline | model 1-5 | fast | style … | wrap … | compact …]',
    })
    await loadSettings($)
    await update($, wrap, w => ({ ...w, pending: null }))
    const collapsed = await $.store.get('isCollapsed')
    if (typeof collapsed === 'boolean') await update($, isCollapsed, () => collapsed)
    await refreshBreakdown($)
    await loadModes($)

    return next(e)
  })

  // The model sliders' Clients (the band's track, the picker's) post the
  // position the person let go on.
  on('ui.message', { element: 'model-slider' }, onSlide)
  on('ui.message', { element: 'model-track' }, onSlide)

  on('command.run', { command: 'gauge' }, async ($, e) => {
    const [sub, a, b] = e.args.trim().toLowerCase().split(/\s+/)
    if (sub === 'wrap') {
      const which = a === '5h' ? 'wrap5h' : a === '7d' ? 'wrap7d' : null
      const word = which ? b : a
      const pct = Number(word)
      const change: Partial<WrapRule> | null =
        word === 'on' ? { isOn: true } : word === 'off' ? { isOn: false } : pct >= 30 && pct <= 100 ? { at: pct, isOn: true } : null
      if (!change) return { text: `Usage:\n\`\`\`\n${COMMANDS}\n\`\`\`` }
      const s = await changeSettings($, x =>
        which ? setRule(which, change)(x) : setRule('wrap7d', change)(setRule('wrap5h', change)(x)),
      )
      return { text: `Wrap-up: 5h ${ruleText(s.wrap5h)}, 7d ${ruleText(s.wrap7d)}.` }
    }
    if (sub === 'compact') {
      const pct = Number(a)
      const s = await changeSettings($, x =>
        a === 'off' || a === 'remind' || a === 'auto'
          ? { ...x, compact: { ...x.compact, mode: a } }
          : pct >= 30 && pct <= 100
            ? { ...x, compact: { mode: x.compact.mode === 'off' ? 'remind' : x.compact.mode, at: clampPct(pct) } }
            : x,
      )
      return { text: `/compact rule: ${compactText(s)}.` }
    }
    if (sub === 'footer') {
      if (a === 'on' || a === 'off' || a === 'auto') await changeSettings($, x => ({ ...x, footer: a }))
      return { text: `Line under each answer: ${(await read($, settings)).footer}.` }
    }
    if (sub === 'look' && (a === 'classic' || a === 'minimal' || a === 'terminal')) {
      await changeSettings($, x => ({ ...x, look: { ...x.look, style: a } }))
      return { text: `Display style: ${a}.` }
    }
    if (sub === 'size' && (a === 's' || a === 'm' || a === 'l')) {
      await changeSettings($, x => ({ ...x, look: { ...x.look, size: a } }))
      return { text: `Text size: ${a.toUpperCase()}.` }
    }
    if (sub === 'model' && a === undefined) {
      await update($, isPickerOpen, () => true)
      const s = await read($, settings)
      const c = await read($, current)
      const at = activeSlot(c, s.models)
      return {
        text:
          s.models.slots.map((x, i) => `${i === at ? '●' : '○'} ${i + 1} ${slotLabel(x)}${isLocked(x, s.models) ? ' (Max)' : ''}`).join('\n') +
            '\nUse /gauge model 1-5.',
      }
    }
    if (sub === 'model') {
      const i = Number(a) - 1
      const slot = (await read($, settings)).models.slots[i]
      if (!slot) return { text: 'Use /gauge model 1-5.' }
      later($, () => applySlot($, i))
      return { text: `Switching to ${slotLabel(slot)}.` }
    }
    if (sub === 'models' && (a === 'on' || a === 'off')) {
      await changeSettings($, x => ({ ...x, models: { ...x.models, isShown: a === 'on' } }))
      return { text: `Model slider ${a}.` }
    }
    if (sub === 'max' && (a === 'on' || a === 'off')) {
      await changeSettings($, x => ({ ...x, models: { ...x.models, hasMax: a === 'on' } }))
      return { text: a === 'on' ? 'Max plan: Fable positions unlocked.' : 'Fable positions locked.' }
    }
    if (sub === 'fast') {
      later($, () => toggleFast($))
      return { text: 'Toggling fast mode.' }
    }
    if (sub === 'style') return { text: await setStyle($, e.args.trim().split(/\s+/)[1]) }
    if (sub === 'ysk' && (a === 'on' || a === 'off')) {
      later($, () => setYouShouldKnow($, a === 'on'))
      return { text: `Turning You should know ${a}.` }
    }
    if (sub === 'summary' && (a === 'on' || a === 'off')) {
      await changeSettings($, x => ({ ...x, timeline: { ...x.timeline, isAiSummary: a === 'on' } }))
      return { text: `AI summaries on the timeline: ${a}.` }
    }
    if ((sub === 'marks' || sub === 'strip') && (a === 'on' || a === 'off')) {
      const key = sub === 'marks' ? 'isMarked' : 'isStrip'
      await changeSettings($, x => ({ ...x, timeline: { ...x.timeline, [key]: a === 'on' } }))
      return { text: `Timeline ${sub === 'marks' ? 'marks on messages' : 'strip'}: ${a}.` }
    }
    if (sub === 'timeline') {
      const opened = await openTimeline($)
      return { text: opened.isPlaced ? 'Timeline opened.' : await timelineText($) }
    }
    if (sub === 'pane') {
      const opened = await $.ui.open({ id: PANE, title: 'Gauge' })
      return { text: opened.isPlaced ? 'Gauge pane opened.' : `Gauge pane waits: ${opened.reason}` }
    }
    if (sub === 'settings') return { text: await settingsText($) }
    // A text snapshot for any client that draws the row as text; clients
    // that draw plugin trees replace it with the live gauge.
    return { text: await snapshot($) }
  })

  on('session.measure', async ($, e, next) => {
    const prev = await read($, meter)
    await update($, meter, m => ({
      threshold: m?.threshold,
      isAutoCompact: m?.isAutoCompact ?? true,
      categories: m?.categories ?? [],
      tokens: e.context.tokens,
      window: e.context.window,
      percent: e.context.percent,
      limits: e.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })),
      usd: e.cost?.usd,
      delta:
        prev?.tokens !== undefined && e.context.tokens !== undefined
          ? e.context.tokens - prev.tokens
          : m?.delta,
    }))
    if (e.changed.includes('context') && (!prev || prev.window !== e.context.window || !(await read($, live)))) {
      await refreshBreakdown($)
    }
    await checkWrap($, e.rateLimits)
    if (e.changed.includes('context')) void checkCompact($)

    return next(e)
  })

  // Each prompt the person sends starts a line on the timeline; its row's id
  // is what a press scrolls back to.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (!e.agentId && e.door === 'prompt' && e.message.type === 'user') {
      const text = e.message.content
        .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) {
        const at = await $.clock.now()
        const entry: Entry = { id: stored.uuid ?? e.uuid, text: text.slice(0, 300), at, ms: null, tools: 0, errors: 0, files: [], status: 'running' }
        await update($, timeline, list => [...list.map(x => (x.status === 'running' ? { ...x, status: 'stopped' as const } : x)), entry].slice(-100))
      }
    }
    return stored
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, live, (): Live => ({
      turnId: e.turnId,
      startedAt: now,
      phase: 'waiting',
      phaseSince: now,
      thinkMs: 0,
      respondMs: 0,
      toolMs: 0,
      waitMs: 0,
      outTokens: 0,
      genMs: 0,
      tools: [],
    }))
    await ensureTicker($)
    await checkWrap($, (await $.session.usage()).rateLimits)
    // A turn whose prompt row was not seen (or one started without one) still
    // gets its line; such a line cannot jump back.
    const list = await read($, timeline)
    if (e.text.trim() && list[list.length - 1]?.status !== 'running') {
      const entry: Entry = {
        id: `turn-${e.turnId}`,
        text: e.text.replace(/\s+/g, ' ').trim().slice(0, 300),
        at: now,
        ms: null,
        tools: 0,
        errors: 0,
        files: [],
        status: 'running',
      }
      await update($, timeline, x => [...x, entry].slice(-100))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const prefs = (await read($, settings)).models
    await update($, current, c => {
      const slot = c.slot === null ? undefined : prefs.slots[c.slot]
      const isSame = slot && familyOf(slot.model) === familyOf(e.model)
      return { ...c, model: e.model, effort: e.effort === undefined ? c.effort : String(e.effort), slot: isSame ? c.slot : null }
    })
    await shift($, 'waiting')
    let phase: Phase = 'waiting'
    let firstAt = 0
    for await (const chunk of next(e)) {
      const p: Phase | null =
        chunk.kind === 'thinking'
          ? 'thinking'
          : chunk.kind === 'text'
            ? 'responding'
            : chunk.kind === 'tool' || chunk.kind === 'input'
              ? 'tool'
              : null
      if (p) {
        if (!firstAt) firstAt = await $.clock.now()
        if (p !== phase) {
          phase = p
          await shift($, p)
        }
      }
      if (chunk.kind === 'stop' && chunk.usage) {
        const out = chunk.usage.output_tokens
        const gen = firstAt ? (await $.clock.now()) - firstAt : 0
        await update($, live, l => (l ? { ...l, outTokens: l.outTokens + out, genMs: l.genMs + gen } : l))
      }
      yield chunk
    }
    await shift($, 'tool')
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId || !(await read($, live))) return next(e)
    const startedAt = await $.clock.now()
    const row: ToolRow = { id: e.tool_use_id, name: String(e.tool), startedAt, ms: null, isError: false }
    await update($, live, l => (l ? { ...l, tools: [...l.tools, row].slice(-30) } : l))
    const result = await next(e)
    const ms = (await $.clock.now()) - startedAt
    const isError = Boolean((result as { isError?: boolean }).isError)
    await update($, live, l =>
      l ? { ...l, tools: l.tools.map(t => (t.id === row.id ? { ...t, ms, isError } : t)) } : l,
    )
    const path = EDITS.has(String(e.tool)) ? (e as { file_path?: unknown }).file_path : undefined
    await updateRunning($, x => ({
      ...x,
      tools: x.tools + 1,
      errors: x.errors + (isError ? 1 : 0),
      files: typeof path === 'string' && !x.files.includes(baseName(path)) ? [...x.files, baseName(path)].slice(-6) : x.files,
    }))

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    await shift($, 'waiting')
    const l = await read($, live)
    if (l && l.turnId === e.turnId) {
      const row: TurnRow = {
        ms: e.durationMs,
        thinkMs: l.thinkMs,
        toolMs: l.toolMs,
        outTokens: l.outTokens,
        tps: l.genMs > 500 ? Math.round(l.outTokens / (l.genMs / 1000)) : null,
        tools: l.tools.length,
        isAborted: e.isAborted,
      }
      await update($, history, h => [...h, row].slice(-20))
      await update($, live, () => null)
      const finished = await updateRunning($, x => ({
        ...x,
        ms: e.durationMs,
        status: e.isAborted ? 'stopped' : e.reason === 'error' || e.reason === 'refusal' || x.errors > 0 ? 'error' : 'ok',
      }))
      const entry = [...finished].reverse().find(x => x.ms === e.durationMs)
      if (entry && (await read($, settings)).timeline.isAiSummary) void summarize($, entry.id, entry.text, e.answer)
      const mode = (await read($, settings)).footer
      const isShown = mode === 'on' || (mode === 'auto' && (await $.session.surfaces()).length === 0)
      if (isShown) {
        const answered = await next(e)
        // A text other than the answer is shown beneath it; the model never reads it.
        return { ...answered, text: await footerLine($, row) }
      }
      if (e.isAborted) {
        $.ui.toast(`■ Stopped after ${dur(e.durationMs)}`)
      } else if (e.durationMs >= NOTIFY_AFTER_MS) {
        $.ui.toast(
          `✓ Done in ${dur(e.durationMs)} · ${row.tools} tools · ${k(row.outTokens)} out` +
            (row.tps ? ` · ${row.tps} tok/s` : ''),
          { timeoutMs: 6000 },
        )
      }
    }

    return next(e)
  })

  // ---------- band above the prompt ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const m = await read($, meter)
    const l = await read($, live)
    const w = await read($, wrap)
    await read($, tick)
    if (!m && !l) return next(e)
    const look = await lookOf($)
    const now = await $.clock.now()
    const isNarrow = e.props.bodyColumns < 90
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = svgOf($, e, look.style)
    const sep = <Text color={C.rule}> │ </Text>

    const ctx = m ? ctxRatio(m) : 0
    const ctxColor = tone(ctx, 0.75, 0.9)
    const [on1, off1] = bar(ctx, isNarrow ? 8 : 16)
    const limits = (m?.limits ?? []).filter(x => !isNarrow || x.kind === 'five_hour')
    const drawn = m && readings(m, ctx, now, look.style)

    const gear = <Button key="settings" label="⚙" plain dimColor onPress={() => openSettings($)} />
    const chip = await drawChip($, e)
    const strip_ = await drawStrip($, e)

    const meterRow =
      m && drawn && Svg ? (
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Svg source={strip(drawn, m.usd, look)} alt={alt(drawn, m.usd)} />
          {chip}
          {strip_.ticks}
          {gear}
        </Box>
      ) : (
        m && (
          <Box flexDirection="row" flexWrap="wrap">
            <Text color={C.accent}>◆ </Text>
            <Text dimColor>ctx </Text>
            <Text color={ctxColor}>{on1}</Text>
            <Text color={C.rule}>{off1}</Text>
            <Text color={ctxColor} bold>
              {' '}
              {m.percent ?? 0}%
            </Text>
            {!isNarrow && m.tokens !== undefined && (
              <Text dimColor>
                {' '}
                {k(m.tokens)}/{k(m.isAutoCompact && m.threshold ? m.threshold : m.window)}
              </Text>
            )}
            {!isNarrow && m.delta ? (
              <Text dimColor>
                {' '}
                {m.delta > 0 ? '+' : ''}
                {k(m.delta)}
              </Text>
            ) : null}
            {ctx >= 0.9 && <Text color={C.hot}> ⚠ compacts soon</Text>}
            {limits.map(x => {
              const c = tone(x.percent / 100, 0.7, 0.9)
              const [a, b] = bar(x.percent / 100, 5, '▰', '▱')
              return (
                <Box flexDirection="row">
                  {sep}
                  <Text dimColor>{limitLabel(x.kind)} </Text>
                  <Text color={c}>{a}</Text>
                  <Text color={C.rule}>{b}</Text>
                  <Text color={c}> {x.percent}%</Text>
                  <Text dimColor> {resetIn(x, now)}</Text>
                </Box>
              )
            })}
            {!isNarrow && m.usd !== undefined && (
              <Box flexDirection="row">
                {sep}
                <Text dimColor>${m.usd.toFixed(2)}</Text>
              </Box>
            )}
            <Text> </Text>
            {chip}
            <Text> </Text>
            {strip_.ticks}
            <Text> </Text>
            {gear}
          </Box>
        )
      )

    const running = l && l.tools.find(t => t.ms === null)
    const tps = l && l.genMs > 500 ? Math.round(l.outTokens / (l.genMs / 1000)) : null
    const phaseNow = l ? now - l.phaseSince : 0
    const thinkTotal = l ? l.thinkMs + (l.phase === 'thinking' ? phaseNow : 0) : 0

    const liveRow = l && (
      <Box flexDirection="row" flexWrap="wrap">
        <Text color={C.accent}>{PHASE[l.phase]} </Text>
        <Text>{dur(phaseNow)}</Text>
        {sep}
        <Text dimColor>turn {dur(now - l.startedAt)}</Text>
        {thinkTotal > 0 && <Text dimColor> · think {dur(thinkTotal)}</Text>}
        {tps !== null && <Text dimColor> · {tps} tok/s</Text>}
        {running && <Text dimColor> · {running.name} {dur(now - running.startedAt)}</Text>}
        <Text>  </Text>
        <Button key="stop" label="■ Stop" hotkey="s" onPress={() => stopTurn($)} />
        <Text> </Text>
        <Button key="pane" label="Panel" dimColor onPress={() => $.ui.open({ id: PANE, title: 'Gauge' })} />
        <Text> </Text>
        <Button key="timeline" label="Timeline" dimColor onPress={() => openTimeline($)} />
      </Box>
    )

    const wrapRow = w.pending && (
      <Box flexDirection="row" flexWrap="wrap">
        <Text color={C.hot}>{w.pending.label} </Text>
        <Text dimColor>wrap-up prompt in {dur(w.pending.deadline - now)} </Text>
        <Button key="wrap-cancel" label="Cancel" hotkey="c" onPress={() => cancelWrap($)} />
        <Text> </Text>
        <Button key="wrap-now" label="Send now" dimColor onPress={() => fireWrap($)} />
      </Box>
    )

    const picker = await drawInlinePicker($, e)

    return (
      <Box flexDirection="column">
        {wrapRow}
        {meterRow}
        {picker}
        {liveRow}
        {strip_.cards}
      </Box>
    )
  })

  // A mark on each of your messages: its status as a colored rule, and on
  // hover a card with how it went. Off in settings, or ctrl+o, draws the row as is.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.origin.kind !== 'composer') return next(e)
    if (!(await read($, settings)).timeline.isMarked) return next(e)
    const list = await read($, timeline)
    const head = e.props.text.replace(/\s+/g, ' ').trim().slice(0, 40)
    const x = list.find(y => y.id === e.requestId) ?? [...list].reverse().find(y => head !== '' && y.text.startsWith(head))
    if (!x) return next(e)
    await lookOf($)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    return (
      <Box key={`mark-${e.requestId}`} flexDirection="row">
        <Text color={statusColor(x)}>▍ </Text>
        <Text>{e.props.text}</Text>
        <Box position="absolute" top={-3} left={2} display="none" hover={{ display: 'flex' }} borderStyle="round" borderColor={statusColor(x)} paddingX={1}>
          <Text wrap="truncate">{entryCard(x, now)}</Text>
        </Box>
      </Box>
    )
  })

  // ---------- panes, and the /gauge rows in the transcript ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawGauge($, e, e.props.bodyColumns))
  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, ($, e) => drawSettings($, e))
  on('ui.render', { component: 'Pane', requestId: TIMELINE_PANE }, ($, e) => drawTimeline($, e))
  on('ui.render', { component: 'Pane', requestId: PICKER_PANE }, ($, e) => drawPicker($, e))

  // The /gauge rows draw live in the transcript on every client that draws
  // plugin trees: the mobile app draws no band and places no pane.
  on('ui.render', { component: 'CommandOutput', props: { command: 'gauge' } }, ($, e, next) => {
    const sub = e.props.args.trim().toLowerCase()
    if (sub === '') return drawGauge($, e, e.viewport?.columns ?? 60)
    if (sub === 'settings') return drawSettings($, e)
    if (sub === 'timeline') return drawTimeline($, e)
    if (sub === 'model') return drawPicker($, e)
    return next(e)
  })
}

// ---------- text views (clients that draw text, and the cloud) ----------

const DOT = (ratio: number, warnAt: number, hotAt: number) => (ratio >= hotAt ? '🔴' : ratio >= warnAt ? '🟡' : '🟢')
const ruleText = (r: WrapRule) => (r.isOn ? `at ${r.at}%` : 'off')
const compactText = (s: GaugeSettings) => (s.compact.mode === 'off' ? 'off' : `${s.compact.mode} at ${s.compact.at}%`)

async function footerLine($: EngineInterface, row: TurnRow) {
  const m = await read($, meter)
  const s = await read($, settings)
  const now = await $.clock.now()
  const parts: string[] = []
  if (m) {
    const r = ctxRatio(m)
    parts.push(`${DOT(r, 0.75, 0.9)} ctx ${m.percent ?? 0}%` + (r >= 0.9 ? ' compacts soon' : ''))
    for (const x of m.limits) {
      parts.push(`${DOT(x.percent / 100, 0.7, 0.9)} ${limitLabel(x.kind)} ${x.percent}% ${resetIn(x, now)}`.trim())
    }
    if (m.usd !== undefined) parts.push(`$${m.usd.toFixed(2)}`)
  }
  parts.push(`⏱ ${dur(row.ms)}` + (row.thinkMs ? ` (think ${dur(row.thinkMs)})` : ''))
  if (row.tools) parts.push(`${row.tools} tools`)
  if (row.tps) parts.push(`${row.tps} tok/s`)
  if (m?.percent !== undefined && s.compact.mode === 'remind' && m.percent >= s.compact.at) parts.push('💡 /compact')
  return parts.join('  ·  ')
}

async function snapshot($: EngineInterface) {
  const m = await read($, meter)
  const l = await read($, live)
  const now = await $.clock.now()
  const rows: string[] = []
  const line = (dot: string, label: string, ratio: number, value: string, note: string) => {
    const [a, b] = bar(ratio, 14, '█', '░')
    rows.push(`${dot} ${label.padEnd(7)} ${a}${b} ${value.padStart(4)}  ${note}`.trimEnd())
  }
  if (m) {
    const r = ctxRatio(m)
    const limit = m.isAutoCompact && m.threshold ? m.threshold : m.window
    line(DOT(r, 0.75, 0.9), 'CONTEXT', r, `${m.percent ?? 0}%`, r >= 0.9 ? 'compacts soon' : `${k(m.tokens ?? 0)} / ${k(limit)}`)
    for (const kind of ['five_hour', 'seven_day']) {
      const x = m.limits.find(y => y.kind === kind)
      const label = kind === 'five_hour' ? '5 HOUR' : '7 DAY'
      if (x) line(DOT(x.percent / 100, 0.7, 0.9), label, x.percent / 100, `${x.percent}%`, resetIn(x, now).replace('↻', 'resets '))
      else rows.push(`⚪ ${label.padEnd(7)} ${'░'.repeat(14)}    —  after first reply`)
    }
    if (m.usd !== undefined) rows.push(`💰 COST    $${m.usd.toFixed(2)}`)
  }
  if (l) rows.push(`${PHASE[l.phase]} · turn ${dur(now - l.startedAt)} · ${l.tools.length} tools`)
  const surfaces = await $.session.surfaces()
  return '```\n' + rows.join('\n') + '\n```\n' + `settings: /gauge settings · clients: ${surfaces.join(', ') || 'none'}`
}

async function settingsText($: EngineInterface) {
  const s = await read($, settings)
  const auto = autoCompactPercent(await read($, meter))
  return [
    '```',
    'AUTO WRAP-UP',
    `  5-hour limit   ${ruleText(s.wrap5h)}`,
    `  weekly limit   ${ruleText(s.wrap7d)}`,
    'CONTEXT',
    `  /compact       ${compactText(s)}` + (auto ? `   (Claude auto-compacts at ${auto}%)` : ''),
    `LINE UNDER ANSWERS  ${s.footer}`,
    `DISPLAY  ${s.look.style}, text ${s.look.size.toUpperCase()}`,
    '```',
    '```',
    COMMANDS,
    '```',
  ].join('\n')
}

// ---------- tree views ----------

async function drawSettings($: EngineInterface, e: RenderInput<'Pane' | 'CommandOutput'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const Input = e.surface === 'mobile' ? undefined : ($.ui.resolve(e) as { Input?: ElementConstructor<InputProps> }).Input
  await lookOf($)
  const s = await read($, settings)
  const c = await read($, current)
  const tab = await read($, settingsTab)
  const auto = autoCompactPercent(await read($, meter))

  const head = (title: string, note: string) => (
    <Box flexDirection="column" marginTop={1}>
      <Text color={C.accent} bold>
        {title}
      </Text>
      <Text dimColor>{note}</Text>
    </Box>
  )

  const row = (label: string, ...children: RenderChildren[]) => (
    <Box flexDirection="row" gap={1}>
      <Text>{label.padEnd(14)}</Text>
      {children}
    </Box>
  )

  const toggle = (key: string, isOn: boolean | null, onPress: () => unknown) => (
    <Button key={key} label={isOn ? 'On ' : 'Off'} dimColor={!isOn} onPress={onPress} />
  )

  const stepper = (id: string, value: number, onStep: (d: number) => void, isOn: boolean) => (
    <Box flexDirection="row">
      <Button key={`${id}-down`} label="−" plain dimColor onPress={() => onStep(-5)} />
      <Text color={isOn ? undefined : C.rule}> {String(value).padStart(3)}% </Text>
      <Button key={`${id}-up`} label="+" plain dimColor onPress={() => onStep(5)} />
    </Box>
  )

  const ruleRow = (which: 'wrap5h' | 'wrap7d', label: string) => {
    const r = s[which]
    return row(
      label,
      toggle(`${which}-toggle`, r.isOn, () => changeSettings($, setRule(which, { isOn: !r.isOn }))),
      <Text dimColor>at</Text>,
      stepper(which, r.at, d => void changeSettings($, setRule(which, { at: r.at + d })), r.isOn),
    )
  }

  const TABS: [SettingsTab, string][] = [
    ['usage', 'Usage'],
    ['models', 'Models'],
    ['timeline', 'Timeline'],
    ['display', 'Display'],
  ]
  const tabs = (
    <Box flexDirection="row" gap={1}>
      {TABS.map(([id, label]) => (
        <Button key={`tab-${id}`} label={label} variant={id === tab ? 'primary' : undefined} dimColor={id !== tab} onPress={() => update($, settingsTab, () => id)} />
      ))}
    </Box>
  )

  const setSlot = (i: number, change: Partial<Slot>) =>
    changeSettings($, x => ({
      ...x,
      models: { ...x.models, slots: x.models.slots.map((slot, j) => (j === i ? { ...slot, ...change } : slot)) },
    }))
  const cycle = <T,>(list: readonly T[], value: T) => list[(list.indexOf(value) + 1) % list.length]!

  const usage = (
    <Box flexDirection="column">
      {head('Auto wrap-up', 'A note into the running task: finish the step, save, hand off.')}
      {ruleRow('wrap5h', '5-hour limit')}
      {ruleRow('wrap7d', 'Weekly limit')}
      {head('Context', `When to /compact${auto ? ` (Claude auto-compacts at ${auto}%)` : ''}. Auto runs only while idle.`)}
      {row(
        '/compact',
        <Button
          key="compact-mode"
          label={COMPACT_LABEL[s.compact.mode].padEnd(6)}
          dimColor={s.compact.mode === 'off'}
          onPress={() => changeSettings($, x => ({ ...x, compact: { ...x.compact, mode: nextCompact[x.compact.mode] } }))}
        />,
        <Text dimColor>at</Text>,
        stepper(
          'compact',
          s.compact.at,
          d => void changeSettings($, x => ({ ...x, compact: { ...x.compact, at: clampPct(x.compact.at + d) } })),
          s.compact.mode !== 'off',
        ),
      )}
    </Box>
  )

  const models = (
    <Box flexDirection="column">
      {head('Model picker', 'A chip above the prompt opens it. Click a part of a position to change it.')}
      {row('Show chip', toggle('models-shown', s.models.isShown, () => changeSettings($, x => ({ ...x, models: { ...x.models, isShown: !x.models.isShown } }))))}
      {s.models.slots.map((slot, i) =>
        row(
          `Position ${i + 1}`,
          <Button key={`slot-${i}-model`} label={modelLabel(slot.model).padEnd(9)} dimColor onPress={() => setSlot(i, { model: cycle(MODEL_CHOICES, slot.model) })} />,
          <Button key={`slot-${i}-effort`} label={EFFORT_SHORT[slot.effort].padEnd(5)} dimColor onPress={() => setSlot(i, { effort: cycle(EFFORTS, slot.effort) })} />,
          isLocked(slot, s.models) ? <Text color={C.warn}>Max only</Text> : null,
        ),
      )}
      {Input && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Or type any model id for a position, as /model takes it (e.g. claude-opus-5-5):</Text>
          <Box flexDirection="row" gap={1}>
            {s.models.slots.map((slot, i) => (
              <Input
                key={`slot-${i}-custom`}
                placeholder={`${i + 1}: ${slot.model}`}
                submitLabel="Set"
                onSubmit={value => void (value.trim() && setSlot(i, { model: value.trim() }))}
              />
            ))}
          </Box>
        </Box>
      )}
      {row(
        'Max plan',
        toggle('has-max', s.models.hasMax, () => changeSettings($, x => ({ ...x, models: { ...x.models, hasMax: !x.models.hasMax } }))),
        <Text dimColor>Fable stays locked until this is on</Text>,
      )}
      {head('Modes', 'Apply to this session.')}
      {row('Fast mode', <Button key="fast-toggle" label={c.fast === null ? 'Toggle' : c.fast ? 'On ' : 'Off'} dimColor={!c.fast} onPress={() => toggleFast($)} />)}
      {row(
        'Output style',
        <Button key="style-next" label={c.outputStyle ?? 'default'} dimColor onPress={() => void setStyle($).then(t => $.ui.toast(t))} />,
      )}
      {head('You should know', 'Anthropic’s built-in side agent that flags things you or Claude might miss.')}
      {row('Side agent', toggle('ysk-toggle', c.youShouldKnow, () => setYouShouldKnow($, !c.youShouldKnow)))}
    </Box>
  )

  const timelineTab = (
    <Box flexDirection="column">
      {head('Timeline', 'One line per prompt: green done, red failed, amber stopped. Click a line to jump back.')}
      {row('On messages', toggle('marks-toggle', s.timeline.isMarked, () => changeSettings($, x => ({ ...x, timeline: { ...x.timeline, isMarked: !x.timeline.isMarked } }))), <Text dimColor>a colored rule on each message; hover for a card</Text>)}
      {row('Strip', toggle('strip-toggle', s.timeline.isStrip, () => changeSettings($, x => ({ ...x, timeline: { ...x.timeline, isStrip: !x.timeline.isStrip } }))), <Text dimColor>a tick per prompt above the prompt</Text>)}
      {row('Side panel', <Button key="timeline-open" label="Open" dimColor onPress={() => openTimeline($)} />)}
      {row(
        'AI summaries',
        toggle('summary-toggle', s.timeline.isAiSummary, () => changeSettings($, x => ({ ...x, timeline: { ...x.timeline, isAiSummary: !x.timeline.isAiSummary } }))),
        <Text dimColor>one Haiku call per prompt (uses tokens)</Text>,
      )}
    </Box>
  )

  const display = (
    <Box flexDirection="column">
      {head('Display', 'Classic: deep solid colors. Minimal: quiet tones. Terminal: the text bars, everywhere.')}
      {row('Style', <Button key="look-style" label={STYLE_LABEL[s.look.style]} onPress={() => changeSettings($, x => ({ ...x, look: { ...x.look, style: nextStyle[x.look.style] } }))} />)}
      {row(
        'Text size',
        <Button key="look-size-down" label="−" plain dimColor onPress={() => changeSettings($, x => ({ ...x, look: { ...x.look, size: stepSize(x.look.size, -1) } }))} />,
        <Text> {s.look.size.toUpperCase()} </Text>,
        <Button key="look-size-up" label="+" plain dimColor onPress={() => changeSettings($, x => ({ ...x, look: { ...x.look, size: stepSize(x.look.size, 1) } }))} />,
      )}
      {row('Answer line', <Button key="footer-mode" label={FOOTER_LABEL[s.footer]} dimColor={s.footer === 'off'} onPress={() => changeSettings($, x => ({ ...x, footer: nextFooter[x.footer] }))} />)}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {tabs}
      {tab === 'usage' ? usage : tab === 'models' ? models : tab === 'timeline' ? timelineTab : display}
    </Box>
  )
}

// The band's model control: a small track to drag, and the name, which opens
// the picker inside the band.
async function drawChip($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  const s = await read($, settings)
  if (!s.models.isShown) return null
  const c = await read($, current)
  const isOpen = await read($, isPickerOpen)
  const { Box, Button } = $.ui.resolve(e)
  const Client =
    e.surface === 'terminal' || e.surface === 'desktop'
      ? ($.ui.resolve(e) as { Client?: ElementConstructor<ClientProps> }).Client
      : undefined
  const at = activeSlot(c, s.models)
  const slot = at === null ? undefined : s.models.slots[at]
  const name = slot ? slotLabel(slot) : c.model ? modelLabel(familyOf(c.model) ?? c.model) : 'Model'
  const n = s.models.slots.length
  return (
    <Box flexDirection="row" gap={1}>
      {Client && (
        <Client
          key="model-track"
          module="./slider.tsx"
          props={{ labels: s.models.slots.map(slotLabel), locked: s.models.slots.map(x => isLocked(x, s.models)), active: at, accent: CLAUDE, compact: true }}
          width={(n - 1) * 3 + 1}
        />
      )}
      <Button
        key="model-chip"
        label={`${c.fast ? '⚡ ' : ''}${name} ${isOpen ? '⌄' : '›'}`}
        plain
        dimColor={!isOpen}
        onPress={() => update($, isPickerOpen, x => !x)}
      />
    </Box>
  )
}

// Claude's own orange: the model controls wear it in every look.
const CLAUDE = '#c96442'

// The picker as a few rows inside the band: the pill (a picture on desktop and
// mobile), a press per position, fast mode, output style, close.
async function drawInlinePicker($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  if (!(await read($, isPickerOpen))) return null
  const { Box, Text, Button } = $.ui.resolve(e)
  const s = await read($, settings)
  const c = await read($, current)
  const at = activeSlot(c, s.models)
  const slots = s.models.slots
  const locked = slots.map(x => isLocked(x, s.models))
  const Svg = e.surface === 'terminal' ? undefined : ($.ui.resolve(e) as { Svg?: ElementConstructor<SvgProps> }).Svg
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.rule} paddingX={1}>
      <Box flexDirection="row" gap={2} alignItems="center">
        {Svg && <Svg source={pill(slots.length, at, locked, CLAUDE, 0.5)} alt={`position ${at === null ? 'none' : at + 1}`} />}
        {slots.map((x, i) => (
          <Button
            key={`pick-${i}`}
            label={`${locked[i] ? '⊘ ' : ''}${slotLabel(x)}`}
            plain
            dimColor={i !== at}
            onPress={() => applySlot($, i)}
          />
        ))}
      </Box>
      <Box flexDirection="row" gap={2}>
        <Button key="picker-fast" label={c.fast ? '⚡ Fast on' : '⚡ Fast'} plain dimColor={!c.fast} onPress={() => toggleFast($)} />
        <Button key="picker-style" label={`Style: ${c.outputStyle ?? 'default'}`} plain dimColor onPress={() => void setStyle($).then(t => $.ui.toast(t))} />
        <Button key="picker-settings" label="Edit positions" plain dimColor onPress={() => update($, settingsTab, () => 'models').then(() => openSettings($))} />
        <Button key="picker-close" label="✕" plain dimColor onPress={() => update($, isPickerOpen, () => false)} />
      </Box>
    </Box>
  )
}

const statusColor = (x: Entry) => (x.status === 'ok' ? C.ok : x.status === 'error' ? C.hot : x.status === 'stopped' ? C.warn : C.accent)

const entryCard = (x: Entry, now: number) =>
  [
    x.summary ?? (x.text.length > 48 ? `${x.text.slice(0, 48)}…` : x.text),
    x.ms === null ? `running ${dur(now - x.at)}` : dur(x.ms),
    x.tools ? `${x.tools} tools` : '',
    x.errors ? `${x.errors} failed` : '',
    x.files.slice(0, 3).join(', '),
  ]
    .filter(Boolean)
    .join(' · ')

// The strip: a tick per prompt; hovering one shows its line in the band, a
// press scrolls back to it.
async function drawStrip($: EngineInterface, e: RenderInput<'AbovePrompt'>) {
  if (!(await read($, settings)).timeline.isStrip) return { ticks: null, cards: null }
  const list = (await read($, timeline)).slice(-24)
  if (!list.length) return { ticks: null, cards: null }
  const { Box, Text } = $.ui.resolve(e)
  const now = await $.clock.now()
  const ticks = (
    <Box flexDirection="row">
      {list.map(x => (
        <Text color={statusColor(x)} hover={{ scope: `tl-${x.id}`, bold: true }}>
          ▮
        </Text>
      ))}
    </Box>
  )
  const cards = (
    <Box flexDirection="column">
      {list.map(x => (
        <Box display="none" hover={{ scope: `tl-${x.id}`, display: 'flex' }} flexDirection="row">
          <Text color={statusColor(x)}>▍ </Text>
          <Text dimColor wrap="truncate">
            {clock(x.at)} {entryCard(x, now)}
          </Text>
        </Box>
      ))}
    </Box>
  )
  return { ticks, cards }
}

const PILL_FILL = '#e9b949'

// The picker: the position's name, the pill, a press per position, then fast
// mode and output style. Drag on the terminal's slider; the pill is a picture.
async function drawPicker($: EngineInterface, e: RenderInput<'Pane' | 'CommandOutput'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  await lookOf($)
  const s = await read($, settings)
  const c = await read($, current)
  const at = activeSlot(c, s.models)
  const slots = s.models.slots
  const locked = slots.map(x => isLocked(x, s.models))
  const slot = at === null ? undefined : slots[at]
  const Svg = e.surface === 'terminal' ? undefined : ($.ui.resolve(e) as { Svg?: ElementConstructor<SvgProps> }).Svg
  const Client =
    e.surface === 'terminal' ? ($.ui.resolve(e) as { Client?: ElementConstructor<ClientProps> }).Client : undefined
  const effortWord: Record<EffortName, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

  const title = (
    <Box flexDirection="row" gap={1}>
      <Text bold>{at === null ? '–' : at + 1}</Text>
      <Text bold>{slot ? modelLabel(slot.model) : c.model ?? 'Model'}</Text>
      <Text dimColor>{slot ? effortWord[slot.effort] : c.effort ?? ''}</Text>
      <Button key="picker-settings" label="›" plain dimColor onPress={() => update($, settingsTab, () => 'models').then(() => openSettings($))} />
    </Box>
  )

  const track = Client ? (
    <Client key="model-slider" module="./slider.tsx" props={{ labels: slots.map(slotLabel), locked, active: at, accent: PILL_FILL }} width={slots.length * 14} />
  ) : Svg ? (
    <Svg source={pill(slots.length, at, locked, PILL_FILL)} alt={`position ${at === null ? 'none' : at + 1} of ${slots.length}`} />
  ) : null

  const picks = !Client && (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {slots.map((x, i) => (
        <Button
          key={`pick-${i}`}
          label={`${locked[i] ? '⊘ ' : ''}${slotLabel(x)}`}
          plain
          dimColor={i !== at}
          onPress={() => applySlot($, i)}
        />
      ))}
    </Box>
  )

  const modes = (
    <Box flexDirection="row" gap={2}>
      <Button key="picker-fast" label={c.fast ? '⚡ Fast on' : '⚡ Fast'} dimColor={!c.fast} onPress={() => toggleFast($)} />
      <Button
        key="picker-style"
        label={`Style: ${c.outputStyle ?? 'default'}`}
        dimColor
        onPress={() => void setStyle($).then(t => $.ui.toast(t))}
      />
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      {title}
      {track}
      {picks}
      {modes}
    </Box>
  )
}

// The slider row: draggable on surfaces that run a `Client`, buttons elsewhere;
// then the fast mode and output style switches.
async function drawModelRow($: EngineInterface, e: RenderInput<'AbovePrompt' | 'Pane' | 'CommandOutput'>) {
  const s = await read($, settings)
  if (!s.models.isShown) return null
  const c = await read($, current)
  const { Box, Text, Button } = $.ui.resolve(e)
  const Client =
    e.surface === 'terminal' || e.surface === 'desktop'
      ? ($.ui.resolve(e) as { Client?: ElementConstructor<ClientProps> }).Client
      : undefined
  const active = activeSlot(c, s.models)
  const labels = s.models.slots.map(slotLabel)
  const locked = s.models.slots.map(x => isLocked(x, s.models))
  const room = (e.component === 'AbovePrompt' ? e.props.bodyColumns : (e.viewport?.columns ?? 80)) - 24
  const slider = Client ? (
    <Client key="model-slider" module="./slider.tsx" props={{ labels, locked, active, accent: C.accent }} width={Math.max(30, Math.min(labels.length * 14, room))} />
  ) : (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {labels.map((label, i) => (
        <Button
          key={`model-${i}`}
          label={`${locked[i] ? '⊘ ' : ''}${label}`}
          variant={i === active ? 'primary' : undefined}
          dimColor={i !== active}
          onPress={() => applySlot($, i)}
        />
      ))}
    </Box>
  )
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={1}>
      {slider}
      <Text color={C.rule}>│</Text>
      <Button key="fast" label={c.fast ? '⚡ Fast' : 'Fast'} plain dimColor={!c.fast} onPress={() => toggleFast($)} />
      <Button
        key="style"
        label={c.outputStyle && c.outputStyle !== 'default' ? c.outputStyle : 'Style'}
        plain
        dimColor
        onPress={() => void setStyle($).then(t => $.ui.toast(t))}
      />
    </Box>
  )
}

const STATUS_DOT: Record<Entry['status'], string> = { ok: '🟢', error: '🔴', stopped: '🟡', running: '⚪' }

async function timelineText($: EngineInterface) {
  const list = await read($, timeline)
  if (!list.length) return 'No prompts yet.'
  return list
    .slice(-20)
    .reverse()
    .map(x => {
      const meta = [x.ms === null ? 'running' : dur(x.ms), x.tools ? `${x.tools} tools` : '', x.errors ? `${x.errors} failed` : '', x.files.join(', ')]
        .filter(Boolean)
        .join(' · ')
      return `${STATUS_DOT[x.status]} ${clock(x.at)}  ${(x.summary ?? x.text).slice(0, 70)}\n      ${meta}`
    })
    .join('\n')
}

async function drawTimeline($: EngineInterface, e: RenderInput<'Pane' | 'CommandOutput'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  await lookOf($)
  const list = await read($, timeline)
  await read($, tick)
  const now = await $.clock.now()
  const color = (x: Entry) => (x.status === 'ok' ? C.ok : x.status === 'error' ? C.hot : x.status === 'stopped' ? C.warn : C.accent)
  if (!list.length) return <Text dimColor>No prompts yet. Each prompt you send becomes a line here.</Text>
  return (
    <Box flexDirection="column">
      {[...list]
        .reverse()
        .slice(0, 40)
        .map(x => {
          const meta = [
            clock(x.at),
            x.ms === null ? `running ${dur(now - x.at)}` : dur(x.ms),
            x.tools ? `${x.tools} tools` : '',
            x.errors ? `${x.errors} failed` : '',
            x.files.join(', '),
          ]
            .filter(Boolean)
            .join(' · ')
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Box flexDirection="row">
                <Text color={color(x)}>▍</Text>
                <Button key={`tl-${x.id}`} label={(x.summary ?? x.text).slice(0, 90)} plain onPress={() => jumpTo($, x.id)} />
              </Box>
              <Box flexDirection="row">
                <Text color={color(x)}>▍</Text>
                <Text dimColor>{meta}</Text>
              </Box>
            </Box>
          )
        })}
    </Box>
  )
}

async function drawGauge($: EngineInterface, e: RenderInput<'Pane' | 'CommandOutput'>, columns: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const m = await read($, meter)
  const l = await read($, live)
  const hist = await read($, history)
  const w = await read($, wrap)
  const s = await read($, settings)
  const collapsed = await read($, isCollapsed)
  const look = await lookOf($)
  const Svg = svgOf($, e, look.style)
  await read($, tick)
  const now = await $.clock.now()
  const width = Math.max(12, columns - 2)
  const barW = Math.max(6, Math.min(24, width - 18))
  const ctx = m ? ctxRatio(m) : 0
  const drawn = m && readings(m, ctx, now, look.style)

  const head = (title: string) => (
    <Box marginTop={1}>
      <Text color={C.accent} bold>
        {title.toUpperCase()}
      </Text>
    </Box>
  )

  const header = (
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Button
        key="fold"
        label={collapsed ? '◂ expand' : '▸ fold'}
        plain
        dimColor
        hotkey="f"
        onPress={() => toggleCollapsed($)}
      />
      <Button key="pane-settings" label="⚙ settings" plain dimColor onPress={() => openSettings($)} />
    </Box>
  )

  if (collapsed) {
    return (
      <Box flexDirection="column">
        {header}
        <Text color={tone(ctx, 0.75, 0.9)}>ctx {m?.percent ?? 0}%</Text>
        {(m?.limits ?? []).map(x => (
          <Text color={tone(x.percent / 100, 0.7, 0.9)}>
            {limitLabel(x.kind)} {x.percent}%
          </Text>
        ))}
        {l && <Text color={C.accent}>{PHASE[l.phase]}</Text>}
      </Box>
    )
  }

  // The meters: small SVG bars where the surface draws them, text elsewhere.
  const meters =
    m && drawn && Svg ? (
      <Box marginTop={1}>
        <Svg source={stack(drawn, width * 7, look)} alt={alt(drawn, m.usd)} />
      </Box>
    ) : (
      m && (
        <Box flexDirection="column">
          {head('Usage')}
          {[
            { label: 'ctx', ratio: ctx, value: `${m.percent ?? 0}%`, note: `${k(m.tokens ?? 0)}/${k(m.window)}`, warn: 0.75 },
            ...m.limits.map(x => ({
              label: limitLabel(x.kind),
              ratio: x.percent / 100,
              value: `${x.percent}%`,
              note: resetIn(x, now),
              warn: 0.7,
            })),
          ].map(r => {
            const [a, b] = bar(r.ratio, barW)
            return (
              <Box flexDirection="row">
                <Text dimColor>{r.label.padEnd(4)}</Text>
                <Text color={tone(r.ratio, r.warn, 0.9)}>{a}</Text>
                <Text color={C.rule}>{b}</Text>
                <Text color={r.ratio >= 0.9 ? C.hot : undefined}> {r.value.padStart(4)}</Text>
                <Text dimColor> {r.note}</Text>
              </Box>
            )
          })}
        </Box>
      )
    )

  const summary = m && (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        {m.usd !== undefined ? `$${m.usd.toFixed(2)} this session` : ''}
        {m.isAutoCompact && m.threshold ? ` · auto-compact at ${k(m.threshold)}` : ''}
      </Text>
      <Text dimColor>
        wrap-up 5h {ruleText(s.wrap5h)} · 7d {ruleText(s.wrap7d)} · /compact {compactText(s)}
      </Text>
    </Box>
  )

  const turnSection = l && (
    <Box flexDirection="column">
      {head('This turn')}
      <Box flexDirection="row">
        <Text color={C.accent}>{PHASE[l.phase]} </Text>
        <Text>{dur(now - l.phaseSince)}</Text>
        <Text>  </Text>
        <Button key="pane-stop" label="■ Stop" hotkey="s" onPress={() => stopTurn($)} />
      </Box>
      <Text dimColor>
        total {dur(now - l.startedAt)} · think {dur(l.thinkMs + (l.phase === 'thinking' ? now - l.phaseSince : 0))} · write{' '}
        {dur(l.respondMs + (l.phase === 'responding' ? now - l.phaseSince : 0))} · tools{' '}
        {dur(l.toolMs + (l.phase === 'tool' ? now - l.phaseSince : 0))}
      </Text>
      <Text dimColor>
        {k(l.outTokens)} out{l.genMs > 500 ? ` · ${Math.round(l.outTokens / (l.genMs / 1000))} tok/s` : ''}
      </Text>
      {l.tools.slice(-8).map(t => {
        const ms = t.ms ?? now - t.startedAt
        return (
          <Box flexDirection="row">
            <Text color={t.ms === null ? C.accent : t.isError ? C.hot : C.ok}>
              {t.ms === null ? '◌ ' : t.isError ? '✕ ' : '✓ '}
            </Text>
            <Text dimColor wrap="truncate">
              {t.name.replace(/^mcp__/, '').slice(0, 18).padEnd(18)}
            </Text>
            <Text dimColor> {dur(ms)}</Text>
          </Box>
        )
      })}
    </Box>
  )

  // Plain numbers: block-glyph sparklines smear together in proportional UI fonts.
  const recent = hist.slice(-5).reverse()
  const historySection = recent.length > 0 && (
    <Box flexDirection="column">
      {head('Recent turns')}
      {recent.map((r, i) => (
        <Box flexDirection="row">
          <Text color={i === 0 ? undefined : C.rule}>{i === 0 ? '● ' : '○ '}</Text>
          <Text>{dur(r.ms)}</Text>
          <Text dimColor>
            {r.thinkMs ? ` · think ${dur(r.thinkMs)}` : ''}
            {r.tps ? ` · ${r.tps} tok/s` : ''}
            {r.tools ? ` · ${r.tools} tools` : ''}
            {r.isAborted ? ' · stopped' : ''}
          </Text>
        </Box>
      ))}
    </Box>
  )

  // Name, then its tokens and share of the window, on one line: a right-aligned
  // column does not survive surfaces that lay text out in proportional fonts.
  const breakdown = m && m.categories.length > 0 && (
    <Box flexDirection="column">
      {head('Context breakdown')}
      {[...m.categories]
        .filter(c => !/free space/i.test(c.name))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 8)
        .map(c => (
          <Box flexDirection="row">
            <Text dimColor>{c.name}  </Text>
            <Text>{k(c.tokens)}</Text>
            <Text dimColor> · {Math.max(0.1, Math.round((c.tokens / m.window) * 1000) / 10)}%</Text>
          </Box>
        ))}
    </Box>
  )

  const pendingRow = w.pending && (
    <Box flexDirection="row" marginTop={1}>
      <Text color={C.hot}>wrap-up in {dur(w.pending.deadline - now)} </Text>
      <Button key="pane-wrap-cancel" label="Cancel" onPress={() => cancelWrap($)} />
    </Box>
  )

  const modelRow = e.surface === 'mobile' || e.surface === 'vscode' ? await drawModelRow($, e) : null

  return (
    <Box flexDirection="column">
      {header}
      {modelRow}
      {meters}
      {summary}
      {pendingRow}
      {turnSection}
      {historySection}
      {breakdown}
    </Box>
  )
}

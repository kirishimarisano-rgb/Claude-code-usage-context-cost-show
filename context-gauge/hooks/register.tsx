import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, RenderInput, SessionRateLimit, SvgProps, Timer } from 'claude-code'

import { alt, PALETTE, readings, stack, strip } from './svg'
import type { CompactMode, FooterMode, GaugeSettings, Limit, Live, Look, LookStyle, Meter, Phase, ToolRow, TurnRow, WrapRule } from '../types'

const PANE = 'gauge'
const SETTINGS_PANE = 'gauge-settings'

const DEFAULTS: GaugeSettings = {
  wrap5h: { isOn: false, at: 90 },
  wrap7d: { isOn: false, at: 95 },
  compact: { mode: 'remind', at: 70 },
  footer: 'auto',
  look: { style: 'classic', size: 'm' },
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
  accent: style === 'classic' ? '#c96442' : '#a39bd6',
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

const SPARK = '▁▂▃▄▅▆▇█'
const spark = (values: number[]) => {
  const max = Math.max(1, ...values)
  return values.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
}

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
const STYLE_LABEL: Record<LookStyle, string> = { classic: 'Classic', minimal: 'Minimal' }
const SIZES: Look['size'][] = ['s', 'm', 'l']
const stepSize = (size: Look['size'], d: number) => SIZES[Math.max(0, Math.min(2, SIZES.indexOf(size) + d))]!

const clampPct = (n: number) => Math.max(30, Math.min(100, Math.round(n)))

// The surface's `Svg`, where it draws one (every surface but the terminal).
const svgOf = ($: EngineInterface, e: RenderInput) =>
  e.surface === 'terminal' ? undefined : ($.ui.resolve(e) as { Svg?: ElementConstructor<SvgProps> }).Svg

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
  '/gauge look classic|minimal  display style',
  '/gauge size s|m|l          text size',
].join('\n')

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gauge',
      description: 'Usage gauge; `pane`, `settings`, `wrap 5h|7d <percent|on|off>`, `compact <percent|remind|auto|off>`',
      argumentHint: '[pane | settings | wrap 5h|7d … | compact … | footer …]',
    })
    await loadSettings($)
    await update($, wrap, w => ({ ...w, pending: null }))
    const collapsed = await $.store.get('isCollapsed')
    if (typeof collapsed === 'boolean') await update($, isCollapsed, () => collapsed)
    await refreshBreakdown($)

    return next(e)
  })

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
    if (sub === 'look' && (a === 'classic' || a === 'minimal')) {
      await changeSettings($, x => ({ ...x, look: { ...x.look, style: a } }))
      return { text: `Display style: ${a}.` }
    }
    if (sub === 'size' && (a === 's' || a === 'm' || a === 'l')) {
      await changeSettings($, x => ({ ...x, look: { ...x.look, size: a } }))
      return { text: `Text size: ${a.toUpperCase()}.` }
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

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
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
    const Svg = svgOf($, e)
    const sep = <Text color={C.rule}>  ·  </Text>

    const ctx = m ? ctxRatio(m) : 0
    const ctxColor = tone(ctx, 0.75, 0.9)
    const [on1, off1] = bar(ctx, isNarrow ? 8 : 14)
    const limits = (m?.limits ?? []).filter(x => !isNarrow || x.kind === 'five_hour')
    const drawn = m && readings(m, ctx, now, look.style)

    const gear = <Button key="settings" label="⚙" plain dimColor onPress={() => openSettings($)} />

    const meterRow =
      m && drawn && Svg ? (
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Svg source={strip(drawn, m.usd, look)} alt={alt(drawn, m.usd)} />
          {gear}
        </Box>
      ) : (
        m && (
          <Box flexDirection="row" flexWrap="wrap">
            <Text dimColor>ctx </Text>
            <Text color={ctxColor}>{on1}</Text>
            <Text color={C.rule}>{off1}</Text>
            <Text color={ctx >= 0.9 ? C.hot : undefined}> {m.percent ?? 0}%</Text>
            {!isNarrow && m.tokens !== undefined && (
              <Text dimColor>
                {' '}
                {k(m.tokens)}/{k(m.isAutoCompact && m.threshold ? m.threshold : m.window)}
              </Text>
            )}
            {ctx >= 0.9 && <Text color={C.hot}> compacts soon</Text>}
            {limits.map(x => {
              const c = tone(x.percent / 100, 0.7, 0.9)
              const [a, b] = bar(x.percent / 100, 6)
              return (
                <Box flexDirection="row">
                  {sep}
                  <Text dimColor>{limitLabel(x.kind)} </Text>
                  <Text color={c}>{a}</Text>
                  <Text color={C.rule}>{b}</Text>
                  <Text color={x.percent >= 90 ? C.hot : undefined}> {x.percent}%</Text>
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

    return (
      <Box flexDirection="column">
        {wrapRow}
        {meterRow}
        {liveRow}
      </Box>
    )
  })

  // ---------- panes, and the /gauge rows in the transcript ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawGauge($, e, e.props.bodyColumns))
  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, ($, e) => drawSettings($, e))

  // The /gauge rows draw live in the transcript on every client that draws
  // plugin trees: the mobile app draws no band and places no pane.
  on('ui.render', { component: 'CommandOutput', props: { command: 'gauge' } }, ($, e, next) => {
    const sub = e.props.args.trim().toLowerCase()
    if (sub === '') return drawGauge($, e, e.viewport?.columns ?? 60)
    if (sub === 'settings') return drawSettings($, e)
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
  await lookOf($)
  const s = await read($, settings)
  const auto = autoCompactPercent(await read($, meter))

  const head = (title: string, note: string) => (
    <Box flexDirection="column" marginTop={1}>
      <Text color={C.accent} bold>
        {title}
      </Text>
      <Text dimColor>{note}</Text>
    </Box>
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
    return (
      <Box flexDirection="row" gap={1}>
        <Text>{label.padEnd(14)}</Text>
        <Button
          key={`${which}-toggle`}
          label={r.isOn ? 'On ' : 'Off'}
          dimColor={!r.isOn}
          onPress={() => changeSettings($, setRule(which, { isOn: !r.isOn }))}
        />
        <Text dimColor>at</Text>
        {stepper(which, r.at, d => void changeSettings($, setRule(which, { at: r.at + d })), r.isOn)}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {head('Auto wrap-up', 'A note into the running task: finish the step, save, hand off.')}
      {ruleRow('wrap5h', '5-hour limit')}
      {ruleRow('wrap7d', 'Weekly limit')}
      {head('Context', `When to /compact${auto ? ` (Claude auto-compacts at ${auto}%)` : ''}. Auto runs only while idle.`)}
      <Box flexDirection="row" gap={1}>
        <Text>{'/compact'.padEnd(14)}</Text>
        <Button
          key="compact-mode"
          label={COMPACT_LABEL[s.compact.mode].padEnd(6)}
          dimColor={s.compact.mode === 'off'}
          onPress={() => changeSettings($, x => ({ ...x, compact: { ...x.compact, mode: nextCompact[x.compact.mode] } }))}
        />
        <Text dimColor>at</Text>
        {stepper(
          'compact',
          s.compact.at,
          d => void changeSettings($, x => ({ ...x, compact: { ...x.compact, at: clampPct(x.compact.at + d) } })),
          s.compact.mode !== 'off',
        )}
      </Box>
      {head('Display', 'Classic: deep solid colors. Minimal: quiet tones, small caps.')}
      <Box flexDirection="row" gap={1}>
        <Text>{'Style'.padEnd(14)}</Text>
        <Button
          key="look-style"
          label={STYLE_LABEL[s.look.style]}
          onPress={() =>
            changeSettings($, x => ({ ...x, look: { ...x.look, style: x.look.style === 'classic' ? 'minimal' : 'classic' } }))
          }
        />
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text>{'Text size'.padEnd(14)}</Text>
        <Button
          key="look-size-down"
          label="−"
          plain
          dimColor
          onPress={() => changeSettings($, x => ({ ...x, look: { ...x.look, size: stepSize(x.look.size, -1) } }))}
        />
        <Text> {s.look.size.toUpperCase()} </Text>
        <Button
          key="look-size-up"
          label="+"
          plain
          dimColor
          onPress={() => changeSettings($, x => ({ ...x, look: { ...x.look, size: stepSize(x.look.size, 1) } }))}
        />
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text>{'Answer line'.padEnd(14)}</Text>
        <Button
          key="footer-mode"
          label={FOOTER_LABEL[s.footer]}
          dimColor={s.footer === 'off'}
          onPress={() => changeSettings($, x => ({ ...x, footer: nextFooter[x.footer] }))}
        />
      </Box>
    </Box>
  )
}

async function drawGauge($: EngineInterface, e: RenderInput<'Pane' | 'CommandOutput'>, columns: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const Svg = svgOf($, e)
  const m = await read($, meter)
  const l = await read($, live)
  const hist = await read($, history)
  const w = await read($, wrap)
  const s = await read($, settings)
  const collapsed = await read($, isCollapsed)
  const look = await lookOf($)
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

  const recent = hist.slice(-12)
  const historySection = recent.length > 1 && (
    <Box flexDirection="column">
      {head('Recent turns')}
      <Box flexDirection="row">
        <Text dimColor>{'time'.padEnd(6)}</Text>
        <Text color={C.accent}>{spark(recent.map(r => r.ms))}</Text>
        <Text dimColor> last {dur(recent[recent.length - 1]!.ms)}</Text>
      </Box>
      <Box flexDirection="row">
        <Text dimColor>{'tok/s'.padEnd(6)}</Text>
        <Text color={C.accent}>{spark(recent.map(r => r.tps ?? 0))}</Text>
        <Text dimColor> last {recent[recent.length - 1]!.tps ?? '—'}</Text>
      </Box>
    </Box>
  )

  const breakdown = m && m.categories.length > 0 && (
    <Box flexDirection="column">
      {head('Context breakdown')}
      {m.categories.slice(0, 8).map(c => (
        <Box flexDirection="row" justifyContent="space-between" width={width}>
          <Text dimColor wrap="truncate">
            {c.name}
          </Text>
          <Text dimColor>{k(c.tokens)}</Text>
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

  return (
    <Box flexDirection="column">
      {header}
      {meters}
      {summary}
      {pendingRow}
      {turnSection}
      {historySection}
      {breakdown}
    </Box>
  )
}

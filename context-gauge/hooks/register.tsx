import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, RenderInput, SessionRateLimit, SvgProps, Timer } from 'claude-code'

import { alt, readings, rings, strip } from './svg'
import type { FooterMode, Limit, Live, Meter, Phase, ToolRow, TurnRow, Wrap } from '../types'

const P = 'context-gauge'
const PANE = 'gauge'

const meter = atom({ plugin: 'context-gauge', key: 'meter' } as const, null)
const live = atom({ plugin: 'context-gauge', key: 'live' } as const, null)
const history = atom({ plugin: 'context-gauge', key: 'history' } as const, [])
const isCollapsed = atom({ plugin: 'context-gauge', key: 'isCollapsed' } as const, false)
const wrap = atom({ plugin: 'context-gauge', key: 'wrap' } as const, {
  isOn: false,
  atPercent: 90,
  pending: null,
  fired: [],
} as Wrap)
const tick = atom({ plugin: 'context-gauge', key: 'tick' } as const, 0)
// `auto`: a gauge line under each answer when no client draws the band
// (a cloud session seen from the web, desktop or mobile app).
const footer = atom({ plugin: 'context-gauge', key: 'footer' } as const, 'auto' as FooterMode)

const WRAP_DELAY_MS = 10_000
const NOTIFY_AFTER_MS = 20_000
const WRAP_PROMPT = [
  '[context-gauge] The usage limit is almost reached.',
  'Stop starting new work now. Finish only the step in progress, then wrap up:',
  '1. Leave the code in a working state; save or commit what is done if the task allows it.',
  '2. Write a short handoff: what was done, what is left, and the exact next step.',
  'Keep it brief.',
].join('\n')

// Palette: muted, one accent. Hex strings work on the terminal and the desktop.
const C = {
  ok: '#7fb685',
  warn: '#e0b05c',
  hot: '#e06c6c',
  accent: '#9a8cf0',
  rule: '#5c5f66',
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

const blocks = (ratio: number, width: number) => bar(ratio, width, '▰', '▱')

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

// How close the context is to the point auto-compaction runs. Red from 90%
// of that point; when auto-compaction is off, measured against the window.
const ctxRatio = (m: Meter) => {
  const limit = m.isAutoCompact && m.threshold ? m.threshold : m.window
  return m.tokens === undefined ? 0 : m.tokens / limit
}

const PHASE: Record<Phase, string> = {
  waiting: '◌ waiting',
  thinking: '◐ thinking',
  responding: '◑ writing',
  tool: '⚙ tools',
}

// The surface's `Svg`, where it draws one (every surface but the terminal).
const svgOf = ($: EngineInterface, e: RenderInput) =>
  e.surface === 'terminal' ? undefined : ($.ui.resolve(e) as { Svg?: ElementConstructor<SvgProps> }).Svg

// ---------- plumbing ----------

let ticker: Timer | null = null
let wrapTimer: Timer | null = null

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

async function checkWrap($: EngineInterface, limits: readonly SessionRateLimit[]) {
  const w = await read($, wrap)
  // Only while a task runs: idle, there is nothing to wrap up, and the one
  // chance per limit window is kept for the next task.
  if (!w.isOn || w.pending || !(await read($, live))) return
  const hit = limits.find(
    l => (l.kind === 'five_hour' || l.kind === 'seven_day') && l.percentUsed >= w.atPercent,
  )
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

async function stopTurn($: EngineInterface) {
  const l = await read($, live)
  if (l) await $.turn.abort({ turnId: l.turnId })
}

async function setWrap($: EngineInterface, change: Partial<Wrap>) {
  const next = await update($, wrap, w => ({ ...w, ...change }))
  await $.store.set('wrap', { isOn: next.isOn, atPercent: next.atPercent })
  if (next.isOn) {
    const u = await $.session.usage()
    await checkWrap($, u.rateLimits)
  } else {
    await cancelWrap($)
  }
}

async function toggleCollapsed($: EngineInterface) {
  const v = await update($, isCollapsed, c => !c)
  await $.store.set('isCollapsed', v)
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gauge',
      description: 'Context gauge in the transcript; `pane` for the side pane, `footer on|off|auto`, `wrap on|off|<percent>`',
      argumentHint: '[pane | footer on|off|auto | wrap on|off|<percent>]',
    })
    const saved = (await $.store.get('wrap')) as Partial<Wrap> | undefined
    await update($, wrap, w => ({
      ...w,
      isOn: saved?.isOn ?? w.isOn,
      atPercent: saved?.atPercent ?? w.atPercent,
      pending: null,
    }))
    const savedFooter = await $.store.get('footer')
    if (savedFooter === 'on' || savedFooter === 'off' || savedFooter === 'auto') await update($, footer, () => savedFooter)
    const collapsed = await $.store.get('isCollapsed')
    if (typeof collapsed === 'boolean') await update($, isCollapsed, () => collapsed)
    await refreshBreakdown($)

    return next(e)
  })

  on('command.run', { command: 'gauge' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (sub === 'wrap') {
      if (arg === 'on' || arg === 'off') {
        await setWrap($, { isOn: arg === 'on' })
        return { text: `Auto wrap-up ${arg}.` }
      }
      const pct = Number(arg)
      if (pct >= 50 && pct <= 100) {
        await setWrap($, { atPercent: pct })
        return { text: `Auto wrap-up threshold: ${pct}%.` }
      }
      const w = await read($, wrap)
      return { text: `Auto wrap-up is ${w.isOn ? 'on' : 'off'} at ${w.atPercent}%. Use /gauge wrap on|off|<50-100>.` }
    }
    if (sub === 'footer') {
      if (arg === 'on' || arg === 'off' || arg === 'auto') {
        await update($, footer, () => arg)
        await $.store.set('footer', arg)
        return { text: `Gauge line under each answer: ${arg}.` }
      }
      return { text: `Gauge line under each answer: ${await read($, footer)}. Use /gauge footer on|off|auto.` }
    }
    if (sub === 'pane') {
      const opened = await $.ui.open({ id: PANE, title: 'Gauge' })
      return { text: opened.isPlaced ? 'Gauge pane opened.' : `Gauge pane waits: ${opened.reason}` }
    }
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
      const mode = await read($, footer)
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
    const now = await $.clock.now()
    const cols = e.props.bodyColumns
    const isNarrow = cols < 90
    const { Box, Text, Button } = $.ui.resolve(e)
    const sep = <Text color={C.rule}> │ </Text>

    const ctx = m ? ctxRatio(m) : 0
    const ctxColor = tone(ctx, 0.75, 0.9)
    const [on1, off1] = bar(ctx, isNarrow ? 8 : 16)
    const limits = (m?.limits ?? []).filter(x => !isNarrow || x.kind === 'five_hour')

    const Svg = svgOf($, e)
    const drawn = m && readings(m, ctx, now)
    const meterRow = m && drawn && Svg ? (
      <Svg source={strip(drawn, m.usd)} alt={alt(drawn, m.usd)} />
    ) : m && (
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
        {ctx >= 0.9 && <Text color={C.hot}> ⚠ auto-compact soon</Text>}
        {limits.map(x => {
          const c = tone(x.percent / 100, 0.7, 0.9)
          const [a, b] = blocks(x.percent / 100, 5)
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
      </Box>
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
        <Text dimColor>turn </Text>
        <Text>{dur(now - l.startedAt)}</Text>
        {thinkTotal > 0 && <Text dimColor> · think {dur(thinkTotal)}</Text>}
        {tps !== null && <Text dimColor> · {tps} tok/s</Text>}
        {running && <Text dimColor> · ⚙ {running.name} {dur(now - running.startedAt)}</Text>}
        <Text> </Text>
        <Button key="stop" label="■ Stop" hotkey="s" onPress={() => stopTurn($)} />
        <Text> </Text>
        <Button key="pane" label="▸ Panel" dimColor onPress={() => $.ui.open({ id: PANE, title: 'Gauge' })} />
      </Box>
    )

    const wrapRow = w.pending && (
      <Box flexDirection="row" flexWrap="wrap">
        <Text color={C.hot}>⚠ {w.pending.label} </Text>
        <Text>wrap-up prompt in {dur(w.pending.deadline - now)} </Text>
        <Button key="wrap-cancel" label="Cancel" hotkey="c" onPress={() => cancelWrap($)} />
        <Text> </Text>
        <Button key="wrap-now" label="Send now" variant="primary" onPress={() => fireWrap($)} />
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

  // ---------- side pane, and the /gauge row where no pane is placed ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawGauge($, e, e.props.bodyColumns))

  // The /gauge row in the transcript is the live gauge itself, on every
  // client: the mobile app draws no band and places no pane.
  on('ui.render', { component: 'CommandOutput', props: { command: 'gauge' } }, ($, e, next) =>
    e.props.args.trim() !== '' ? next(e) : drawGauge($, e, e.viewport?.columns ?? 60),
  )
}

const DOT = (ratio: number, warnAt: number, hotAt: number) => (ratio >= hotAt ? '🔴' : ratio >= warnAt ? '🟡' : '🟢')

async function footerLine($: EngineInterface, row: TurnRow) {
  const m = await read($, meter)
  const now = await $.clock.now()
  const parts: string[] = []
  if (m) {
    const r = ctxRatio(m)
    parts.push(`${DOT(r, 0.75, 0.9)} ctx ${m.percent ?? 0}%` + (r >= 0.9 ? ' auto-compact soon' : ''))
    for (const x of m.limits) {
      parts.push(`${DOT(x.percent / 100, 0.7, 0.9)} ${limitLabel(x.kind)} ${x.percent}% ${resetIn(x, now)}`.trim())
    }
    if (m.usd !== undefined) parts.push(`$${m.usd.toFixed(2)}`)
  }
  parts.push(`⏱ ${dur(row.ms)}` + (row.thinkMs ? ` (think ${dur(row.thinkMs)})` : ''))
  if (row.tools) parts.push(`${row.tools} tools`)
  if (row.tps) parts.push(`${row.tps} tok/s`)
  return parts.join('  ·  ')
}

async function snapshot($: EngineInterface) {
  const m = await read($, meter)
  const l = await read($, live)
  const w = await read($, wrap)
  const now = await $.clock.now()
  const rows: string[] = []
  const line = (dot: string, label: string, ratio: number, value: string, note: string) => {
    const [a, b] = bar(ratio, 14, '█', '░')
    rows.push(`${dot} ${label.padEnd(7)} ${a}${b} ${value.padStart(4)}  ${note}`.trimEnd())
  }
  if (m) {
    const r = ctxRatio(m)
    const limit = m.isAutoCompact && m.threshold ? m.threshold : m.window
    line(DOT(r, 0.75, 0.9), 'CONTEXT', r, `${m.percent ?? 0}%`, r >= 0.9 ? 'auto-compact soon' : `${k(m.tokens ?? 0)} / ${k(limit)}`)
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
  const foot = `auto wrap-up ${w.isOn ? `on at ${w.atPercent}%` : 'off'} · clients: ${surfaces.join(', ') || 'none'}`
  return '```\n' + rows.join('\n') + '\n```\n' + foot
}

async function drawGauge($: EngineInterface, e: RenderInput<'Pane' | 'CommandOutput'>, columns: number) {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, meter)
    const l = await read($, live)
    const hist = await read($, history)
    const w = await read($, wrap)
    const collapsed = await read($, isCollapsed)
    await read($, tick)
    const now = await $.clock.now()
    const width = Math.max(12, columns - 2)
    const barW = Math.max(6, Math.min(30, width - 16))
    const ctx = m ? ctxRatio(m) : 0

    const head = (title: string) => (
      <Box marginTop={1}>
        <Text color={C.accent} bold>
          {title.toUpperCase()}
        </Text>
      </Box>
    )

    const toggle = (
      <Button
        key="fold"
        label={collapsed ? '◂ expand' : '▸ fold'}
        plain
        dimColor
        hotkey="f"
        onPress={() => toggleCollapsed($)}
      />
    )

    if (collapsed) {
      return (
        <Box flexDirection="column">
          {toggle}
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

    const Svg = svgOf($, e)
    const drawn = m && readings(m, ctx, now)
    const hero =
      m && drawn && Svg ? (
        <Svg
          source={rings(drawn, m.usd, l ? `${PHASE[l.phase]} ${dur(now - l.phaseSince)}` : null)}
          alt={alt(drawn, m.usd)}
        />
      ) : null

    const [c1, c2] = bar(ctx, barW)
    const ctxSection = m && hero ? (
      <Box flexDirection="column">
        {head('Context')}
        <Text dimColor>
          {k(m.tokens ?? 0)} of {k(m.window)}
          {m.isAutoCompact && m.threshold ? ` · auto-compact at ${k(m.threshold)}` : ' · auto-compact off'}
        </Text>
        {m.categories.slice(0, 8).map(c => (
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Text dimColor wrap="truncate">
              {c.name}
            </Text>
            <Text dimColor>{k(c.tokens)}</Text>
          </Box>
        ))}
      </Box>
    ) : m && (
      <Box flexDirection="column">
        {head('Context')}
        <Box flexDirection="row">
          <Text color={tone(ctx, 0.75, 0.9)}>{c1}</Text>
          <Text color={C.rule}>{c2}</Text>
          <Text bold color={tone(ctx, 0.75, 0.9)}>
            {' '}
            {m.percent ?? 0}%
          </Text>
        </Box>
        <Text dimColor>
          {k(m.tokens ?? 0)} of {k(m.window)}
          {m.isAutoCompact && m.threshold ? ` · auto-compact at ${k(m.threshold)}` : ' · auto-compact off'}
        </Text>
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

    const limitSection = !hero && m && m.limits.length > 0 && (
      <Box flexDirection="column">
        {head('Usage limits')}
        {m.limits.map(x => {
          const [a, b] = blocks(x.percent / 100, Math.min(20, barW))
          const c = tone(x.percent / 100, 0.7, 0.9)
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text>{limitLabel(x.kind).padEnd(6)}</Text>
                <Text color={c}>{a}</Text>
                <Text color={C.rule}>{b}</Text>
                <Text color={c}> {x.percent}%</Text>
              </Box>
              <Text dimColor>      resets in {resetIn(x, now).slice(1) || '—'}</Text>
            </Box>
          )
        })}
        {m.usd !== undefined && <Text dimColor>session cost ${m.usd.toFixed(2)}</Text>}
      </Box>
    )

    const turnSection = l && (
      <Box flexDirection="column">
        {head('This turn')}
        <Box flexDirection="row">
          <Text color={C.accent}>{PHASE[l.phase]} </Text>
          <Text>{dur(now - l.phaseSince)}</Text>
          <Text> </Text>
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
        {head('Tools')}
        {l.tools.length === 0 && <Text dimColor>none yet</Text>}
        {l.tools.slice(-10).map(t => {
          const ms = t.ms ?? now - t.startedAt
          const longest = Math.max(1000, ...l.tools.map(x => x.ms ?? now - x.startedAt))
          const [a] = bar(ms / longest, Math.max(4, Math.min(12, width - 26)), '▬', ' ')
          return (
            <Box flexDirection="row">
              <Text color={t.ms === null ? C.accent : t.isError ? C.hot : C.ok}>
                {t.ms === null ? '◌ ' : t.isError ? '✕ ' : '✓ '}
              </Text>
              <Text wrap="truncate">{t.name.replace(/^mcp__/, '').slice(0, 14).padEnd(14)} </Text>
              <Text color={C.rule}>{a}</Text>
              <Text dimColor> {dur(ms)}</Text>
            </Box>
          )
        })}
      </Box>
    )

    const recent = hist.slice(-10)
    const historySection = recent.length > 0 && (
      <Box flexDirection="column">
        {head('Recent turns')}
        <Box flexDirection="row">
          <Text dimColor>time  </Text>
          <Text color={C.accent}>{spark(recent.map(r => r.ms))}</Text>
          <Text dimColor> last {dur(recent[recent.length - 1]!.ms)}</Text>
        </Box>
        <Box flexDirection="row">
          <Text dimColor>think </Text>
          <Text color={C.accent}>{spark(recent.map(r => r.thinkMs))}</Text>
        </Box>
        <Box flexDirection="row">
          <Text dimColor>tok/s </Text>
          <Text color={C.accent}>{spark(recent.map(r => r.tps ?? 0))}</Text>
          <Text dimColor> last {recent[recent.length - 1]!.tps ?? '—'}</Text>
        </Box>
      </Box>
    )

    const wrapSection = (
      <Box flexDirection="column">
        {head('Auto wrap-up')}
        <Box flexDirection="row">
          <Text dimColor>{w.isOn ? `on · at ${w.atPercent}% of 5h/7d ` : 'off '}</Text>
          <Button
            key="wrap-toggle"
            label={w.isOn ? 'Turn off' : 'Turn on'}
            dimColor
            hotkey="w"
            onPress={() => setWrap($, { isOn: !w.isOn })}
          />
        </Box>
        {w.pending && (
          <Box flexDirection="row">
            <Text color={C.hot}>sending in {dur(w.pending.deadline - now)} </Text>
            <Button key="pane-wrap-cancel" label="Cancel" onPress={() => cancelWrap($)} />
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {toggle}
        {hero}
        {ctxSection}
        {limitSection}
        {turnSection}
        {historySection}
        {wrapSection}
      </Box>
    )
}

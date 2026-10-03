// SVG drawings for the surfaces that draw `Svg` (desktop, mobile, VS Code).
// Pure string builders: no `$`, no state.

import type { Limit, Meter } from '../types'

export type Reading = {
  key: string
  label: string
  ratio: number | null
  value: string
  sub: string
  isHot: boolean
}

const TONE = { ok: '#7fb685', warn: '#e0b05c', hot: '#e06c6c' }
const LIGHT = { ok: '#a8d8ad', warn: '#f2cf8a', hot: '#f29a9a' }

const toneOf = (ratio: number, warnAt: number, hotAt: number) =>
  ratio >= hotAt ? 'hot' : ratio >= warnAt ? 'warn' : 'ok'

const STYLE = `
  <style>
    text { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums; }
    .label { fill: #8b919c; font-size: 10px; letter-spacing: 0.09em; font-weight: 600; }
    .value { fill: #e8eaee; font-size: 13px; font-weight: 650; }
    .big { fill: #e8eaee; font-size: 19px; font-weight: 700; }
    .sub { fill: #8b919c; font-size: 10.5px; }
    .track { fill: none; stroke: rgba(140, 146, 158, 0.2); }
    .trackbar { fill: rgba(140, 146, 158, 0.2); }
    .ringlabel { font-size: 8.5px; letter-spacing: 0.06em; }
    @media (prefers-color-scheme: light) {
      .value, .big { fill: #1f2328; }
      .label, .sub { fill: #656d76; }
    }
    .sub.hotsub { fill: ${TONE.hot}; }
  </style>`

const gradients = () =>
  (['ok', 'warn', 'hot'] as const)
    .map(
      t => `<linearGradient id="g-${t}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${LIGHT[t]}"/><stop offset="1" stop-color="${TONE[t]}"/></linearGradient>`,
    )
    .join('') +
  `<filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
     <feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
   </filter>`

const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const resets = (l: Limit, now: number) => {
  const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  return Number.isNaN(at) ? '' : `resets in ${dur(at - now)}`
}

// The readings both drawings show: context, each limit window, cost.
export function readings(m: Meter, ctxRatio: number, now: number): Reading[] {
  const limit = m.isAutoCompact && m.threshold ? m.threshold : m.window
  const out: Reading[] = [
    {
      key: 'ctx',
      label: 'CONTEXT',
      ratio: ctxRatio,
      value: `${m.percent ?? 0}%`,
      sub: ctxRatio >= 0.9 ? 'auto-compact soon' : `${k(m.tokens ?? 0)} / ${k(limit)}`,
      isHot: ctxRatio >= 0.9,
    },
  ]
  for (const kind of ['five_hour', 'seven_day']) {
    const l = m.limits.find(x => x.kind === kind)
    const label = kind === 'five_hour' ? '5 HOUR' : '7 DAY'
    out.push(
      l
        ? {
            key: kind,
            label,
            ratio: l.percent / 100,
            value: `${l.percent}%`,
            sub: resets(l, now),
            isHot: l.percent >= 90,
          }
        : { key: kind, label, ratio: null, value: '—', sub: 'after first reply', isHot: false },
    )
  }
  return out
}

const tones = (r: Reading) => (r.key === 'ctx' ? toneOf(r.ratio ?? 0, 0.75, 0.9) : toneOf(r.ratio ?? 0, 0.7, 0.9))

// A slim strip for the band above the prompt.
export function strip(rs: Reading[], usd: number | undefined): string {
  const widths = [250, 180, 180]
  const gap = 28
  let x = 0
  const parts: string[] = []
  rs.forEach((r, i) => {
    const w = widths[i] ?? 180
    const t = tones(r)
    const fill = r.ratio === null ? 0 : Math.max(0, Math.min(1, r.ratio)) * w
    parts.push(`
      <g transform="translate(${x},0)">
        <text class="label" x="0" y="13">${r.label}</text>
        <text class="value" x="${w}" y="14" text-anchor="end" ${r.isHot ? `style="fill:${TONE.hot}"` : ''}>${r.value}</text>
        <rect class="trackbar" x="0" y="21" width="${w}" height="5" rx="2.5"/>
        ${fill > 0 ? `<rect x="0" y="21" width="${Math.max(5, fill)}" height="5" rx="2.5" fill="url(#g-${t})" ${r.isHot ? 'filter="url(#glow)"' : ''}/>` : ''}
        <text class="sub${r.isHot ? ' hotsub' : ''}" x="0" y="40">${r.sub}</text>
      </g>`)
    x += w + gap
  })
  if (usd !== undefined) {
    parts.push(`
      <g transform="translate(${x},0)">
        <text class="label" x="0" y="13">COST</text>
        <text class="value" x="0" y="31" style="font-size:16px">$${usd.toFixed(2)}</text>
        <text class="sub" x="0" y="40"></text>
      </g>`)
    x += 80
  }
  const width = x
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="44" viewBox="0 0 ${width} 44">
    ${STYLE}<defs>${gradients()}</defs>${parts.join('')}</svg>`
}

// Three ring gauges for the pane and the /gauge row.
export function rings(rs: Reading[], usd: number | undefined, phase: string | null): string {
  const r = 36
  const c = 2 * Math.PI * r
  const step = 112
  const width = step * rs.length
  const height = 150
  const parts = rs.map((g, i) => {
    const cx = step * i + step / 2
    const cy = 52
    const t = tones(g)
    const len = g.ratio === null ? 0 : Math.max(0, Math.min(1, g.ratio)) * c
    return `
      <g>
        <circle class="track" cx="${cx}" cy="${cy}" r="${r}" stroke-width="7"/>
        ${len > 0 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#g-${t})" stroke-width="7" stroke-linecap="round"
          stroke-dasharray="${len.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})" ${g.isHot ? 'filter="url(#glow)"' : ''}/>` : ''}
        <text class="big" x="${cx}" y="${cy + 3}" text-anchor="middle" ${g.isHot ? `style="fill:${TONE.hot}"` : ''}>${g.value}</text>
        <text class="label ringlabel" x="${cx}" y="${cy + 16}" text-anchor="middle">${g.label}</text>
        <text class="sub${g.isHot ? ' hotsub' : ''}" x="${cx}" y="${cy + r + 22}" text-anchor="middle">${g.sub}</text>
      </g>`
  })
  const foot = [usd !== undefined ? `$${usd.toFixed(2)} this session` : '', phase ?? ''].filter(Boolean).join('   ·   ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${STYLE}<defs>${gradients()}</defs>${parts.join('')}
    <text class="sub" x="${width / 2}" y="${height - 8}" text-anchor="middle">${foot}</text></svg>`
}

export const alt = (rs: Reading[], usd: number | undefined) =>
  rs.map(r => `${r.label.toLowerCase()} ${r.value}${r.sub ? ` (${r.sub})` : ''}`).join(', ') +
  (usd !== undefined ? `, cost $${usd.toFixed(2)}` : '')

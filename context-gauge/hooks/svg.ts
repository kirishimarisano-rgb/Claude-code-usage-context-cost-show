// Small SVG meters for the surfaces that draw `Svg` (desktop, mobile, VS Code).
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

// Muted: low saturation, so the meters sit quietly beside the transcript.
export const TONE = { ok: '#8aa892', warn: '#c8a66e', hot: '#c98585' }

const toneOf = (ratio: number, warnAt: number, hotAt: number) =>
  ratio >= hotAt ? TONE.hot : ratio >= warnAt ? TONE.warn : TONE.ok

const STYLE = `
  <style>
    text { font-family: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-feature-settings: "tnum"; font-weight: 500; text-rendering: geometricPrecision; }
    .label { fill: #7a808b; font-size: 8px; letter-spacing: 0.8px; }
    .value { fill: #cfd2d8; font-size: 10.5px; font-weight: 600; }
    .sub { fill: #6c727d; font-size: 9.5px; }
    .track { fill: rgba(140, 146, 158, 0.16); }
    @media (prefers-color-scheme: light) {
      .value { fill: #2b3038; }
      .label, .sub { fill: #6a717c; }
      .track { fill: rgba(80, 86, 98, 0.13); }
    }
  </style>`

const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const resets = (l: Limit, now: number) => {
  const at = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  return Number.isNaN(at) ? '' : `↻ ${dur(at - now)}`
}

// What the meters show: context, each limit window.
export function readings(m: Meter, ctxRatio: number, now: number): Reading[] {
  const limit = m.isAutoCompact && m.threshold ? m.threshold : m.window
  const out: Reading[] = [
    {
      key: 'ctx',
      label: 'CONTEXT',
      ratio: ctxRatio,
      value: `${m.percent ?? 0}%`,
      sub: ctxRatio >= 0.9 ? 'compacts soon' : `${k(m.tokens ?? 0)} / ${k(limit)}`,
      isHot: ctxRatio >= 0.9,
    },
  ]
  for (const kind of ['five_hour', 'seven_day']) {
    const l = m.limits.find(x => x.kind === kind)
    const label = kind === 'five_hour' ? '5 HOUR' : '7 DAY'
    out.push(
      l
        ? { key: kind, label, ratio: l.percent / 100, value: `${l.percent}%`, sub: resets(l, now), isHot: l.percent >= 90 }
        : { key: kind, label, ratio: null, value: '—', sub: 'after first reply', isHot: false },
    )
  }
  return out
}

const colorOf = (r: Reading) =>
  r.key === 'ctx' ? toneOf(r.ratio ?? 0, 0.75, 0.9) : toneOf(r.ratio ?? 0, 0.7, 0.9)

const fillOf = (r: Reading, w: number) => (r.ratio === null ? 0 : Math.max(0, Math.min(1, r.ratio)) * w)

// One thin line for the band: label, value, a short hairline bar, the note.
const SEG: Record<string, { value: number; bar: number; sub: number; end: number }> = {
  ctx: { value: 51, bar: 80, sub: 116, end: 186 },
  five_hour: { value: 42, bar: 71, sub: 107, end: 148 },
  seven_day: { value: 37, bar: 66, sub: 102, end: 143 },
}

export function strip(rs: Reading[], usd: number | undefined): string {
  const gap = 20
  const mid = 11
  let x = 0
  const parts = rs.map(r => {
    const g = SEG[r.key] ?? SEG.five_hour!
    const c = colorOf(r)
    const fill = fillOf(r, 28)
    const out = `
      <g transform="translate(${x},0)">
        <text class="label" x="0" y="${mid}">${r.label}</text>
        <text class="value" x="${g.value}" y="${mid + 0.5}" ${r.isHot ? `style="fill:${TONE.hot}"` : ''}>${r.value}</text>
        <rect class="track" x="${g.bar}" y="${mid - 4}" width="28" height="2.5" rx="1.25"/>
        ${fill > 0 ? `<rect x="${g.bar}" y="${mid - 4}" width="${Math.max(2.5, fill)}" height="2.5" rx="1.25" fill="${c}"/>` : ''}
        <text class="sub" x="${g.sub}" y="${mid}">${r.sub}</text>
      </g>`
    x += g.end + gap
    return out
  })
  if (usd !== undefined) {
    parts.push(`
      <g transform="translate(${x},0)">
        <text class="label" x="0" y="${mid}">COST</text>
        <text class="value" x="33" y="${mid + 0.5}">$${usd.toFixed(2)}</text>
      </g>`)
    x += 70
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="15" viewBox="0 0 ${x} 15">${STYLE}${parts.join('')}</svg>`
}

// The same meters stacked, for the pane and the /gauge row.
export function stack(rs: Reading[], width: number): string {
  const w = Math.max(160, Math.min(320, width))
  const rowH = 26
  const parts = rs.map((r, i) => {
    const c = colorOf(r)
    const fill = fillOf(r, w)
    return `
      <g transform="translate(0,${i * rowH})">
        <text class="label" x="0" y="10">${r.label}</text>
        <text class="sub" x="${w - 34}" y="10" text-anchor="end">${r.sub}</text>
        <text class="value" x="${w}" y="10.5" text-anchor="end" ${r.isHot ? `style="fill:${TONE.hot}"` : ''}>${r.value}</text>
        <rect class="track" x="0" y="16" width="${w}" height="2.5" rx="1.25"/>
        ${fill > 0 ? `<rect x="0" y="16" width="${Math.max(2.5, fill)}" height="2.5" rx="1.25" fill="${c}"/>` : ''}
      </g>`
  })
  const h = rs.length * rowH - 6
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${STYLE}${parts.join('')}</svg>`
}

export const alt = (rs: Reading[], usd: number | undefined) =>
  rs.map(r => `${r.label.toLowerCase()} ${r.value}${r.sub ? ` (${r.sub})` : ''}`).join(', ') +
  (usd !== undefined ? `, cost $${usd.toFixed(2)}` : '')

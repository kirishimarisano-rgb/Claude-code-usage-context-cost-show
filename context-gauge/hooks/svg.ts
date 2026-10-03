// SVG meters for the surfaces that draw `Svg` (desktop, mobile, VS Code).
// Pure string builders: no `$`, no state.

import type { Limit, Look, LookStyle, Meter } from '../types'

export type Reading = {
  key: string
  label: string
  ratio: number | null
  value: string
  sub: string
  isHot: boolean
}

export type Tones = { ok: string; warn: string; hot: string }

// Classic: deep, solid green / amber / red. Minimal: low-saturation tones.
export const PALETTE: Record<LookStyle, Tones> = {
  classic: { ok: '#2f8a57', warn: '#c47f0e', hot: '#b8322a' },
  minimal: { ok: '#8aa892', warn: '#c8a66e', hot: '#c98585' },
  // Drawn as text, not SVG; its tones are Classic's.
  terminal: { ok: '#2f8a57', warn: '#c47f0e', hot: '#b8322a' },
}

export const SCALE: Record<Look['size'], number> = { s: 1, m: 1.18, l: 1.36 }

const LABELS: Record<LookStyle, Record<string, string>> = {
  classic: { ctx: 'Context', five_hour: '5h', seven_day: '7d', cost: 'Cost' },
  minimal: { ctx: 'CONTEXT', five_hour: '5 HOUR', seven_day: '7 DAY', cost: 'COST' },
  terminal: { ctx: 'ctx', five_hour: '5h', seven_day: '7d', cost: 'cost' },
}

const FONT = `"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif`

// Font sizes and label tracking, in the drawing's own units (before scaling).
const TYPE: Record<LookStyle, { label: number; track: number; value: number; sub: number }> = {
  classic: { label: 10, track: 0, value: 11, sub: 10 },
  minimal: { label: 8, track: 0.8, value: 10.5, sub: 9.5 },
  terminal: { label: 10, track: 0, value: 11, sub: 10 },
}

// Claude's theme, as /config holds it: dark, light, or auto (follow the OS).
// An SVG drawn as an image sees only the OS scheme, so a set theme is passed in.
let theme: 'auto' | 'dark' | 'light' = 'auto'
export const setTheme = (value: string | undefined) => {
  theme = !value || value === 'auto' ? 'auto' : value.startsWith('light') ? 'light' : 'dark'
}

const style = (s: LookStyle) => {
  const t = TYPE[s]
  const hot = PALETTE[s].hot
  const light = `.value { fill: #23272e; } .label, .sub { fill: #646b76; } .hot { fill: ${hot}; } .track { fill: rgba(80, 86, 98, 0.14); }`
  const scheme = theme === 'light' ? light : theme === 'dark' ? '' : `@media (prefers-color-scheme: light) { ${light} }`
  return `
  <style>
    text { font-family: ${FONT}; font-feature-settings: "tnum"; font-weight: 500; text-rendering: geometricPrecision; }
    .label { fill: ${s !== 'minimal' ? '#9ba1ab' : '#7a808b'}; font-size: ${t.label}px; letter-spacing: ${t.track}px; }
    .value { fill: ${s !== 'minimal' ? '#e3e5e9' : '#cfd2d8'}; font-size: ${t.value}px; font-weight: 600; }
    .sub { fill: ${s !== 'minimal' ? '#848a95' : '#6c727d'}; font-size: ${t.sub}px; }
    .hot { fill: ${s !== 'minimal' ? '#d24a3e' : hot}; }
    .track { fill: rgba(140, 146, 158, ${s !== 'minimal' ? 0.22 : 0.16}); }
    ${scheme}
  </style>`
}

// A rough advance width for the system UI font, generous so text never collides.
const advance = (text: string, size: number, track = 0) => {
  let w = 0
  for (const ch of text) {
    w +=
      /[A-Z]/.test(ch) ? 0.66
      : /[a-z]/.test(ch) ? 0.54
      : /[0-9]/.test(ch) ? 0.58
      : ch === ' ' ? 0.28
      : ch === '%' ? 0.86
      : ch === '.' || ch === ',' ? 0.28
      : ch === '/' ? 0.38
      : ch === '↻' || ch === '—' ? 0.9
      : 0.6
    w += track / size
  }
  return w * size
}

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
export function readings(m: Meter, ctxRatio: number, now: number, s: LookStyle = 'classic'): Reading[] {
  const label = LABELS[s]
  const limit = m.isAutoCompact && m.threshold ? m.threshold : m.window
  const out: Reading[] = [
    {
      key: 'ctx',
      label: label.ctx!,
      ratio: ctxRatio,
      value: `${m.percent ?? 0}%`,
      sub: ctxRatio >= 0.9 ? 'compacts soon' : `${k(m.tokens ?? 0)} / ${k(limit)}`,
      isHot: ctxRatio >= 0.9,
    },
  ]
  for (const kind of ['five_hour', 'seven_day']) {
    const l = m.limits.find(x => x.kind === kind)
    out.push(
      l
        ? { key: kind, label: label[kind]!, ratio: l.percent / 100, value: `${l.percent}%`, sub: resets(l, now), isHot: l.percent >= 90 }
        : { key: kind, label: label[kind]!, ratio: null, value: '—', sub: 'after first reply', isHot: false },
    )
  }
  return out
}

const toneOf = (t: Tones, ratio: number, warnAt: number, hotAt: number) =>
  ratio >= hotAt ? t.hot : ratio >= warnAt ? t.warn : t.ok

const colorOf = (t: Tones, r: Reading) =>
  r.key === 'ctx' ? toneOf(t, r.ratio ?? 0, 0.75, 0.9) : toneOf(t, r.ratio ?? 0, 0.7, 0.9)

const fillOf = (r: Reading, w: number) => (r.ratio === null ? 0 : Math.max(0, Math.min(1, r.ratio)) * w)

const svg = (w: number, h: number, scale: number, s: LookStyle, body: string) => {
  const W = Math.ceil(w * scale)
  const H = Math.ceil(h * scale)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${style(s)}<g transform="scale(${scale})">${body}</g></svg>`
}

// One line for the band: label, value, a short bar, the note.
// One line for the band, fitted to `maxWidth` CSS pixels when given: the notes
// go first, then the cost, then the whole line scales down (to 80% at least).
export function strip(rs: Reading[], usd: number | undefined, look: Look, maxWidth?: number): string {
  const scale = SCALE[look.size]
  const tries: [boolean, boolean][] = [[true, true], [false, true], [false, false]]
  let line = ''
  let width = 0
  for (const [hasNotes, hasCost] of tries) {
    ;[line, width] = stripAt(rs, hasCost ? usd : undefined, look, hasNotes)
    if (maxWidth === undefined || width * scale <= maxWidth) return svg(width, 16, scale, look.style, line)
  }
  return svg(width, 16, Math.max(scale * 0.8, maxWidth! / width), look.style, line)
}

function stripAt(rs: Reading[], usd: number | undefined, look: Look, hasNotes: boolean): [string, number] {
  const s = look.style
  const t = TYPE[s]
  const tones = PALETTE[s]
  const barW = s !== 'minimal' ? 34 : 28
  const barH = s !== 'minimal' ? 3 : 2.5
  const mid = 12
  const gap = 18
  let x = 0
  const parts: string[] = []
  for (const r of rs) {
    const vx = advance(r.label, t.label, t.track) + 6
    const bx = vx + advance(r.value, t.value) * 1.15 + 8
    const sx = bx + barW + 6
    const sub = hasNotes || r.isHot ? r.sub : ''
    const fill = fillOf(r, barW)
    parts.push(`
      <g transform="translate(${x.toFixed(1)},0)">
        <text class="label" x="0" y="${mid}">${r.label}</text>
        <text class="value${r.isHot ? ' hot' : ''}" x="${vx.toFixed(1)}" y="${mid + 0.5}">${r.value}</text>
        <rect class="track" x="${bx.toFixed(1)}" y="${mid - 4.5}" width="${barW}" height="${barH}" rx="${barH / 2}"/>
        ${fill > 0 ? `<rect x="${bx.toFixed(1)}" y="${mid - 4.5}" width="${Math.max(barH, fill).toFixed(1)}" height="${barH}" rx="${barH / 2}" fill="${colorOf(tones, r)}"/>` : ''}
        <text class="sub${r.isHot ? ' hot' : ''}" x="${sx.toFixed(1)}" y="${mid}">${sub}</text>
      </g>`)
    x += (sub ? sx + advance(sub, t.sub) : sx - 6) + gap
  }
  if (usd !== undefined) {
    const label = LABELS[s].cost!
    const vx = advance(label, t.label, t.track) + 6
    const value = `$${usd.toFixed(2)}`
    parts.push(`
      <g transform="translate(${x.toFixed(1)},0)">
        <text class="label" x="0" y="${mid}">${label}</text>
        <text class="value" x="${vx.toFixed(1)}" y="${mid + 0.5}">${value}</text>
      </g>`)
    x += vx + advance(value, t.value) * 1.15 + 4
  }
  return [parts.join(''), x + 2]
}

// The same meters stacked, for the pane and the /gauge row.
export function stack(rs: Reading[], width: number, look: Look): string {
  const s = look.style
  const t = TYPE[s]
  const tones = PALETTE[s]
  const scale = SCALE[look.size]
  const w = Math.max(160, Math.min(320, width / scale))
  const rowH = 27
  const barH = s !== 'minimal' ? 3 : 2.5
  const parts = rs.map((r, i) => {
    const vw = advance(r.value, t.value) * 1.15
    return `
      <g transform="translate(0,${i * rowH})">
        <text class="label" x="0" y="11">${r.label}</text>
        <text class="sub" x="${(w - vw - 8).toFixed(1)}" y="11" text-anchor="end">${r.sub}</text>
        <text class="value${r.isHot ? ' hot' : ''}" x="${w}" y="11.5" text-anchor="end">${r.value}</text>
        <rect class="track" x="0" y="17" width="${w}" height="${barH}" rx="${barH / 2}"/>
        ${fillOf(r, w) > 0 ? `<rect x="0" y="17" width="${Math.max(barH, fillOf(r, w)).toFixed(1)}" height="${barH}" rx="${barH / 2}" fill="${colorOf(tones, r)}"/>` : ''}
      </g>`
  })
  return svg(w, rs.length * rowH - 5, scale, s, parts.join(''))
}

export const alt = (rs: Reading[], usd: number | undefined) =>
  rs.map(r => `${r.label.toLowerCase()} ${r.value}${r.sub ? ` (${r.sub})` : ''}`).join(', ') +
  (usd !== undefined ? `, cost $${usd.toFixed(2)}` : '')

// The model picker's pill: a dark track, the chosen part filled, a dot per
// position and a white knob on the chosen one.
export function pill(n: number, active: number | null, locked: boolean[], fill: string, scale = 1): string {
  const W = 340
  const H = 52
  const pad = 6
  const k = (H - 2 * pad) / 2
  const x = (i: number) => pad + k + (n === 1 ? 0 : (i * (W - 2 * pad - 2 * k)) / (n - 1))
  const parts = [
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="${H / 2 - 0.5}" fill="#202124" stroke="#3a3b40"/>`,
  ]
  if (active !== null) {
    parts.push(`<rect x="${pad}" y="${pad}" width="${(x(active) + k - pad).toFixed(1)}" height="${H - 2 * pad}" rx="${k}" fill="${fill}"/>`)
  }
  for (let i = 0; i < n; i++) {
    if (i === active) continue
    const isFilled = active !== null && i < active
    const color = isFilled ? 'rgba(255,255,255,0.32)' : locked[i] ? '#4a4b50' : '#6b6d73'
    parts.push(`<circle cx="${x(i).toFixed(1)}" cy="${H / 2}" r="5.5" fill="${color}"/>`)
    if (locked[i] && !isFilled) {
      parts.push(`<line x1="${(x(i) - 4).toFixed(1)}" y1="${H / 2 + 4}" x2="${(x(i) + 4).toFixed(1)}" y2="${H / 2 - 4}" stroke="#202124" stroke-width="1.6"/>`)
    }
  }
  if (active !== null) parts.push(`<circle cx="${x(active).toFixed(1)}" cy="${H / 2}" r="${k - 2.5}" fill="#ffffff"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * scale)}" height="${Math.round(H * scale)}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

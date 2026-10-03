// The model slider: a row of positions the person drags across or clicks.
// Runs on the drawing thread (terminal and desktop); posts the chosen
// position to the hooks module, which switches the model.

import type { ClientModule } from 'claude-code'

type Props = {
  labels: string[]
  locked: boolean[]
  active: number | null
  accent: string
  // A bare track for the band: a stop every five cells, no labels.
  compact?: boolean
  // The compact track's unfilled color, matched to the theme.
  rail?: string
}

// Two cells either side of a stop: a wider track is easier to drag.
const PAD = 2
const STEP = 2 * PAD + 1

type State = { drag: number | null }

const Slider: ClientModule<Props, State> = (p, s) => {
  const { Box, Text } = s.elements
  const n = Math.max(1, p.labels.length)
  const slotAt = (x: number) =>
    Math.max(0, Math.min(n - 1, p.compact ? Math.round((x - 1) / STEP) : Math.floor(x / Math.max(1, s.columns / n))))

  if (s.state === undefined) {
    s.setState({ drag: null })
    s.onPointer(ev => {
      const at = slotAt(ev.x)
      if (ev.type === 'down') s.setState({ drag: at })
      else if (ev.type === 'move' && s.state?.drag != null && s.state.drag !== at) s.setState({ drag: at })
      else if (ev.type === 'up' && s.state?.drag != null) {
        s.setState({ drag: null })
        s.post({ slot: at })
      } else if (ev.type === 'leave' && s.state?.drag != null) s.setState({ drag: null })
    })
    s.onKey(ev => {
      const from = p.active ?? 0
      if (ev.key === 'left' && from > 0) s.post({ slot: from - 1 })
      if (ev.key === 'right' && from < n - 1) s.post({ slot: from + 1 })
    })
  }

  const shown = s.state?.drag ?? p.active

  if (p.compact) {
    // A capsule: filled in the accent up to the knob, a white knob, the rest a
    // dim rail; half blocks round the two ends.
    const rail = p.rail ?? '#3a3b40'
    const at = shown ?? -1
    const cells: { ch: string; fg?: string; bg: string; bold?: boolean }[] = []
    for (let i = 0; i < n; i++) {
      const bg = i <= at ? p.accent : rail
      const mark = i === at ? '●' : p.locked[i] ? '⊘' : '·'
      const fg = i === at ? '#ffffff' : i < at ? '#f3d9cf' : '#8a8d94'
      if (i > 0) cells.push({ ch: ' '.repeat(PAD), bg: i <= at ? p.accent : rail })
      cells.push({ ch: mark, fg, bg, bold: i === at })
      if (i < n - 1) cells.push({ ch: ' '.repeat(PAD), bg: i < at ? p.accent : rail })
    }
    return (
      <Box flexDirection="row">
        <Text color={at >= 0 ? p.accent : rail}>▐</Text>
        {cells.map(c => (
          <Text color={c.fg} backgroundColor={c.bg} bold={c.bold}>
            {c.ch}
          </Text>
        ))}
        <Text color={rail}>▌</Text>
      </Box>
    )
  }

  const cell = Math.max(6, Math.floor((s.columns || n * 14) / n))
  return (
    <Box flexDirection="row">
      {p.labels.map((label, i) => {
        const isOn = i === shown
        const text = `${isOn ? '●' : p.locked[i] ? '⊘' : '○'} ${label}`.slice(0, cell - 1).padEnd(cell)
        return isOn ? (
          <Text color={p.accent} bold>
            {text}
          </Text>
        ) : (
          <Text dimColor>{text}</Text>
        )
      })}
    </Box>
  )
}

export default Slider

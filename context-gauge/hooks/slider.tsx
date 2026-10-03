// The model slider: a row of positions the person drags across or clicks.
// Runs on the drawing thread (terminal and desktop); posts the chosen
// position to the hooks module, which switches the model.

import type { ClientModule } from 'claude-code'

type Props = {
  labels: string[]
  locked: boolean[]
  active: number | null
  accent: string
  // A bare track for the band: a stop every three cells, no labels.
  compact?: boolean
}

const STEP = 3

type State = { drag: number | null }

const Slider: ClientModule<Props, State> = (p, s) => {
  const { Box, Text } = s.elements
  const n = Math.max(1, p.labels.length)
  const slotAt = (x: number) =>
    Math.max(0, Math.min(n - 1, p.compact ? Math.round(x / STEP) : Math.floor(x / Math.max(1, s.columns / n))))

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
    // ●━━○──○──⊘ : filled up to the chosen stop in the accent, the rest dim.
    return (
      <Box flexDirection="row">
        {p.labels.map((_, i) => {
          const isOn = i === shown
          const isBefore = shown !== null && shown !== undefined && i < shown
          const stop = isOn ? '●' : p.locked[i] ? '⊘' : '○'
          const rail = i === n - 1 ? '' : shown !== null && shown !== undefined && i < shown ? '━━' : '──'
          return (
            <Box flexDirection="row">
              {isOn || isBefore ? <Text color={p.accent}>{stop}</Text> : <Text dimColor>{stop}</Text>}
              {isBefore ? <Text color={p.accent}>{rail}</Text> : <Text dimColor>{rail}</Text>}
            </Box>
          )
        })}
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

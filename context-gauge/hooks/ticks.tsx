// The timeline strip: a tick per prompt, two cells wide so it is easy to hit.
// Hovering a tick tells the hooks module which (the band shows its line in
// place of the meters, so nothing moves under the pointer); a press jumps.

import type { ClientModule } from 'claude-code'

type Props = { colors: string[] }

type State = { hover: number | null }

const WIDTH = 2

const Ticks: ClientModule<Props, State> = (p, s) => {
  const { Box, Text } = s.elements
  const at = (x: number) => Math.max(0, Math.min(p.colors.length - 1, Math.floor(x / WIDTH)))

  if (s.state === undefined) {
    s.setState({ hover: null })
    s.onPointer(ev => {
      if (ev.type === 'leave') {
        if (s.state?.hover !== null) {
          s.setState({ hover: null })
          s.post({ hover: null })
        }
        return
      }
      const i = at(ev.x)
      if (ev.type === 'down') s.post({ jump: i })
      else if (s.state?.hover !== i) {
        s.setState({ hover: i })
        s.post({ hover: i })
      }
    })
  }

  return (
    <Box flexDirection="row">
      {p.colors.map((color, i) => (
        <Text color={color} bold={i === s.state?.hover}>
          {i === s.state?.hover ? '█ ' : '▮ '}
        </Text>
      ))}
    </Box>
  )
}

export default Ticks

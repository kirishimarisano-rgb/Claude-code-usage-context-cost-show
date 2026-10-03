export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Category = { name: string; tokens: number }

export type Meter = {
  tokens?: number
  window: number
  percent?: number
  threshold?: number
  isAutoCompact: boolean
  categories: Category[]
  limits: Limit[]
  usd?: number
  delta?: number
}

export type Phase = 'waiting' | 'thinking' | 'responding' | 'tool'

export type ToolRow = {
  id: string
  name: string
  startedAt: number
  ms: number | null
  isError: boolean
}

export type Live = {
  turnId: string
  startedAt: number
  phase: Phase
  phaseSince: number
  thinkMs: number
  respondMs: number
  toolMs: number
  waitMs: number
  outTokens: number
  genMs: number
  tools: ToolRow[]
}

export type TurnRow = {
  ms: number
  thinkMs: number
  toolMs: number
  outTokens: number
  tps: number | null
  tools: number
  isAborted: boolean
}

export type FooterMode = 'auto' | 'on' | 'off'

export type CompactMode = 'off' | 'remind' | 'auto'

// One wrap-up rule: on or off, and the percent of its limit window it fires at.
export type WrapRule = { isOn: boolean; at: number }

export type LookStyle = 'classic' | 'minimal'

export type Look = { style: LookStyle; size: 's' | 'm' | 'l' }

export type GaugeSettings = {
  wrap5h: WrapRule
  wrap7d: WrapRule
  compact: { mode: CompactMode; at: number }
  footer: FooterMode
  look: Look
}

export type Wrap = {
  pending: { deadline: number; key: string; label: string } | null
  fired: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': {
      meter: Meter | null
      live: Live | null
      history: TurnRow[]
      isCollapsed: boolean
      settings: GaugeSettings
      wrap: Wrap
      tick: number
      compactAt: number | null
    }
  }
}

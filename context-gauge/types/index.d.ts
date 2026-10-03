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

export type Wrap = {
  isOn: boolean
  atPercent: number
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
      wrap: Wrap
      tick: number
    }
  }
}

export type Phase = 'waiting' | 'thinking' | 'responding' | 'tool'

export type Status = 'idle' | 'running' | 'ended'

// The task list Claude keeps (TodoWrite, or TaskCreate and TaskUpdate).
export type Todos = {
  done: number
  total: number
  current?: string
  // When the first item was finished, for the time-left estimate.
  firstDoneAt?: number
  startedAt: number
}

export type Outcome = { status: 'ok' | 'error' | 'stopped'; ms: number; at: number }

// What one session tells the widget. Times are epoch milliseconds.
export type Snapshot = {
  v: 1
  id: string
  project: string
  model?: string
  effort?: string
  status: Status
  phase: Phase
  turnId?: string
  turnStartedAt?: number
  prompt?: string
  tool?: { name: string; label: string; since: number }
  todos?: Todos
  agents: number
  ctx?: number
  limits: { kind: string; percent: number; resetsAt?: string }[]
  usd?: number
  last?: Outcome
  sentAt: number
}

export type Link = {
  isPaired: boolean
  port: number
  isOn: boolean
  ok: boolean | null
  at: number | null
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'widget-bridge': {
      snap: Snapshot | null
      link: Link
    }
  }
}

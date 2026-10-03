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

export type LookStyle = 'classic' | 'minimal' | 'terminal'

export type Look = { style: LookStyle; size: 's' | 'm' | 'l' }

export type EffortName = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// One position of the model slider: a /model alias and an /effort level.
export type Slot = { model: string; effort: EffortName }

export type ModelPrefs = {
  isShown: boolean
  slots: Slot[]
  // Fable is for Max plans: its positions stay locked until this is set.
  hasMax: boolean
}

export type GaugeSettings = {
  wrap5h: WrapRule
  wrap7d: WrapRule
  compact: { mode: CompactMode; at: number }
  footer: FooterMode
  look: Look
  models: ModelPrefs
  timeline: TimelinePrefs
}

// Where the timeline shows: a mark on each of your messages, a strip of ticks
// above the prompt, and the AI one-line summaries (they cost tokens).
export type TimelinePrefs = { isAiSummary: boolean; isMarked: boolean; isStrip: boolean }

// What the session runs now, as the last request and this mod's switches saw it.
export type Current = {
  model?: string
  effort?: string
  slot: number | null
  fast: boolean | null
  outputStyle?: string
  styles: string[]
  youShouldKnow: boolean | null
  theme?: string
}

export type EntryStatus = 'running' | 'ok' | 'error' | 'stopped'

// One prompt of the session on the timeline.
export type Entry = {
  id: string
  text: string
  at: number
  ms: number | null
  tools: number
  errors: number
  files: string[]
  status: EntryStatus
  summary?: string
}

export type SettingsTab = 'usage' | 'models' | 'timeline' | 'display'

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
      current: Current
      timeline: Entry[]
      settingsTab: SettingsTab
      isPickerOpen: boolean
      stripHover: string | null
      isSearchOpen: boolean
    }
  }
}

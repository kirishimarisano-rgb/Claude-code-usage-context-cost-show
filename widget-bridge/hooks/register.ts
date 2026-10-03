import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Link, Outcome, Phase, Snapshot, Todos } from '../types'

// The Claude Widget app listens here, on this computer only.
const DEFAULT_PORT = 47615
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

// How often the widget hears from a session: while it works, while it idles,
// and while the widget does not answer.
const BEAT_MS = 3000
const IDLE_EVERY_MS = 15_000
const RETRY_EVERY_MS = 30_000

const snap = atom({ plugin: 'widget-bridge', key: 'snap' } as const, null)
const link = atom({ plugin: 'widget-bridge', key: 'link' } as const, {
  isPaired: false,
  port: DEFAULT_PORT,
  isOn: true,
  ok: null,
  at: null,
})

const quietly = (work: Promise<unknown>) => void work.catch(() => undefined)
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n)

// Kept by the module, not the host: the token never sits in readable state.
let token: string | null = null
let beat: Timer | null = null
let soon: Timer | null = null
let isSending = false
let isDirty = false
let sentAt = 0
let triedAt = 0
// The tasks Claude made with TaskCreate, by id, for TaskUpdate to move.
const tasks = new Map<string, { subject: string; status: string }>()

// ---------- what a tool is doing, in a few words ----------

function toolLabel(tool: string, e: Record<string, unknown>): string {
  const s = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  switch (tool) {
    case 'Bash':
      return oneLine(s('description') || s('command'), 60)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return baseName(s('file_path') || s('notebook_path'))
    case 'Grep':
    case 'Glob':
      return oneLine(s('pattern'), 40)
    case 'WebFetch':
      try {
        return new URL(s('url')).hostname
      } catch {
        return ''
      }
    case 'WebSearch':
      return oneLine(s('query'), 50)
    case 'Task':
    case 'Agent':
      return oneLine(s('description'), 50)
    default:
      return ''
  }
}

// ---------- the task list ----------

function fromTodoWrite(e: Record<string, unknown>, prev: Todos | undefined, now: number): Todos | undefined {
  if (!Array.isArray(e.todos)) return prev
  const items = e.todos as { content?: unknown; status?: unknown; activeForm?: unknown }[]
  if (!items.length) return undefined
  const done = items.filter(x => x.status === 'completed').length
  const doing = items.find(x => x.status === 'in_progress')
  const title = doing && (typeof doing.activeForm === 'string' ? doing.activeForm : doing.content)
  return {
    done,
    total: items.length,
    current: typeof title === 'string' ? oneLine(title, 80) : undefined,
    startedAt: prev && prev.done < prev.total ? prev.startedAt : now,
    firstDoneAt: done ? (prev?.firstDoneAt ?? now) : undefined,
  }
}

function fromTasks(prev: Todos | undefined, now: number, doing?: string): Todos | undefined {
  const all = [...tasks.values()].filter(x => x.status !== 'deleted')
  if (!all.length) return undefined
  const done = all.filter(x => x.status === 'completed').length
  return {
    done,
    total: all.length,
    current: doing ?? all.find(x => x.status === 'in_progress')?.subject,
    startedAt: prev && prev.done < prev.total ? prev.startedAt : now,
    firstDoneAt: done ? (prev?.firstDoneAt ?? now) : undefined,
  }
}

async function trackTasks($: EngineInterface, tool: string, e: Record<string, unknown>, resultText: string) {
  const now = await $.clock.now()
  const str = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : undefined)
  if (tool === 'TodoWrite') {
    await update($, snap, s => (s ? { ...s, todos: fromTodoWrite(e, s.todos, now) } : s))
  } else if (tool === 'TaskCreate') {
    const id = /#?(\d+)/.exec(resultText)?.[1] ?? `n${tasks.size + 1}`
    tasks.set(id, { subject: oneLine(str('subject') ?? '', 80), status: 'pending' })
    await update($, snap, s => (s ? { ...s, todos: fromTasks(s.todos, now) } : s))
  } else if (tool === 'TaskUpdate') {
    const id = str('taskId')
    const t = id ? tasks.get(id) : undefined
    if (!id || !t) return
    const status = str('status') ?? t.status
    tasks.set(id, { subject: str('subject') ? oneLine(str('subject')!, 80) : t.subject, status })
    const doing = status === 'in_progress' ? (str('activeForm') ? oneLine(str('activeForm')!, 80) : t.subject) : undefined
    await update($, snap, s => (s ? { ...s, todos: fromTasks(s.todos, now, doing) } : s))
  }
}

// ---------- talking to the widget ----------

async function send($: EngineInterface): Promise<Link> {
  const l = await read($, link)
  const s = await read($, snap)
  if (!token || !l.isOn || !s) return l
  if (isSending) {
    isDirty = true
    return l
  }
  isSending = true
  const now = await $.clock.now()
  triedAt = now
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${l.port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...s, sentAt: now }),
    })
    sentAt = now
    if (r.status === 401) return await update($, link, x => ({ ...x, ok: false, at: now, error: 'the widget refused the pairing code; pair again' }))
    if (!r.ok) return await update($, link, x => ({ ...x, ok: false, at: now, error: `HTTP ${r.status}` }))
    await obey($, r.text.slice(0, 2000))
    return await update($, link, x => ({ ...x, ok: true, at: now, error: undefined }))
  } catch {
    return await update($, link, x => ({ ...x, ok: false, at: now, error: 'the widget is not running' }))
  } finally {
    isSending = false
    if (isDirty) {
      isDirty = false
      pushSoon($)
    }
  }
}

// What the widget asks back: only Stop, and only for the turn it saw.
async function obey($: EngineInterface, text: string) {
  let answer: { commands?: { kind?: unknown; turnId?: unknown }[] }
  try {
    answer = JSON.parse(text)
  } catch {
    return
  }
  if (!Array.isArray(answer?.commands)) return
  const s = await read($, snap)
  for (const c of answer.commands.slice(0, 5)) {
    if (c?.kind === 'stop' && s?.status === 'running' && s.turnId && c.turnId === s.turnId) {
      await $.turn.abort({ turnId: s.turnId })
    }
  }
}

// Coalesces a burst of changes into one send.
function pushSoon($: EngineInterface) {
  if (!token || soon) return
  soon = $.clock.after(400, () => {
    soon = null
    quietly(send($))
  })
}

function startBeat($: EngineInterface) {
  if (beat) return
  beat = $.clock.every(BEAT_MS, () => {
    quietly((async () => {
      const [l, s, now] = [await read($, link), await read($, snap), await $.clock.now()]
      if (!token || !l.isOn || !s) return
      if (l.ok === false && now - triedAt < RETRY_EVERY_MS) return
      if (s.status === 'running' || now - sentAt >= IDLE_EVERY_MS) await send($)
    })())
  })
}

async function patch($: EngineInterface, fn: (s: Snapshot) => Snapshot) {
  await update($, snap, s => (s ? fn(s) : s))
  pushSoon($)
}

// ---------- settings ----------

async function loadLink($: EngineInterface) {
  const saved = (await $.store.get('link')) as { token?: unknown; port?: unknown; isOn?: unknown } | undefined
  token = typeof saved?.token === 'string' && TOKEN.test(saved.token) ? saved.token : null
  const port = typeof saved?.port === 'number' && saved.port >= 1024 && saved.port <= 65535 ? saved.port : DEFAULT_PORT
  await update($, link, x => ({ ...x, isPaired: Boolean(token), port, isOn: saved?.isOn !== false }))
}

async function saveLink($: EngineInterface, change: { token?: string | null; port?: number; isOn?: boolean }) {
  if (change.token !== undefined) token = change.token
  const l = await update($, link, x => ({
    ...x,
    isPaired: Boolean(token),
    port: change.port ?? x.port,
    isOn: change.isOn ?? x.isOn,
    ok: null,
    at: null,
    error: undefined,
  }))
  await $.store.set('link', { token, port: l.port, isOn: l.isOn })
  return l
}

const COMMANDS = [
  '/widget                 whether this session reaches the widget',
  '/widget pair <code>     pair with the widget (the code is in its settings)',
  '/widget unpair          forget the pairing code',
  '/widget on|off          send to the widget, or stop sending',
  '/widget port <n>        the port the widget listens on (47615)',
].join('\n')

async function describe($: EngineInterface) {
  const l = await read($, link)
  if (!l.isPaired) return 'Not paired. Open Claude Widget → ⚙ and run the `/widget pair …` line it shows.'
  if (!l.isOn) return `Paired, but off. \`/widget on\` sends again.`
  const now = await $.clock.now()
  const state =
    l.ok === null ? 'not tried yet' : l.ok ? `reached ${Math.max(0, Math.round((now - (l.at ?? now)) / 1000))}s ago` : `cannot reach it: ${l.error}`
  return `Claude Widget on 127.0.0.1:${l.port}: ${state}.`
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Each step on its own: a failing one never leaves the session unwatched.
    try {
      await $.command.register({
        name: 'widget',
        description: 'Claude Widget on the desktop: `pair <code>`, `on`, `off`, `port <n>`',
        argumentHint: '[pair <code> | unpair | on | off | port <n>]',
      })
    } catch {
      // no /widget, the rest still runs
    }
    try {
      await loadLink($)
    } catch {
      // unpaired until /widget pair
    }
    const [id, now] = [await $.session.id(), await $.clock.now()]
    await update($, snap, (): Snapshot => ({
      v: 1,
      id,
      project: baseName(e.cwd),
      status: 'idle',
      phase: 'waiting',
      agents: 0,
      limits: [],
      sentAt: now,
    }))
    try {
      const u = await $.session.usage()
      await update($, snap, s =>
        s ? { ...s, ctx: u.context.percent, limits: u.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })), usd: u.cost?.usd } : s,
      )
    } catch {
      // the first measure fills them
    }
    startBeat($)
    pushSoon($)
    return next(e)
  })

  on('command.run', { command: 'widget' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    if (!sub || sub === 'status') return { text: await describe($) }
    if (sub === 'pair') {
      if (!arg || !TOKEN.test(arg)) return { text: 'That is not a pairing code. Copy the whole `/widget pair …` line from the widget.' }
      await saveLink($, { token: arg, isOn: true })
      const l = await send($)
      return { text: l.ok ? 'Paired: the widget now shows this session.' : `Saved, but ${l.error ?? 'the widget did not answer'}.` }
    }
    if (sub === 'unpair') {
      await saveLink($, { token: null })
      return { text: 'Unpaired: nothing goes to the widget.' }
    }
    if (sub === 'on' || sub === 'off') {
      await saveLink($, { isOn: sub === 'on' })
      if (sub === 'on') await send($)
      return { text: await describe($) }
    }
    if (sub === 'port') {
      const n = Number(arg)
      if (!Number.isInteger(n) || n < 1024 || n > 65535) return { text: 'A port is a number from 1024 to 65535.' }
      await saveLink($, { port: n })
      await send($)
      return { text: await describe($) }
    }
    return { text: `Unknown: /widget ${sub}\n\`\`\`\n${COMMANDS}\n\`\`\`` }
  })

  on('session.measure', async ($, e, next) => {
    await patch($, s => ({
      ...s,
      ctx: e.context.percent ?? s.ctx,
      limits: e.rateLimits.length ? e.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })) : s.limits,
      usd: e.cost?.usd ?? s.usd,
    }))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    // After /clear the process goes on under a new id, with no session.start.
    const id = (await read($, snap))?.status === 'ended' ? await $.session.id() : undefined
    startBeat($)
    await patch($, s => ({
      ...s,
      id: id ?? s.id,
      status: 'running',
      phase: 'waiting',
      turnId: e.turnId,
      turnStartedAt: now,
      prompt: oneLine(e.text, 80) || undefined,
      tool: undefined,
      agents: 0,
      // A finished list belongs to the last task.
      todos: s.todos && s.todos.done < s.todos.total ? s.todos : undefined,
    }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    await patch($, s => ({ ...s, model: e.model, effort: e.effort === undefined ? s.effort : String(e.effort), phase: 'waiting' }))
    let phase: Phase = 'waiting'
    for await (const chunk of next(e)) {
      const p: Phase | null =
        chunk.kind === 'thinking' ? 'thinking' : chunk.kind === 'text' ? 'responding' : chunk.kind === 'tool' || chunk.kind === 'input' ? 'tool' : null
      if (p && p !== phase) {
        phase = p
        await patch($, s => ({ ...s, phase: p }))
      }
      yield chunk
    }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    if (e.agentId) {
      await patch($, s => ({ ...s, agents: s.agents + 1 }))
      try {
        return await next(e)
      } finally {
        await patch($, s => ({ ...s, agents: Math.max(0, s.agents - 1) }))
      }
    }
    const since = await $.clock.now()
    await patch($, s => ({ ...s, phase: 'tool', tool: { name: tool.slice(0, 40), label: toolLabel(tool, args), since } }))
    const result = await next(e)
    try {
      await trackTasks($, tool, args, String((result as { text?: unknown }).text ?? '').slice(0, 200))
    } catch {
      // the list stays as it was
    }
    await patch($, s => ({ ...s, tool: undefined }))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const now = await $.clock.now()
    const last: Outcome = {
      status: e.isAborted ? 'stopped' : e.reason === 'error' || e.reason === 'refusal' ? 'error' : 'ok',
      ms: e.durationMs,
      at: now,
    }
    await update($, snap, s => (s ? { ...s, status: 'idle' as const, phase: 'waiting' as const, tool: undefined, agents: 0, last } : s))
    quietly(send($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    beat?.cancel()
    beat = null
    await update($, snap, s => (s ? { ...s, status: 'ended' as const, tool: undefined } : s))
    await send($).catch(() => undefined)
    return next(e)
  })
}

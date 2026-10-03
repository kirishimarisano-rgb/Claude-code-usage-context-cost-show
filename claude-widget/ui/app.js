'use strict'

// ---------- words ----------

const WORDS = {
  zh: {
    pin: '釘在最上層', compact: '縮成膠囊', expand: '展開', gear: '設定', close: '結束',
    hub: '中控', running: n => `${n} 個任務進行中`, idleAll: '沒有進行中的任務', none: '還沒有 session',
    pairFirst: '在 Claude Code 打下方設定裡的指令，配對後這裡就會出現 session。',
    phase: { waiting: '等待模型', thinking: '思考中', responding: '撰寫回覆', tool: '執行工具' },
    idle: '閒置', ended: '已結束', lost: '失去聯絡',
    last: { ok: '完成', error: '出錯', stopped: '已停止' },
    steps: (d, t) => `${d} / ${t} 步`,
    elapsed: '已', left: '約剩', agents: n => `${n} 個子代理`,
    noList: '沒有待辦清單，只能看已用時間',
    ctx: 'Context', h5: '5 小時', d7: '7 天', cost: '花費',
    ago: '前',
    s: {
      title: '設定', pairHint: '在每台電腦的 Claude Code 裡打一次這行，之後每個本機 session 都會自動出現。',
      copy: '複製', copied: '已複製', notify: '完成時通知（任務超過 10 秒）', lang: '語言', port: '連接埠', done: '完成',
      privacy: '只聽本機 127.0.0.1，資料不會離開這台電腦。沒有這組配對碼的程式送不進來。',
    },
  },
  en: {
    pin: 'Keep on top', compact: 'Shrink to a pill', expand: 'Expand', gear: 'Settings', close: 'Quit',
    hub: 'Sessions', running: n => `${n} running`, idleAll: 'Nothing running', none: 'No sessions yet',
    pairFirst: 'Run the line from Settings in Claude Code; paired sessions show up here.',
    phase: { waiting: 'Waiting on the model', thinking: 'Thinking', responding: 'Writing', tool: 'Running a tool' },
    idle: 'Idle', ended: 'Ended', lost: 'Lost contact',
    last: { ok: 'Done', error: 'Failed', stopped: 'Stopped' },
    steps: (d, t) => `${d} / ${t} steps`,
    elapsed: '', left: '~', agents: n => `${n} subagents`,
    noList: 'No task list: elapsed time only',
    ctx: 'Context', h5: '5 hour', d7: '7 day', cost: 'Cost',
    ago: 'ago',
    s: {
      title: 'Settings', pairHint: 'Run this once in Claude Code on this computer; every local session then shows up.',
      copy: 'Copy', copied: 'Copied', notify: 'Notify when a task ends (over 10 s)', lang: 'Language', port: 'Port', done: 'Done',
      privacy: 'Listens on 127.0.0.1 only; nothing leaves this computer. Programs without this code are refused.',
    },
  },
}

// ---------- the app, or a demo in a browser ----------

const tauri = window.__TAURI__
if (tauri) document.documentElement.classList.add('native')
const call = (cmd, args) => (tauri ? tauri.core.invoke(cmd, args) : demo(cmd, args))

let state = null
let selected = null
let stopping = new Set()
let W = WORDS.zh

const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function clock(ms) {
  if (!(ms >= 0)) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

function roughly(ms) {
  const m = Math.round(ms / 60000)
  if (state?.lang === 'en') return m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`
  return m < 1 ? '不到 1 分' : m < 60 ? `${m} 分` : `${(m / 60).toFixed(1)} 小時`
}

// One session as the widget sees it now: its times moved onto this clock.
function view(row, now) {
  const s = row.snap
  const shift = row.receivedAt - s.sentAt
  const at = t => (typeof t === 'number' ? t + shift : undefined)
  const lost = s.status !== 'ended' && now - row.receivedAt > (s.status === 'running' ? 20_000 : 45_000)
  const status = lost ? 'lost' : s.status
  const turnStart = at(s.turnStartedAt)
  const elapsed = status === 'running' && turnStart ? now - turnStart : s.last?.ms
  const t = s.todos
  let eta = null
  if (status === 'running' && t && t.done > 0 && t.done < t.total) {
    const per = (now - at(t.startedAt)) / t.done
    eta = per * (t.total - t.done)
  }
  const pct = t && t.total ? t.done / t.total : null
  let act
  if (status === 'running') {
    if (s.tool) act = `<b>${esc(s.tool.name)}</b>${s.tool.label ? ' · ' + esc(s.tool.label) : ''}`
    else act = esc(W.phase[s.phase] ?? s.phase)
    if (s.agents) act += ` · ${esc(W.agents(s.agents))}`
  } else if (status === 'lost') act = esc(W.lost)
  else if (status === 'ended') act = esc(W.ended)
  else act = s.last ? `${esc(W.last[s.last.status])} · ${esc(clock(s.last.ms))}` : esc(W.idle)
  const dot = status === 'running' ? 'running' : status === 'lost' ? 'lost' : status === 'idle' && s.last ? s.last.status : ''
  return { s, status, elapsed, eta, pct, act, dot }
}

// ---------- drawing ----------

function meter(label, pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct ?? 0)))
  const tone = p >= 90 ? 'bad' : p >= 70 ? 'warn' : ''
  return `<div class="meter"><div class="k"><span>${esc(label)}</span><span>${pct == null ? '—' : p + '%'}</span></div>
    <div class="track"><div class="fill ${tone}" style="width:${p}%"></div></div></div>`
}

function ring(pct, text, isSpinning = false) {
  const r = 24
  const c = 2 * Math.PI * r
  const off = c * (1 - (pct ?? 0))
  return `<svg class="ring${isSpinning ? ' spin' : ''}" viewBox="0 0 58 58">
    <defs><linearGradient id="clay" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8946f"/><stop offset="1" stop-color="#c15f3c"/></linearGradient></defs>
    <circle class="track" cx="29" cy="29" r="${r}"/>
    <circle class="fill" cx="29" cy="29" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 29 29)"/>
    <text x="29" y="33.5" text-anchor="middle">${esc(text)}</text></svg>`
}

function drawFocus(v, limits) {
  const el = $('focus')
  if (!v) {
    el.innerHTML = `<div class="empty"><b>${esc(state.paired ? W.idleAll : W.none)}</b>${esc(W.pairFirst)}</div>`
    return
  }
  const { s } = v
  const t = s.todos
  const lim = k => limits.find(x => x.kind === k)?.percent
  let progress
  if (t && t.total) {
    progress = `${ring(v.pct, `${Math.round(v.pct * 100)}%`)}
      <div class="steps"><div class="now">${esc(t.current || W.steps(t.done, t.total))}</div>
      <div class="time">${esc(W.steps(t.done, t.total))} · ${esc(W.elapsed)} ${esc(clock(v.elapsed))}${v.eta != null ? ` · <em>${esc(W.left)} ${esc(roughly(v.eta))}</em>` : ''}</div></div>`
  } else {
    progress = `${ring(v.status === 'running' ? 0.22 : 1, clock(v.elapsed), v.status === 'running')}
      <div class="steps"><div class="now">${v.status === 'running' ? esc(W.noList) : v.act}</div>
      <div class="time">${esc(s.model ?? '')}${s.effort ? ' · ' + esc(s.effort) : ''}</div></div>`
  }
  el.innerHTML = `
    <div class="project">${esc(s.project)}</div>
    <div class="prompt">${esc(s.prompt ?? '')}</div>
    <div class="doing"><span class="dot ${v.dot}"></span><span class="what">${v.act}</span></div>
    <div class="progress">${progress}</div>
    <div class="meters">${meter(W.ctx, s.ctx)}${meter(W.h5, lim('five_hour'))}${meter(W.d7, lim('seven_day'))}</div>
    <div class="foot"><span>${esc(s.model ?? '')}</span><span>${s.usd != null ? `${esc(W.cost)} $${s.usd.toFixed(2)}` : ''}</span></div>`
}

function drawList(views) {
  $('list').innerHTML = views
    .map(v => {
      const { s } = v
      const bar =
        v.status === 'running'
          ? v.pct != null
            ? `<div class="bar2"><i style="width:${Math.round(v.pct * 100)}%"></i></div>`
            : `<div class="bar2"><i class="flow"></i></div>`
          : ''
      const side =
        v.status === 'running'
          ? `<div class="t">${esc(clock(v.elapsed))}${v.eta != null ? `<em>${esc(W.left)} ${esc(roughly(v.eta))}</em>` : ''}</div>
             <button class="stop ${stopping.has(s.turnId) ? 'sent' : ''}" data-stop="${esc(s.id)}" data-turn="${esc(s.turnId)}" title="Stop"></button>`
          : `<div class="t">${s.last ? esc(clock(s.last.ms)) : ''}</div>`
      return `<div class="task ${s.id === selected ? 'sel' : ''}" data-id="${esc(s.id)}">
        <span class="dot ${v.dot}"></span>
        <div class="name">${esc(s.project)}<span class="model">${esc((s.model ?? '').replace(/^claude-/, ''))}</span></div>
        <div class="side">${side}</div>
        <div class="act">${v.act}</div>
        ${bar}
      </div>`
    })
    .join('')
}

function drawPill(v) {
  const pct = v?.pct != null ? `<span class="pct">${Math.round(v.pct * 100)}%</span>` : v?.status === 'running' ? `<span class="pct">${esc(clock(v.elapsed))}</span>` : ''
  $('pill').innerHTML = `
    <svg class="spark" viewBox="0 0 24 24"><path d="M12 2.5l1.6 6.1 5.6-3-3 5.6 6.1 1.6-6.1 1.6 3 5.6-5.6-3L12 21.5l-1.6-6.1-5.6 3 3-5.6L1.7 11.2l6.1-1.6-3-5.6 5.6 3z"/></svg>
    <span class="dot ${v?.dot ?? ''}"></span>
    <span class="what" data-tauri-drag-region>${v ? `<b>${esc(v.s.project)}</b> · ${v.act}` : esc(W.idleAll)}</span>
    ${pct}
    <button class="icon" id="expand" title="${esc(W.expand)}"><svg viewBox="0 0 16 16"><path d="M3 6l5 5 5-5"/></svg></button>`
}

function draw() {
  if (!state) return
  W = WORDS[state.lang] ?? WORDS.zh
  const now = state.now + (Date.now() - state.fetchedAt)
  const order = { running: 0, idle: 1, lost: 2, ended: 3 }
  const views = state.sessions
    .map(r => view(r, now))
    .sort((a, b) => order[a.status] - order[b.status] || (b.s.turnStartedAt ?? 0) - (a.s.turnStartedAt ?? 0))
  const running = views.filter(v => v.status === 'running').length
  if (!views.some(v => v.s.id === selected)) selected = views[0]?.s.id ?? null
  const focused = views.find(v => v.s.id === selected)
  const limits = views.find(v => v.s.limits?.length)?.s.limits ?? []

  $('app').classList.toggle('compact', state.compact)
  $('summary').textContent = running ? W.running(running) : ''
  $('hub-title').textContent = W.hub
  $('hub-count').textContent = views.length ? String(views.length) : ''
  $('pin').classList.toggle('on', state.pinned)
  $('pin').title = W.pin
  $('compact').title = W.compact
  $('gear').title = W.gear
  $('close').title = W.close
  drawFocus(focused, limits)
  drawList(views)
  drawPill(views.find(v => v.status === 'running') ?? focused)
  drawSettings()
}

function drawSettings() {
  $('s-title').textContent = W.s.title
  $('s-pair-hint').textContent = W.s.pairHint
  $('pair-line').textContent = `/widget pair ${state.token}`
  if ($('copy').dataset.done !== '1') $('copy').textContent = W.s.copy
  $('s-notify').textContent = W.s.notify
  $('notify').checked = state.notify
  $('s-lang').textContent = W.s.lang
  $('lang').value = state.lang
  $('s-port').textContent = W.s.port
  $('port').textContent = `127.0.0.1:${state.port}`
  $('s-privacy').textContent = W.s.privacy
  $('s-done').textContent = W.s.done
}

// ---------- input ----------

async function refresh() {
  try {
    const s = await call('state')
    state = { ...s, fetchedAt: Date.now() }
    if (!state.lang) await setPref('lang', /^zh/i.test(navigator.language) ? 'zh' : 'en')
    for (const id of [...stopping]) if (!state.sessions.some(r => r.snap.turnId === id && r.snap.status === 'running')) stopping.delete(id)
    draw()
  } catch (e) {
    console.error(e)
  }
}

async function setPref(key, value) {
  state[key] = value
  draw()
  await call('set_pref', { key, value })
}

document.addEventListener('click', async e => {
  const t = e.target.closest('button, .task')
  if (!t) return
  if (t.dataset.stop) {
    e.stopPropagation()
    stopping.add(t.dataset.turn)
    draw()
    await call('stop', { id: t.dataset.stop, turnId: t.dataset.turn })
    return
  }
  if (t.classList.contains('task')) {
    selected = t.dataset.id
    draw()
    return
  }
  switch (t.id) {
    case 'pin': return setPref('pinned', !state.pinned)
    case 'compact': return setPref('compact', true)
    case 'expand': return setPref('compact', false)
    case 'gear': $('settings').hidden = false; return
    case 's-done': $('settings').hidden = true; return
    case 'close': return call('quit')
    case 'copy':
      try {
        await navigator.clipboard.writeText($('pair-line').textContent)
      } catch {
        const r = document.createRange()
        r.selectNodeContents($('pair-line'))
        getSelection().removeAllRanges()
        getSelection().addRange(r)
        document.execCommand('copy')
      }
      t.textContent = W.s.copied
      t.dataset.done = '1'
      setTimeout(() => { t.dataset.done = ''; drawSettings() }, 1500)
  }
})
$('notify').addEventListener('change', e => setPref('notify', e.target.checked))
$('lang').addEventListener('change', e => setPref('lang', e.target.value))

refresh()
setInterval(refresh, 1000)

// ---------- the browser demo ----------

function demo(cmd, args) {
  const now = Date.now()
  if (!demo.s) {
    document.documentElement.classList.add('demo')
    const base = { v: 1, agents: 0, limits: [{ kind: 'five_hour', percent: 34 }, { kind: 'seven_day', percent: 71 }] }
    demo.s = {
      token: 'k7Qm2vX9pL4tR8wZ3nY6', port: 47615, pinned: true, compact: false, notify: true,
      lang: new URLSearchParams(location.search).get('lang') || 'zh', paired: true,
      sessions: [
        { ...base, id: 'a', project: 'shop-frontend', model: 'claude-opus-5-5', effort: 'xhigh', status: 'running', phase: 'tool',
          turnId: 't1', turnStartedAt: now - 252_000, prompt: '把購物車頁面改成新的設計，加上優惠碼欄位',
          tool: { name: 'Bash', label: 'Run the tests', since: now - 4000 }, agents: 2,
          todos: { done: 3, total: 7, current: '加入優惠碼驗證', startedAt: now - 240_000 }, ctx: 46, usd: 3.12 },
        { ...base, id: 'b', project: 'api-server', model: 'claude-sonnet-5-5', effort: 'high', status: 'running', phase: 'thinking',
          turnId: 't2', turnStartedAt: now - 48_000, prompt: '找出 /orders 變慢的原因', ctx: 22, usd: 0.41 },
        { ...base, id: 'c', project: 'blog', model: 'claude-sonnet-5-5', status: 'idle', phase: 'waiting',
          last: { status: 'ok', ms: 133_000, at: now - 60_000 }, ctx: 61, usd: 1.08 },
        { ...base, id: 'd', project: 'infra', model: 'claude-haiku-4-5', status: 'idle', phase: 'waiting',
          last: { status: 'error', ms: 21_000, at: now - 400_000 }, ctx: 9, usd: 0.07 },
      ].map(s => ({ snap: { ...s, sentAt: now }, receivedAt: now })),
    }
    if (new URLSearchParams(location.search).get('compact')) demo.s.compact = true
    selected = 'a'
  }
  if (cmd === 'state') {
    for (const r of demo.s.sessions) {
      if (r.snap.status === 'running' || r.snap.status === 'idle') r.receivedAt = now
      r.snap.sentAt = r.receivedAt
    }
    return Promise.resolve({ ...demo.s, now })
  }
  if (cmd === 'set_pref') demo.s[args.key] = args.value
  return Promise.resolve(null)
}

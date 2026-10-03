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
    used: '已用', remain: '約剩', stop: '停止這一輪', agents: n => `${n} 個子代理`,
    noList: '沒有待辦清單，只能看已用時間',
    ctx: 'Context', h5: '5 小時', d7: '7 天', cost: '花費',
    ago: '前',
    s: {
      title: '設定', pairHint: '在每台電腦的 Claude Code 裡打一次這行，之後每個本機 session 都會自動出現。',
      look: '背景', clear: '透明', frosted: '毛玻璃', tint: '底色深淺',
      copy: '複製', copied: '已複製', notify: '完成時通知（任務超過 10 秒）', lang: '語言', port: '連接埠', done: '完成',
      privacy: '只聽本機 127.0.0.1:47615，資料不會離開這台電腦。毛玻璃在視窗沒被點選時，Windows 會換成灰色。',
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
    used: 'Elapsed', remain: 'Left', stop: 'Stop this turn', agents: n => `${n} subagents`,
    noList: 'No task list: elapsed time only',
    ctx: 'Context', h5: '5 hour', d7: '7 day', cost: 'Cost',
    ago: 'ago',
    s: {
      title: 'Settings', pairHint: 'Run this once in Claude Code on this computer; every local session then shows up.',
      look: 'Background', clear: 'Clear', frosted: 'Frosted', tint: 'Tint',
      copy: 'Copy', copied: 'Copied', notify: 'Notify when a task ends (over 10 s)', lang: 'Language', port: 'Port', done: 'Done',
      privacy: 'Listens on 127.0.0.1:47615 only; nothing leaves this computer. Windows turns Frosted grey while the window is not focused.',
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

// Turns the new markup into the live one in place, so running animations
// (the pulse, the spinner, the flowing bar) and hover are never restarted.
function morph(live, html) {
  const next = document.createElement(live.tagName)
  next.innerHTML = html
  patch(live, next)
}

function patch(a, b) {
  const as = [...a.childNodes]
  const bs = [...b.childNodes]
  bs.forEach((nb, i) => {
    const na = as[i]
    if (!na) return a.appendChild(nb)
    if (na.nodeType !== nb.nodeType || na.nodeName !== nb.nodeName || (na.dataset?.id ?? '') !== (nb.dataset?.id ?? '')) {
      return a.replaceChild(nb, na)
    }
    if (na.nodeType === Node.TEXT_NODE) {
      if (na.nodeValue !== nb.nodeValue) na.nodeValue = nb.nodeValue
      return
    }
    for (const { name } of [...na.attributes]) if (!nb.hasAttribute(name)) na.removeAttribute(name)
    for (const { name, value } of [...nb.attributes]) if (na.getAttribute(name) !== value) na.setAttribute(name, value)
    patch(na, nb)
  })
  for (let i = as.length - 1; i >= bs.length; i--) a.removeChild(as[i])
}

function prettyModel(m) {
  if (!m) return ''
  const x = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(m)
  const wide = /\[1m\]/i.test(m) ? ' · 1M' : ''
  if (!x) return m.replace(/^claude-/, '')
  return `${x[1][0].toUpperCase()}${x[1].slice(1).toLowerCase()} ${x[2]}${x[3] ? '.' + x[3] : ''}${wide}`
}

const ICON = {
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2.2"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/></svg>',
}

function meter(label, pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct ?? 0)))
  const tone = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok'
  return `<div class="meter"><div class="k"><span>${esc(label)}</span><b>${pct == null ? '—' : p + '<small>%</small>'}</b></div>
    <div class="track"><i class="${tone}" style="width:${Math.max(p, 2)}%"></i></div></div>`
}

function ring(pct, big, small, isSpinning = false) {
  const r = 31
  const c = 2 * Math.PI * r
  const off = c * (1 - (pct ?? 0))
  return `<div class="ring${isSpinning ? ' spin' : ''}"><svg viewBox="0 0 76 76">
    <defs><linearGradient id="clay" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0a382"/><stop offset="1" stop-color="#c8603b"/></linearGradient></defs>
    <circle class="track" cx="38" cy="38" r="${r}"/>
    <circle class="fill" cx="38" cy="38" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>
    <div class="ring-text"><b>${esc(big)}</b>${small ? `<span>${esc(small)}</span>` : ''}</div></div>`
}

function stat(label, value, isAccent = false) {
  return `<div class="stat${isAccent ? ' accent' : ''}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`
}

function drawFocus(v, limits) {
  const el = $('focus')
  if (!v) {
    morph(el, `<div class="empty"><b>${esc(state.paired ? W.idleAll : W.none)}</b><span>${esc(W.pairFirst)}</span></div>`)
    return
  }
  const { s } = v
  const t = s.todos
  const lim = k => limits.find(x => x.kind === k)?.percent
  const tag = [prettyModel(s.model), s.effort].filter(Boolean).join(' · ')
  const stats = [
    stat(W.used, clock(v.elapsed)),
    v.eta != null ? stat(W.remain, roughly(v.eta), true) : '',
    s.usd != null ? stat(W.cost, `$${s.usd.toFixed(2)}`) : '',
  ].join('')
  const progress =
    t && t.total
      ? `${ring(v.pct, `${Math.round(v.pct * 100)}%`, `${t.done}/${t.total}`)}
         <div class="steps"><div class="now">${esc(t.current || W.steps(t.done, t.total))}</div><div class="stats">${stats}</div></div>`
      : `${ring(v.status === 'running' ? 0.24 : 1, v.status === 'running' ? '···' : '✓', '', v.status === 'running')}
         <div class="steps"><div class="now dim">${v.status === 'running' ? esc(W.noList) : v.act}</div><div class="stats">${stats}</div></div>`
  morph(el, `
    <div class="head">
      <div class="titles"><div class="project">${esc(s.project)}</div><div class="prompt">${esc(s.prompt ?? '')}</div></div>
      ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}
    </div>
    <div class="doing"><span class="dot ${v.dot}"></span><span class="what">${v.act}</span></div>
    <div class="progress">${progress}</div>
    <div class="meters">${meter(W.ctx, s.ctx)}${meter(W.h5, lim('five_hour'))}${meter(W.d7, lim('seven_day'))}</div>`)
}

function drawList(views) {
  morph(
    $('list'),
    views
      .map(v => {
        const { s } = v
        const isRunning = v.status === 'running'
        const bar = isRunning
          ? `<div class="line">${v.pct != null ? `<i style="width:${Math.max(4, Math.round(v.pct * 100))}%"></i>` : '<i class="flow"></i>'}</div>`
          : ''
        const side = isRunning
          ? `<b>${esc(clock(v.elapsed))}</b>${v.eta != null ? `<em>${esc(W.remain)} ${esc(roughly(v.eta))}</em>` : ''}`
          : `<b>${s.last ? esc(clock(s.last.ms)) : ''}</b>`
        const stop = isRunning
          ? `<button class="stop${stopping.has(s.turnId) ? ' sent' : ''}" data-stop="${esc(s.id)}" data-turn="${esc(s.turnId)}" title="${esc(W.stop)}">${ICON.stop}</button>`
          : ''
        return `<div class="task${s.id === selected ? ' sel' : ''}${isRunning ? ' live' : ''}" data-id="${esc(s.id)}">
          <span class="dot ${v.dot}"></span>
          <div class="main">
            <div class="name"><span>${esc(s.project)}</span><small>${esc(prettyModel(s.model))}</small></div>
            <div class="act">${v.act}</div>
            ${bar}
          </div>
          <div class="side">${side}</div>
          ${stop}
        </div>`
      })
      .join(''),
  )
}

function drawPill(v) {
  const end = v?.pct != null ? `${Math.round(v.pct * 100)}%` : v?.status === 'running' ? clock(v.elapsed) : ''
  morph(
    $('pill'),
    `<span class="dot ${v?.dot ?? ''}"></span>
    <span class="what" data-tauri-drag-region>${v ? `<b>${esc(v.s.project)}</b><span class="sep"></span>${v.act}` : esc(W.idleAll)}</span>
    ${end ? `<span class="pct">${esc(end)}</span>` : ''}
    <button class="icon" id="expand" title="${esc(W.expand)}">${ICON.expand}</button>`,
  )
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
  const root = document.documentElement
  root.classList.toggle('clear', state.clear !== false)
  root.classList.toggle('frosted', state.clear === false)
  root.style.setProperty('--tint', String((state.tint ?? 30) / 100))
  $('summary').textContent = running ? W.running(running) : ''
  $('summary').classList.toggle('live', running > 0)
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
  if ($('copy').dataset.done !== '1') $('copy-text').textContent = W.s.copy
  $('s-notify').textContent = W.s.notify
  $('notify').checked = state.notify
  $('s-look').textContent = W.s.look
  $('look').options[0].textContent = W.s.clear
  $('look').options[1].textContent = W.s.frosted
  $('look').value = state.clear === false ? 'frosted' : 'clear'
  $('s-tint').textContent = W.s.tint
  if (document.activeElement !== $('tint')) $('tint').value = String(state.tint ?? 30)
  $('tint-row').hidden = state.clear === false
  $('s-lang').textContent = W.s.lang
  $('lang').value = state.lang
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
      $('copy-text').textContent = W.s.copied
      t.dataset.done = '1'
      setTimeout(() => { t.dataset.done = ''; drawSettings() }, 1500)
  }
})
$('notify').addEventListener('change', e => setPref('notify', e.target.checked))
$('lang').addEventListener('change', e => setPref('lang', e.target.value))
$('look').addEventListener('change', e => setPref('clear', e.target.value === 'clear'))
$('tint').addEventListener('input', e => {
  state.tint = Number(e.target.value)
  draw()
})
$('tint').addEventListener('change', e => setPref('tint', Number(e.target.value)))

refresh()
setInterval(refresh, 1000)

// ---------- the browser demo ----------

function demo(cmd, args) {
  const now = Date.now()
  if (!demo.s) {
    document.documentElement.classList.add('demo')
    const base = { v: 1, agents: 0, limits: [{ kind: 'five_hour', percent: 34 }, { kind: 'seven_day', percent: 71 }] }
    demo.s = {
      token: 'k7Qm2vX9pL4tR8wZ3nY6', port: 47615, pinned: true, compact: false, notify: true, clear: true, tint: 30,
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

export const KEY_STORE = 'wa-admin-key'
export const SITE_STORE = 'wa-admin-site'
export const ALERT_STORE = 'wa-admin-alerts'
export const DETAILS_STORE = 'wa-admin-details'

export const state = {
  key: sessionStorage.getItem(KEY_STORE) || '',
  staff: '',
  role: 'agent',
  team: [],
  features: {},
  sites: [],
  site: localStorage.getItem(SITE_STORE) || '',
  counts: { needsHelp: 0, withAgent: 0, mine: 0, mineUnread: 0 },
  inboxFilter: 'all',
  inboxQuery: '',
  inboxTag: '',
  activityAuthor: '',
  reportDays: 7,
  alerts: localStorage.getItem(ALERT_STORE) === '1',
  showDetails: localStorage.getItem(DETAILS_STORE) !== '0',
  templates: null,
}

export const hooks = { onSignedOut: () => {}, onCounts: () => {} }

// ---------- DOM ----------

/** Builds DOM nodes; strings always become text nodes, so customer text can never inject HTML. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'value') el.value = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

/** replaceChildren that accepts nested arrays and skips null / false like `h`. */
export function put(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false))
}

const SVG_NS = 'http://www.w3.org/2000/svg'
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v))
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

// ---------- API ----------

async function request(path, init) {
  const res = await fetch(`/v1/admin${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${state.key}`, ...(init.headers || {}) },
  })
  if (res.status === 401) {
    hooks.onSignedOut()
    throw new Error('Signed out')
  }
  return res
}

async function asJson(res) {
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.ok === false) {
    const err = new Error(typeof json.message === 'string' ? json.message : `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return json
}

export async function api(path, opts = {}) {
  const res = await request(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return asJson(res)
}

export async function upload(path, form) {
  return asJson(await request(path, { method: 'POST', body: form }))
}

export async function downloadFile(path, filename) {
  const res = await request(path, { method: 'GET' })
  if (!res.ok) await asJson(res)
  const url = URL.createObjectURL(await res.blob())
  const a = h('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const mediaCache = new Map()
/** Object URL for a WhatsApp media id (fetched with the staff key; cached for the session). */
export function mediaUrl(id) {
  if (!mediaCache.has(id)) {
    const p = request(`/media/${encodeURIComponent(id)}`, { method: 'GET' }).then(async (res) => {
      if (!res.ok) await asJson(res)
      return URL.createObjectURL(await res.blob())
    })
    p.catch(() => mediaCache.delete(id))
    mediaCache.set(id, p)
  }
  return mediaCache.get(id)
}

export const qs = (params) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export async function loadTemplates(refresh = false) {
  if (!state.templates || refresh) state.templates = (await api(`/templates${refresh ? '?refresh=1' : ''}`)).templates
  return state.templates
}

// ---------- formatting ----------

export const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
export const fmtDay = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
export const fmtDateTime = (ts) => `${fmtDay(ts)}, ${fmtTime(ts)}`
export function ago(ts) {
  if (!ts) return ''
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return fmtDay(ts)
}
export const phoneLabel = (p) => (p && p.length === 12 && p.startsWith('91') ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : `+${p}`)
export const siteName = (id) => state.sites.find((s) => s.id === id)?.name || id
export const MODE_LABEL = { bot: 'Bot', needs_help: 'Needs help', agent: 'With agent' }
export const AUTHOR_LABEL = { customer: 'Customer', bot: 'Bot', agent: 'Agent', system: 'Website', campaign: 'Campaign' }
export const modePill = (mode) => h('span', { class: `pill ${mode}` }, MODE_LABEL[mode] || mode)
export const sitePill = (id) => (state.sites.length > 1 ? h('span', { class: 'pill site' }, siteName(id)) : null)
export const tagPill = (t) => h('span', { class: 'pill tag' }, `#${t}`)
export const authorName = (m) =>
  m.author === 'agent' ? m.agent || 'Agent' : m.author === 'bot' && m.agent === 'AI' ? 'Bot · AI' : AUTHOR_LABEL[m.author] || m.author

export function tick(status) {
  if (status === 'read') return h('span', { class: 'tick read', title: 'Read' }, ' ✓✓')
  if (status === 'delivered') return h('span', { class: 'tick', title: 'Delivered' }, ' ✓✓')
  if (status === 'sent') return h('span', { class: 'tick', title: 'Sent' }, ' ✓')
  if (status === 'failed') return h('span', { class: 'tick failed', title: 'Failed' }, ' ⚠')
  return h('span', { class: 'tick', title: 'Accepted by WhatsApp' }, ' ⏱')
}

export function setCounts(counts) {
  state.counts = { ...state.counts, ...counts }
  hooks.onCounts(state.counts)
}

// ---------- polling ----------

let pollTimer = null
export function stopPolling() {
  clearInterval(pollTimer)
  pollTimer = null
}
export function poll(fn, ms) {
  stopPolling()
  pollTimer = setInterval(() => {
    if (!document.hidden) fn().catch(() => {})
  }, ms)
}

export function debounce(fn, ms) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

// ---------- toasts & modals ----------

let toastBox = null
export function toast(text, kind = 'info') {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts' })
    document.body.append(toastBox)
  }
  const el = h('div', { class: `toast ${kind}` }, text)
  toastBox.append(el)
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000)
}

export function openModal(title, body, { wide = false } = {}) {
  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && close()
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'mhead' }, h('b', null, title), h('button', { class: 'x', title: 'Close', onclick: close }, '×')),
    h('div', { class: 'mbody' }, body))
  const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && close() }, box)
  document.addEventListener('keydown', onKey)
  document.body.append(overlay)
  return { close, box }
}

export function confirmModal(title, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      m.close()
      resolve(v)
    }
    const m = openModal(title, h('div', null,
      h('p', { class: 'pre' }, text),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => finish(true) }, okLabel))))
    const observer = new MutationObserver(() => {
      if (!m.box.isConnected) {
        observer.disconnect()
        finish(false)
      }
    })
    observer.observe(document.body, { childList: true })
  })
}

/** Labeled form row. */
export const field = (label, input, hint) =>
  h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'small muted' }, hint) : null)

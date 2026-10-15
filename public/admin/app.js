import { viewInbox } from './chat.js'
import { ALERT_STORE, KEY_STORE, SITE_STORE, api, h, hooks, qs, setCounts, state, stopPolling, toast } from './core.js'
import { viewActivity, viewCampaigns, viewOverview, viewQuickReplies, viewReports } from './pages.js'

const app = document.getElementById('app')
let badgeTimer = null

// ---------- alerts ----------

let audio = null
function beep() {
  try {
    audio ||= new AudioContext()
    const t = audio.currentTime
    for (const [at, freq] of [[0, 880], [0.18, 1175]]) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t + at)
      gain.gain.exponentialRampToValueAtTime(0.25, t + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16)
      osc.connect(gain).connect(audio.destination)
      osc.start(t + at)
      osc.stop(t + at + 0.18)
    }
  } catch {
    // Audio is optional.
  }
}

function notify(text) {
  beep()
  toast(text, 'warn')
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification('WhatsApp Inbox', { body: text, tag: 'wa-inbox' })
    n.onclick = () => {
      window.focus()
      location.hash = '#/inbox'
      n.close()
    }
  }
}

let previous = null
hooks.onCounts = (counts) => {
  if (previous && state.alerts) {
    const parts = []
    if (counts.needsHelp > previous.needsHelp) {
      const n = counts.needsHelp - previous.needsHelp
      parts.push(`${n} customer${n > 1 ? 's' : ''} asked for a person`)
    }
    if (counts.mineUnread > previous.mineUnread) parts.push('New message in your chats')
    if (parts.length) notify(parts.join(' · '))
  }
  previous = { ...counts }
  drawBadges()
}

async function toggleAlerts() {
  state.alerts = !state.alerts
  localStorage.setItem(ALERT_STORE, state.alerts ? '1' : '0')
  if (state.alerts) {
    beep()
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission()
    toast('Alerts on: sound + desktop notification when someone needs help')
  }
  render()
}

// ---------- auth ----------

function logout() {
  sessionStorage.removeItem(KEY_STORE)
  state.key = ''
  state.staff = ''
  stopPolling()
  clearInterval(badgeTimer)
  render()
}
hooks.onSignedOut = logout

function renderLogin() {
  const input = h('input', { type: 'password', placeholder: 'Staff key', autocomplete: 'current-password', required: true })
  const error = h('div', { class: 'error' })
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault()
        error.textContent = ''
        state.key = input.value.trim()
        try {
          await loadMe()
          sessionStorage.setItem(KEY_STORE, state.key)
          render()
        } catch (err) {
          state.key = ''
          error.textContent = err.message === 'Signed out' ? 'Wrong key' : err.message
        }
      },
    },
    h('h1', null, 'WhatsApp Inbox'),
    h('p', null, 'Sign in with your staff key to see chats, help customers and step into conversations.'),
    input,
    h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
    error,
  )
  app.replaceChildren(h('div', { class: 'login' }, form))
  input.focus()
}

async function loadMe() {
  const me = await api('/me')
  state.staff = me.staff
  state.role = me.role
  state.team = me.team
  state.features = me.features
  state.sites = me.sites
  if (state.site && !state.sites.some((s) => s.id === state.site)) state.site = ''
}

// ---------- shell ----------

function route() {
  const [view = 'overview', arg = ''] = location.hash.replace(/^#\/?/, '').split('/')
  return { view: view || 'overview', arg: decodeURIComponent(arg) }
}

const badges = { help: null, mine: null }
function drawBadges() {
  const { needsHelp, mineUnread } = state.counts
  if (badges.help) {
    badges.help.textContent = needsHelp > 99 ? '99+' : String(needsHelp)
    badges.help.hidden = !needsHelp
  }
  if (badges.mine) {
    badges.mine.textContent = String(mineUnread)
    badges.mine.hidden = !mineUnread
  }
  document.title = needsHelp ? `(${needsHelp}) WhatsApp Inbox` : 'WhatsApp Inbox'
}

function renderShell(main) {
  const { view } = route()
  const link = (id, label, ...extra) => h('a', { href: `#/${id}`, class: view === id ? 'active' : '' }, h('span', null, label), h('span', { class: 'badges' }, extra))
  badges.help = h('span', { class: 'count', title: 'Waiting for a person' })
  badges.mine = h('span', { class: 'count mine', title: 'Unread in your chats' })

  const siteSelect =
    state.sites.length > 1
      ? h(
          'select',
          {
            onchange: (e) => {
              state.site = e.target.value
              localStorage.setItem(SITE_STORE, state.site)
              render()
            },
          },
          h('option', { value: '' }, 'All sites'),
          state.sites.map((s) => h('option', { value: s.id, selected: s.id === state.site ? true : null }, s.name)),
        )
      : null

  const side = h(
    'nav',
    { class: 'side' },
    h('div', { class: 'logo' }, 'WhatsApp Inbox'),
    siteSelect,
    link('overview', 'Overview'),
    link('inbox', 'Chats', badges.mine, badges.help),
    link('activity', 'Activity'),
    link('campaigns', 'Campaigns'),
    link('reports', 'Reports'),
    link('replies', 'Quick replies'),
    h('div', { class: 'spacer' }),
    h('button', { class: `link alerts${state.alerts ? ' on' : ''}`, onclick: toggleAlerts, title: 'Sound and desktop notification for new help requests' },
      state.alerts ? '🔔 Alerts on' : '🔕 Alerts off'),
    h('div', { class: 'who' }, `Signed in as ${state.staff}`, state.role === 'admin' ? ' (admin)' : ''),
    h('button', { class: 'link', onclick: logout }, 'Sign out'),
  )
  app.replaceChildren(h('div', { class: 'shell' }, side, main))
  drawBadges()
}

async function refreshBadge() {
  const res = await api(`/chats${qs({ site: state.site, limit: 1 })}`)
  setCounts(res.counts)
}

async function render() {
  stopPolling()
  if (!state.key) return renderLogin()
  if (!state.staff) {
    try {
      await loadMe()
    } catch {
      return
    }
  }
  const main = h('main')
  renderShell(main)
  clearInterval(badgeTimer)
  refreshBadge().catch(() => {})
  // Keeps running in background tabs so alerts still fire.
  badgeTimer = setInterval(() => refreshBadge().catch(() => {}), 15000)

  const { view, arg } = route()
  if (view === 'inbox') return viewInbox(main, arg)
  if (view === 'activity') return viewActivity(main)
  if (view === 'campaigns') return viewCampaigns(main)
  if (view === 'reports') return viewReports(main)
  if (view === 'replies') return viewQuickReplies(main)
  return viewOverview(main)
}

window.addEventListener('hashchange', render)
render()

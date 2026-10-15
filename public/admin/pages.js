import {
  AUTHOR_LABEL, ago, api, authorName, confirmModal, downloadFile, field, fmtDateTime, h, openModal, phoneLabel, poll, qs,
  put, setCounts, siteName, sitePill, state, svg, tick, toast,
} from './core.js'
import { templateForm } from './templates.js'

// ---------- overview ----------

export function viewOverview(main) {
  const body = h('div', { class: 'page' }, h('h2', null, 'Overview'), h('p', { class: 'muted' }, 'Loading…'))
  main.replaceChildren(body)

  async function load() {
    const o = await api(`/overview${qs({ site: state.site })}`)
    const s = o.stats
    const card = (n, l, alert, href) =>
      h(href ? 'a' : 'div', { class: `card${alert ? ' alert' : ''}${href ? ' cardlink' : ''}`, href },
        h('div', { class: 'n' }, n), h('div', { class: 'l' }, l))

    const waiting = o.waiting.length
      ? h('table', null,
          h('tr', null, h('th', null, 'Customer'), h('th', null, 'Site'), h('th', null, 'Waiting since')),
          o.waiting.map((c) =>
            h('tr', { class: 'click', onclick: () => (location.hash = `#/inbox/${c.phone}`) },
              h('td', null, h('b', null, c.name || phoneLabel(c.phone)), h('div', { class: 'small muted' }, c.lastText || '')),
              h('td', null, siteName(c.site)),
              h('td', null, ago(c.lastMessageAt)))))
      : h('div', { class: 'empty' }, 'Nobody is waiting. 🎉')

    const sites = h('table', null,
      h('tr', null, h('th', null, 'Site'), h('th', null, 'Chats'), h('th', null, 'In'), h('th', null, 'Out')),
      o.sites.map((x) => h('tr', null, h('td', null, x.name), h('td', null, x.chats), h('td', null, x.inbound), h('td', null, x.outbound))))

    setCounts({ needsHelp: s.needsHelp, withAgent: s.withAgent })
    body.replaceChildren(
      h('h2', null, 'Overview ', h('span', { class: 'muted small' }, '· last 24 hours')),
      h('div', { class: 'cards' },
        card(s.needsHelp, 'Waiting for a person', s.needsHelp > 0, '#/inbox'),
        card(s.withAgent, 'Chats with staff'),
        card(s.activeChats, 'Customers who wrote'),
        card(s.newChats, 'New customers'),
        card(s.inbound, 'Messages received'),
        card(s.botReplies, `Bot replies${s.aiReplies ? ` (${s.aiReplies} AI)` : ''}`),
        card(s.agentReplies, 'Staff replies'),
        card(s.systemMessages, 'OTP & website messages'),
        card(s.campaignMessages, 'Campaign messages'),
        card(s.failed, 'Failed deliveries', s.failed > 0, '#/activity'),
        card(s.optOuts, 'Opted out (STOP)'),
        card(s.runningCampaigns, 'Campaigns running', false, '#/campaigns')),
      h('div', { class: 'grid2' },
        h('div', { class: 'box' }, h('h3', null, 'Waiting for help'), waiting),
        h('div', { class: 'box' }, h('h3', null, 'By site'), sites)),
    )
  }
  load().catch((e) => body.replaceChildren(h('p', { class: 'error' }, e.message)))
  poll(load, 10000)
}

// ---------- activity ----------

export function viewActivity(main) {
  const list = h('div', { class: 'box feed' }, h('div', { class: 'empty' }, 'Loading…'))
  const authorSelect = h('select', {
    onchange: (e) => {
      state.activityAuthor = e.target.value
      load().catch(() => {})
    },
  },
  h('option', { value: '' }, 'Everything'),
  [...Object.entries(AUTHOR_LABEL), ['ai', 'AI answers']].map(([id, label]) =>
    h('option', { value: id, selected: state.activityAuthor === id ? true : null }, label)))
  main.replaceChildren(h('div', { class: 'page' }, h('h2', null, 'Activity'), h('div', { class: 'filters' }, h('span', { class: 'muted small' }, 'Show'), authorSelect), list))

  async function load() {
    const res = await api(`/activity${qs({ site: state.site, author: state.activityAuthor, limit: 150 })}`)
    if (!res.events.length) {
      list.replaceChildren(h('div', { class: 'empty' }, 'Nothing yet.'))
      return
    }
    list.replaceChildren(
      ...res.events.map((e) =>
        h('div', { class: 'row', onclick: () => (location.hash = `#/inbox/${e.phone}`), title: fmtDateTime(e.at) },
          h('span', { class: 'small muted' }, ago(e.at)),
          h('span', null, h('span', { class: `pill ${e.author}${e.agent === 'AI' ? ' ai' : ''}` }, authorName(e))),
          h('span', { class: 'text' },
            h('b', null, e.name || phoneLabel(e.phone)), ' ', sitePill(e.site), ' ',
            e.direction === 'out' ? tick(e.status) : null, ' ',
            e.media ? '📎 ' : '',
            (e.text || `[${e.type}]`).replace(/\s+/g, ' '),
            e.status === 'failed' && e.error ? h('span', { class: 'error' }, ` — ${e.error}`) : null)),
      ),
    )
  }
  load().catch((e) => list.replaceChildren(h('div', { class: 'empty error' }, e.message)))
  poll(load, 8000)
}

// ---------- campaigns ----------

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—')

function campaignForm(onCreated) {
  const site = h('select', null, state.sites.map((s) => h('option', { value: s.id, selected: s.id === state.site ? true : null }, s.name)))
  const name = h('input', { type: 'text', placeholder: 'e.g. Diwali offer 2026', maxlength: 120 })
  const tform = templateForm({ filter: (t) => t.category === 'MARKETING' || t.category === 'UTILITY' })

  let audience = 'list'
  const phones = h('textarea', { rows: 5, placeholder: 'One number per line (or comma separated). +91 optional for Indian numbers.' })
  const count = h('span', { class: 'small muted' })
  const parsePhones = () => phones.value.split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s.replace(/\D/g, '').length >= 10)
  const updateCount = () => (count.textContent = `${parsePhones().length} numbers`)
  phones.addEventListener('input', updateCount)
  const csv = h('input', {
    type: 'file', accept: '.csv,.txt',
    onchange: async (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      const found = []
      for (const line of (await file.text()).split(/\r?\n/)) {
        const m = line.match(/\+?\d[\d\s-]{8,}\d/)
        if (m) found.push(m[0].replace(/[\s-]/g, ''))
      }
      phones.value = [...new Set(found)].join('\n')
      updateCount()
      toast(`Loaded ${found.length} numbers from ${file.name}`)
    },
  })
  const tag = h('select')
  api('/tags').then((res) => put(tag,
    res.tags.length ? null : h('option', { value: '' }, 'No tags yet'),
    res.tags.map((t) => h('option', { value: t.tag }, `#${t.tag} (${t.n})`)),
  )).catch(() => {})
  const requireOptIn = h('input', { type: 'checkbox', checked: true })

  const panes = {
    list: h('div', { class: 'stack' }, phones, h('div', { class: 'row' }, h('span', { class: 'small' }, 'or upload CSV:'), csv, count)),
    tag: field('Customers with tag', tag, 'Everyone whose chat has this tag (for the selected website).'),
    opted_in: h('p', { class: 'small muted' }, 'Everyone who opted in to marketing for the selected website (STOP replies are always skipped).'),
  }
  const paneBox = h('div', null, panes.list)
  const radios = h('div', { class: 'row' }, [['list', 'Paste / upload numbers'], ['tag', 'Customers with a tag'], ['opted_in', 'Everyone opted in']].map(([id, label]) =>
    h('label', { class: 'radio' }, h('input', {
      type: 'radio', name: 'aud', value: id, checked: id === audience ? true : null,
      onchange: () => {
        audience = id
        paneBox.replaceChildren(panes[id])
      },
    }), label)))

  const launch = h('button', { class: 'btn primary' }, 'Launch campaign')
  launch.addEventListener('click', async () => {
    const t = tform.value()
    if (!name.value.trim()) return toast('Give the campaign a name', 'error')
    if (!t) return toast('Choose a template', 'error')
    const list = audience === 'list' ? parsePhones() : []
    if (audience === 'list' && !list.length) return toast('Add at least one phone number', 'error')
    const who = audience === 'list' ? `${list.length} numbers` : audience === 'tag' ? `customers tagged #${tag.value}` : 'everyone opted in'
    const ok = await confirmModal('Launch campaign?',
      `Send “${t.name}” (${t.category.toLowerCase()}) from ${siteName(site.value)} to ${who}.\n\n` +
      (t.category === 'MARKETING' || requireOptIn.checked ? 'Only customers who opted in (and did not reply STOP) will receive it.' : 'Opt-in is not required for this utility campaign.') +
      '\n\nThis cannot be undone, but you can cancel while it is sending.', 'Launch')
    if (!ok) return
    launch.disabled = true
    try {
      const res = await api('/campaigns', {
        method: 'POST',
        body: {
          site: site.value || state.sites[0]?.id, name: name.value.trim(), templateName: t.name, language: t.language, values: t.values,
          audience, phones: list, tag: tag.value || undefined, requireOptIn: requireOptIn.checked,
        },
      })
      toast(`Queued ${res.queued}, skipped ${res.skipped} (no consent), invalid ${res.invalid}`)
      onCreated()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      launch.disabled = false
    }
  })

  return h('div', { class: 'box pad stack' },
    h('h3', { class: 'flat' }, 'New campaign'),
    h('div', { class: 'grid3' }, field('Name', name), state.sites.length > 1 ? field('From website', site) : null),
    tform.root,
    h('div', { class: 'stack' }, h('b', null, 'Who gets it'), radios, paneBox),
    h('label', { class: 'radio' }, requireOptIn, 'Only send to customers who opted in (always on for marketing templates)'),
    h('div', { class: 'row end' }, launch))
}

function openCampaign(id, onChange) {
  const body = h('div', { class: 'stack' }, h('div', { class: 'muted' }, 'Loading…'))
  const m = openModal('Campaign', body, { wide: true })
  async function load() {
    const res = await api(`/campaigns/${id}`)
    const c = res.campaign
    const t = res.totals
    const running = c.status === 'queued' || c.status === 'processing'
    const bar = (n, cls) => h('div', { class: `seg ${cls}`, style: null, 'data-w': n })
    const progress = h('div', { class: 'progress' }, bar(t.read, 'read'), bar(t.delivered - t.read, 'delivered'), bar(t.sent - t.delivered, 'sent'), bar(t.failed, 'failed'), bar(t.pending, 'pending'))
    for (const seg of progress.children) seg.style.flexGrow = seg.getAttribute('data-w')
    put(body,
      h('div', null, h('b', null, c.name), h('div', { class: 'small muted' }, `${c.template_name} · ${String(c.category).toLowerCase()} · ${siteName(c.site_id)} · ${fmtDateTime(c.created_at)} · ${c.status}`)),
      h('div', { class: 'cards' },
        [[t.total, 'Recipients'], [t.pending, 'Waiting'], [t.sent, `Sent (${pct(t.sent, t.total)})`], [t.delivered, `Delivered (${pct(t.delivered, t.total)})`], [t.read, `Read (${pct(t.read, t.total)})`], [t.failed, 'Failed / skipped']]
          .map(([n, l]) => h('div', { class: 'card' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l)))),
      progress,
      res.failed.length
        ? h('div', { class: 'box' }, h('h3', null, `Failed or skipped (${res.failed.length}${res.failed.length === 200 ? '+' : ''})`),
            h('table', null, h('tr', null, h('th', null, 'Phone'), h('th', null, 'Reason')),
              res.failed.map((r) => h('tr', null, h('td', null, phoneLabel(r.phone)), h('td', { class: 'small' }, r.error || '')))))
        : null,
      running && state.role === 'admin'
        ? h('div', { class: 'row end' }, h('button', {
            class: 'btn danger',
            onclick: async () => {
              if (!(await confirmModal('Cancel campaign?', 'Messages already sent stay sent. Everyone still waiting is skipped.', 'Cancel campaign'))) return
              try {
                await api(`/campaigns/${id}/cancel`, { method: 'POST', body: {} })
                toast('Campaign cancelled')
                onChange()
                await load()
              } catch (e) {
                toast(e.message, 'error')
              }
            },
          }, 'Cancel campaign'))
        : null,
    )
  }
  load().catch((e) => body.replaceChildren(h('div', { class: 'error' }, e.message)))
  const timer = setInterval(() => (m.box.isConnected ? load().catch(() => {}) : clearInterval(timer)), 5000)
}

export function viewCampaigns(main) {
  const box = h('div', { class: 'box' }, h('div', { class: 'empty' }, 'Loading…'))
  const formSlot = h('div')
  const canCreate = state.role === 'admin' && state.features.templates
  const newBtn = canCreate
    ? h('button', {
        class: 'btn primary',
        onclick: () => {
          if (formSlot.firstChild) return formSlot.replaceChildren()
          formSlot.replaceChildren(campaignForm(() => {
            formSlot.replaceChildren()
            load().catch(() => {})
          }))
        },
      }, '+ New campaign')
    : null
  main.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'pagehead' }, h('h2', null, 'Campaigns'), newBtn),
    !state.features.templates ? h('p', { class: 'small muted' }, 'Set WHATSAPP_WABA_ID to create campaigns from here.') : null,
    formSlot, box))

  async function load() {
    const res = await api(`/campaigns${qs({ site: state.site })}`)
    if (!res.campaigns.length) {
      box.replaceChildren(h('div', { class: 'empty' }, 'No campaigns yet.'))
      return
    }
    box.replaceChildren(
      h('table', null,
        h('tr', null, ['Campaign', 'Site', 'Status', 'Recipients', 'Sent', 'Delivered', 'Read', 'Failed', 'Created'].map((t) => h('th', null, t))),
        res.campaigns.map((c) =>
          h('tr', { class: 'click', onclick: () => openCampaign(c.id, () => load().catch(() => {})) },
            h('td', null, h('b', null, c.name), h('div', { class: 'small muted' }, `${c.template_name} · ${String(c.category).toLowerCase()}`)),
            h('td', null, siteName(c.site_id)),
            h('td', null, h('span', { class: `pill status-${c.status}` }, c.status)),
            h('td', null, c.total),
            h('td', null, c.sent),
            h('td', null, `${c.delivered} (${pct(c.delivered, c.total)})`),
            h('td', null, `${c.read} (${pct(c.read, c.total)})`),
            h('td', null, c.failed),
            h('td', { class: 'small' }, fmtDateTime(c.created_at))))),
    )
  }
  load().catch((e) => box.replaceChildren(h('div', { class: 'empty error' }, e.message)))
  poll(load, 15000)
}

// ---------- reports ----------

const SERIES = [
  ['bot', 'Bot', 'c-bot'],
  ['ai', 'AI', 'c-ai'],
  ['agent', 'Staff', 'c-agent'],
  ['system', 'OTP & website', 'c-system'],
  ['campaign', 'Campaign', 'c-campaign'],
]

function chart(series) {
  const W = 900
  const H = 240
  const L = 40
  const B = 26
  const T = 10
  const max = Math.max(1, ...series.map((d) => Math.max(d.inbound, SERIES.reduce((s, [k]) => s + d[k], 0))))
  const step = (W - L) / series.length
  const bw = Math.max(3, Math.min(18, step * 0.36))
  const y = (v) => T + (H - T - B) * (1 - v / max)
  const nodes = []
  for (const frac of [0, 0.5, 1]) {
    const v = Math.round(max * frac)
    nodes.push(svg('line', { x1: L, x2: W, y1: y(v), y2: y(v), class: 'grid' }), svg('text', { x: L - 6, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, v))
  }
  const labelEvery = Math.ceil(series.length / 12)
  series.forEach((d, i) => {
    const x = L + i * step + step / 2
    nodes.push(svg('rect', { x: x - bw - 1, y: y(d.inbound), width: bw, height: y(0) - y(d.inbound), class: 'c-in' },
      svg('title', null, `${d.day}: ${d.inbound} received`)))
    let acc = 0
    for (const [k, label, cls] of SERIES) {
      if (!d[k]) continue
      nodes.push(svg('rect', { x: x + 1, y: y(acc + d[k]), width: bw, height: y(acc) - y(acc + d[k]), class: cls },
        svg('title', null, `${d.day}: ${d[k]} ${label}`)))
      acc += d[k]
    }
    if (i % labelEvery === 0) nodes.push(svg('text', { x, y: H - 8, class: 'axis', 'text-anchor': 'middle' }, d.day.slice(5)))
  })
  return h('div', null,
    svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Messages per day' }, nodes),
    h('div', { class: 'legend' }, h('span', null, h('i', { class: 'c-in' }), 'Received'), SERIES.map(([, label, cls]) => h('span', null, h('i', { class: cls }), label))))
}

export function viewReports(main) {
  const body = h('div', null, h('p', { class: 'muted' }, 'Loading…'))
  const range = h('select', {
    onchange: (e) => {
      state.reportDays = Number(e.target.value)
      load().catch((err) => toast(err.message, 'error'))
    },
  }, [7, 30, 90].map((d) => h('option', { value: d, selected: d === state.reportDays ? true : null }, `Last ${d} days`)))
  const exports = state.role === 'admin'
    ? h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => downloadFile(`/export/messages.csv${qs({ site: state.site, days: Math.max(state.reportDays, 30) })}`, 'whatsapp-messages.csv').catch((e) => toast(e.message, 'error')) }, '⬇ Messages CSV'),
        h('button', { class: 'btn', onclick: () => downloadFile(`/export/chats.csv${qs({ site: state.site })}`, 'whatsapp-chats.csv').catch((e) => toast(e.message, 'error')) }, '⬇ Customers CSV'))
    : null
  main.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'pagehead' }, h('h2', null, 'Reports'), h('div', { class: 'row' }, range, exports)), body))

  async function load() {
    const r = await api(`/reports${qs({ site: state.site, days: state.reportDays, tz: -new Date().getTimezoneOffset() })}`)
    const sum = (k) => r.series.reduce((s, d) => s + d[k], 0)
    const mins = (v) => (v == null ? '—' : v < 60 ? `${v} min` : `${Math.round(v / 6) / 10} h`)
    const card = (n, l, alert) => h('div', { class: `card${alert ? ' alert' : ''}` }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l))
    const s = r.support
    const table = (head, rows, empty) => rows.length
      ? h('table', null, h('tr', null, head.map((t) => h('th', null, t))), rows)
      : h('div', { class: 'empty' }, empty)

    body.replaceChildren(
      h('div', { class: 'cards' },
        card(sum('inbound'), 'Messages received'),
        card(sum('newChats'), 'New customers'),
        card(sum('bot') + sum('ai'), `Bot replies (${sum('ai')} AI)`),
        card(sum('agent'), 'Staff replies'),
        card(s.requests, 'Asked for a person'),
        card(mins(s.avgFirstReplyMin), 'Avg first staff reply'),
        card(mins(s.medianFirstReplyMin), 'Median first reply'),
        card(`${s.answered ? Math.round((s.within15Min / s.answered) * 100) : 0}%`, 'Answered within 15 min'),
        card(s.unanswered, 'Never answered', s.unanswered > 0),
        card(sum('failed'), 'Failed deliveries', sum('failed') > 0)),
      h('div', { class: 'box pad' }, h('h3', { class: 'flat' }, 'Messages per day'), chart(r.series)),
      h('div', { class: 'grid2' },
        h('div', { class: 'box' }, h('h3', null, 'Staff'),
          table(['Name', 'Messages', 'Chats', 'First replies', 'Avg first reply'],
            r.staff.map((x) => h('tr', null, h('td', null, x.name), h('td', null, x.messages), h('td', null, x.chats), h('td', null, x.firstReplies), h('td', null, mins(x.avgFirstReplyMin)))),
            'No staff replies in this period.')),
        h('div', { class: 'box' }, h('h3', null, 'Help requests per day'),
          table(['Day', 'Requests', 'New customers'],
            r.series.filter((d) => d.helpRequests || d.newChats).slice(-14).reverse().map((d) => h('tr', null, h('td', null, d.day), h('td', null, d.helpRequests), h('td', null, d.newChats))),
            'Nothing yet.'))),
      h('div', { class: 'grid2' },
        h('div', { class: 'box' }, h('h3', null, 'Most tapped menu options'),
          table(['Option', 'Taps'], r.topChoices.map((x) => h('tr', null, h('td', null, x.text), h('td', null, x.n))), 'No menu taps yet.')),
        h('div', { class: 'box' }, h('h3', null, 'Most common typed messages'),
          table(['Message', 'Times'], r.topQuestions.map((x) => h('tr', null, h('td', null, x.text), h('td', null, x.n))), 'No repeated questions yet.'))),
    )
  }
  load().catch((e) => body.replaceChildren(h('p', { class: 'error' }, e.message)))
  poll(load, 60000)
}

// ---------- quick replies ----------

export function viewQuickReplies(main) {
  const box = h('div', { class: 'box' }, h('div', { class: 'empty' }, 'Loading…'))
  const isAdmin = state.role === 'admin'
  const title = h('input', { type: 'text', maxlength: 60, placeholder: 'e.g. KYC pending' })
  const text = h('textarea', { rows: 4, placeholder: 'Hi {name}, your KYC is being reviewed…' })
  const site = h('select', null, h('option', { value: '' }, 'All websites'), state.sites.map((s) => h('option', { value: s.id }, s.name)))
  const add = h('button', {
    class: 'btn primary',
    onclick: async () => {
      if (!title.value.trim() || !text.value.trim()) return toast('Add a title and the reply text', 'error')
      try {
        await api('/quick-replies', { method: 'POST', body: { title: title.value.trim(), text: text.value.trim(), site: site.value || null } })
        title.value = ''
        text.value = ''
        toast('Saved')
        await load()
      } catch (e) {
        toast(e.message, 'error')
      }
    },
  }, 'Save reply')
  const form = isAdmin
    ? h('div', { class: 'box pad stack' },
        h('h3', { class: 'flat' }, 'Add a saved reply'),
        h('div', { class: 'grid3' }, field('Title', title), state.sites.length > 1 ? field('Website', site) : null),
        field('Reply', text, 'Placeholders: {name} = customer first name, {site} = website name, {agent} = your name'),
        h('div', { class: 'row end' }, add))
    : h('p', { class: 'small muted' }, 'Only admins can add or remove saved replies.')
  main.replaceChildren(h('div', { class: 'page' }, h('h2', null, 'Quick replies'),
    h('p', { class: 'small muted' }, 'Use them in any chat with the ⚡ button or by typing / in an empty reply box.'), form, box))

  async function load() {
    const res = await api('/quick-replies')
    if (!res.quickReplies.length) return box.replaceChildren(h('div', { class: 'empty' }, 'No saved replies yet.'))
    box.replaceChildren(h('table', null,
      h('tr', null, h('th', null, 'Title'), h('th', null, 'Reply'), h('th', null, 'Website'), isAdmin ? h('th', null, '') : null),
      res.quickReplies.map((q) => h('tr', null,
        h('td', null, h('b', null, q.title), h('div', { class: 'small muted' }, q.createdBy)),
        h('td', { class: 'pre' }, q.text),
        h('td', null, q.site ? siteName(q.site) : 'All'),
        isAdmin
          ? h('td', null, h('button', {
              class: 'btn small',
              onclick: async () => {
                if (!(await confirmModal('Delete saved reply?', q.title, 'Delete'))) return
                try {
                  await api(`/quick-replies/${q.id}`, { method: 'DELETE' })
                  await load()
                } catch (e) {
                  toast(e.message, 'error')
                }
              },
            }, 'Delete'))
          : null))))
  }
  load().catch((e) => box.replaceChildren(h('div', { class: 'empty error' }, e.message)))
}

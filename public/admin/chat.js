import {
  AUTHOR_LABEL, DETAILS_STORE, ago, api, authorName, debounce, fmtDateTime, fmtDay, fmtTime, h, mediaUrl, modePill,
  openModal, phoneLabel, poll, put, qs, setCounts, siteName, sitePill, state, tagPill, tick, toast, upload,
} from './core.js'
import { openNewChatModal, openTemplateModal } from './templates.js'

// ---------- inbox ----------

export function viewInbox(main, openPhone) {
  const items = h('div', { class: 'items' })
  const search = h('input', {
    type: 'search',
    placeholder: 'Search name or number',
    value: state.inboxQuery,
    oninput: debounce((e) => {
      state.inboxQuery = e.target.value
      loadList().catch(() => {})
    }, 300),
  })
  const tagSelect = h('select', {
    title: 'Filter by tag',
    onchange: (e) => {
      state.inboxTag = e.target.value
      loadList().catch(() => {})
    },
  })
  api('/tags').then((res) => {
    put(tagSelect,
      h('option', { value: '' }, 'All tags'),
      res.tags.map((t) => h('option', { value: t.tag, selected: t.tag === state.inboxTag ? true : null }, `#${t.tag} (${t.n})`)),
    )
    tagSelect.hidden = !res.tags.length
  }).catch(() => {})
  tagSelect.hidden = true

  const tabDefs = [
    ['all', 'All'],
    ['needs_help', 'Needs help'],
    ['mine', 'My chats'],
    ['agent', 'With agent'],
    ['unread', 'Unread'],
    ['bot', 'Bot'],
  ]
  const tabs = h('div', { class: 'tabs' })
  function drawTabs(counts) {
    tabs.replaceChildren(
      ...tabDefs.map(([id, label]) => {
        const n = id === 'needs_help' ? counts?.needsHelp : id === 'agent' ? counts?.withAgent : id === 'mine' ? counts?.mine : 0
        return h('button', {
          class: `${state.inboxFilter === id ? 'on' : ''}${id === 'needs_help' && n ? ' hot' : ''}`,
          onclick: () => {
            state.inboxFilter = id
            drawTabs(counts)
            loadList().catch(() => {})
          },
        }, n ? `${label} (${n})` : label)
      }),
    )
  }
  drawTabs(state.counts)

  const newChat = state.features.templates
    ? h('button', { class: 'btn primary small', onclick: openNewChatModal, title: 'Message a number that has not written yet' }, '+ New chat')
    : null
  const list = h('section', { class: 'list' },
    h('div', { class: 'tools' }, tabs, h('div', { class: 'row' }, search, tagSelect, newChat)),
    items)
  const chatPane = h('section', { class: 'chat' }, h('div', { class: 'placeholder' }, 'Select a chat'))
  const layout = h('div', { class: `inbox${openPhone ? ' open' : ''}` }, list, chatPane)
  main.replaceChildren(layout)

  async function loadList() {
    const res = await api(`/chats${qs({
      site: state.site,
      mode: state.inboxFilter === 'all' ? '' : state.inboxFilter,
      q: state.inboxQuery,
      tag: state.inboxTag,
    })}`)
    setCounts(res.counts)
    drawTabs(res.counts)
    if (!res.chats.length) {
      items.replaceChildren(h('div', { class: 'empty' }, 'No chats here.'))
      return
    }
    items.replaceChildren(
      ...res.chats.map((c) =>
        h('div', { class: `item${c.phone === openPhone ? ' on' : ''}`, onclick: () => (location.hash = `#/inbox/${c.phone}`) },
          h('div', { class: 'top' },
            h('span', { class: 'name' }, c.name || phoneLabel(c.phone)),
            h('span', { class: 'small muted' }, ago(c.lastMessageAt))),
          h('div', { class: 'last' }, c.lastAuthor && c.lastAuthor !== 'customer' ? `${AUTHOR_LABEL[c.lastAuthor] || c.lastAuthor}: ` : '', c.lastText || ''),
          h('div', { class: 'meta' },
            c.mode !== 'bot' ? modePill(c.mode) : null,
            c.mode === 'agent' && c.assignedTo ? h('span', { class: 'small muted' }, c.assignedTo === state.staff ? 'you' : c.assignedTo) : null,
            sitePill(c.site),
            c.tags.slice(0, 3).map(tagPill),
            c.unread ? h('span', { class: 'unread' }, c.unread) : null)),
      ),
    )
  }

  const chat = openPhone ? mountChat(chatPane, openPhone, () => loadList().catch(() => {})) : null
  loadList().catch((e) => items.replaceChildren(h('div', { class: 'empty error' }, e.message)))
  poll(async () => {
    await loadList()
    if (chat) await chat.refresh()
  }, 4000)
}

// ---------- media ----------

function mediaKind(m) {
  if (m.type !== 'media') return m.type
  const mime = m.media.mime || ''
  if (/^image\/(jpeg|png)$/.test(mime)) return 'image'
  if (mime === 'image/webp') return 'sticker'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'document'
}

function mediaNode(m) {
  const kind = mediaKind(m)
  const name = m.media.name || kind
  const failed = (el, e) => el.replaceWith(h('div', { class: 'small muted' }, `${name}: ${e.message}`))

  if (kind === 'image' || kind === 'sticker') {
    const img = h('img', { class: `media-img${kind === 'sticker' ? ' sticker' : ''}`, alt: name })
    mediaUrl(m.media.id).then((u) => (img.src = u)).catch((e) => failed(img, e))
    img.addEventListener('click', () => img.src && openModal(name, h('img', { class: 'media-full', src: img.src, alt: name }), { wide: true }))
    return img
  }
  if (kind === 'audio' || kind === 'video') {
    const btn = h('button', { class: 'btn small media-btn' }, kind === 'audio' ? '▶ Play voice note / audio' : '▶ Play video')
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        const src = await mediaUrl(m.media.id)
        const player = h(kind, { controls: true, src, class: 'media-player' })
        btn.replaceWith(player)
        player.play().catch(() => {})
      } catch (e) {
        failed(btn, e)
      }
    })
    return btn
  }
  const btn = h('button', { class: 'btn small media-btn' }, `📄 ${name}`)
  btn.addEventListener('click', async () => {
    btn.disabled = true
    try {
      const url = await mediaUrl(m.media.id)
      const a = h('a', { href: url, download: name })
      document.body.append(a)
      a.click()
      a.remove()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      btn.disabled = false
    }
  })
  return btn
}

// ---------- quick replies ----------

const fillQuick = (text, chat) =>
  text
    .replace(/\{name\}/g, (chat.name || '').split(/\s+/)[0] || 'there')
    .replace(/\{site\}/g, siteName(chat.site))
    .replace(/\{agent\}/g, state.staff)

function quickRepliesPopover(anchor, chat, onPick) {
  const filter = h('input', { type: 'search', placeholder: 'Search saved replies…' })
  const list = h('div', { class: 'qlist' }, h('div', { class: 'small muted pad' }, 'Loading…'))
  const pop = h('div', { class: 'popover' }, filter, list)
  let replies = []
  const close = () => {
    pop.remove()
    document.removeEventListener('mousedown', outside)
  }
  const outside = (e) => !pop.contains(e.target) && e.target !== anchor && close()
  function draw() {
    const q = filter.value.toLowerCase()
    const shown = replies.filter((r) => !q || r.title.toLowerCase().includes(q) || r.text.toLowerCase().includes(q))
    list.replaceChildren(...(shown.length
      ? shown.map((r) => h('button', { class: 'qitem', onclick: () => { onPick(fillQuick(r.text, chat)); close() } },
          h('b', null, r.title), h('span', { class: 'small muted' }, r.text.slice(0, 90))))
      : [h('div', { class: 'small muted pad' }, replies.length ? 'No match' : 'No saved replies yet. Admins add them under Quick replies.')]))
  }
  filter.addEventListener('input', draw)
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
    if (e.key === 'Enter') list.querySelector('.qitem')?.click()
  })
  api(`/quick-replies${qs({ site: chat.site })}`).then((res) => {
    replies = res.quickReplies
    draw()
  }).catch((e) => list.replaceChildren(h('div', { class: 'error pad' }, e.message)))
  anchor.parentElement.append(pop)
  setTimeout(() => document.addEventListener('mousedown', outside))
  filter.focus()
}

// ---------- chat ----------

function mountChat(pane, phone, onChange) {
  const head = h('div', { class: 'head' })
  const notices = h('div')
  const msgs = h('div', { class: 'msgs' })
  const details = h('aside', { class: 'details', hidden: state.showDetails ? null : true })

  const textarea = h('textarea', { rows: 1, placeholder: 'Type a reply…  ( / = saved replies, Shift+Enter = new line)' })
  const sendBtn = h('button', { class: 'btn primary' }, 'Send')
  const fileInput = h('input', { type: 'file', hidden: true })
  const tool = (label, title, onclick) => h('button', { class: 'btn tool', title, 'aria-label': title, onclick }, label)
  const quickBtn = tool('⚡', 'Saved replies', () => quickRepliesPopover(quickBtn, data.chat, insertText))
  const attachBtn = tool('📎', 'Send a photo or file', () => fileInput.click())
  const templateBtn = tool('📄', 'Send an approved template', () => openTemplateModal(data.chat, afterSend))
  const suggestBtn = state.features.ai ? tool('✨', 'Draft a reply with AI', suggest) : null
  const hint = h('div', { class: 'small muted' })
  const composer = h('div', { class: 'composer' },
    h('div', { class: 'row' }, h('div', { class: 'tools-row' }, quickBtn, attachBtn, state.features.templates ? templateBtn : null, suggestBtn), textarea, sendBtn, fileInput),
    hint)
  const chatMain = h('div', { class: 'chatmain' }, head, notices, msgs, composer)
  pane.replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'))

  let data = null
  let mounted = false
  let lastSignature = ''
  let headSignature = ''
  let detailsSignature = ''

  function insertText(text) {
    textarea.value = textarea.value.trim() ? `${textarea.value.trim()}\n${text}` : text
    resize()
    textarea.focus()
  }
  function resize() {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }
  async function afterSend() {
    await refresh(true)
    onChange()
  }

  async function action(path, body, done) {
    try {
      await api(`/chats/${phone}/${path}`, { method: 'POST', body: body || {} })
      if (done) toast(done)
      await afterSend()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  async function send() {
    const text = textarea.value.trim()
    if (!text || sendBtn.disabled) return
    sendBtn.disabled = true
    try {
      await api(`/chats/${phone}/reply`, { method: 'POST', body: { text } })
      textarea.value = ''
      resize()
      await afterSend()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      sendBtn.disabled = !data?.chat.canReply
      textarea.focus()
    }
  }

  async function suggest() {
    suggestBtn.disabled = true
    const old = textarea.placeholder
    textarea.placeholder = 'Drafting a reply…'
    try {
      const res = await api(`/chats/${phone}/suggest`, { method: 'POST', body: {} })
      insertText(res.text)
      toast('Draft added — check it before sending')
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      suggestBtn.disabled = false
      textarea.placeholder = old
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    if (file.size > 16 * 1024 * 1024) return toast('Files must be 16 MB or smaller', 'error')
    const form = new FormData()
    form.set('file', file)
    form.set('caption', textarea.value.trim())
    attachBtn.disabled = true
    toast(`Sending ${file.name}…`)
    try {
      await upload(`/chats/${phone}/media`, form)
      textarea.value = ''
      resize()
      await afterSend()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      attachBtn.disabled = !data?.chat.canReply
    }
  })

  sendBtn.addEventListener('click', send)
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
    if (e.key === '/' && !textarea.value) {
      e.preventDefault()
      quickRepliesPopover(quickBtn, data.chat, insertText)
    }
  })
  textarea.addEventListener('input', resize)

  function toggleDetails() {
    state.showDetails = details.hidden
    details.hidden = !state.showDetails
    localStorage.setItem(DETAILS_STORE, state.showDetails ? '1' : '0')
  }

  function drawHead() {
    const c = data.chat
    const sig = JSON.stringify([c.name, c.mode, c.assignedTo, c.canReply, c.site, state.team])
    if (sig === headSignature) return
    headSignature = sig
    const back = h('a', { href: '#/inbox', class: 'btn back' }, '←')
    const assign = h('select', {
      class: 'assign',
      title: 'Assign this chat to a teammate (pauses the bot)',
      onchange: (e) => e.target.value && action('assign', { to: e.target.value }, `Assigned to ${e.target.value}`),
    },
    h('option', { value: '' }, c.mode === 'agent' && c.assignedTo ? `Assigned: ${c.assignedTo}` : 'Assign to…'),
    state.team.filter((n) => !(c.mode === 'agent' && n === c.assignedTo)).map((n) => h('option', { value: n }, n === state.staff ? `${n} (me)` : n)))
    head.replaceChildren(
      h('div', { class: 'who' },
        h('div', null, back, ' ', h('b', null, c.name || phoneLabel(c.phone)), ' ', modePill(c.mode), ' ', sitePill(c.site)),
        h('div', { class: 'small muted' }, phoneLabel(c.phone), c.assignedTo && c.mode === 'agent' ? ` · handled by ${c.assignedTo === state.staff ? 'you' : c.assignedTo}` : '')),
      h('div', { class: 'actions' },
        c.mode !== 'agent' || c.assignedTo !== state.staff ? h('button', { class: 'btn warn', onclick: () => action('takeover', null, 'You took over this chat') }, 'Take over') : null,
        state.team.length > 1 ? assign : null,
        c.mode !== 'bot' ? h('button', { class: 'btn', onclick: () => action('release', { sendMenu: false }, 'Bot is back on') }, 'Hand back to bot') : null,
        c.mode !== 'bot' && c.canReply
          ? h('button', { class: 'btn', onclick: () => action('release', { sendMenu: true }, 'Bot is back on and sent the menu') }, '+ menu')
          : null,
        h('button', { class: 'btn', onclick: toggleDetails, title: 'Customer details, tags and notes' }, 'ⓘ')),
    )
  }

  function drawNotices() {
    const c = data.chat
    const n = []
    if (c.mode === 'needs_help') {
      n.push(h('div', { class: 'notice warn' },
        'Customer asked to talk to a person', data.handoff?.message ? `: “${data.handoff.message}”` : '.',
        data.handoff?.created_at ? ` (${ago(data.handoff.created_at)})` : '',
        ' Reply below or take over — the bot is waiting.'))
    }
    if (c.mode === 'agent') {
      n.push(h('div', { class: 'notice info' }, `${c.assignedTo === state.staff ? 'You are' : `${c.assignedTo || 'Staff'} is`} handling this chat. The bot is paused until it is handed back (or after 24 h of no activity).`))
    }
    if (data.whatsappOptOut) n.push(h('div', { class: 'notice danger' }, 'Customer replied STOP — no promotional messages.'))
    if (!c.canReply) {
      n.push(h('div', { class: 'notice danger' },
        'More than 24 hours since the customer last wrote, so WhatsApp only allows approved templates. ',
        state.features.templates ? h('button', { class: 'linkbtn', onclick: () => openTemplateModal(c, afterSend) }, 'Send a template') : null))
    }
    notices.replaceChildren(...n)
    sendBtn.disabled = !c.canReply
    textarea.disabled = !c.canReply
    attachBtn.disabled = !c.canReply
    quickBtn.disabled = !c.canReply
    if (suggestBtn) suggestBtn.disabled = !c.canReply
    hint.textContent = c.canReply
      ? c.mode === 'agent' && c.assignedTo === state.staff
        ? 'The customer sees your reply from the business number.'
        : 'Sending a reply takes over the chat and pauses the bot.'
      : ''
  }

  function drawMessages(forceBottom) {
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120
    let lastDay = ''
    const nodes = []
    for (const m of data.messages) {
      const day = fmtDay(m.at)
      if (day !== lastDay) {
        nodes.push(h('div', { class: 'day' }, day))
        lastDay = day
      }
      const by = m.direction === 'in' ? null : authorName(m)
      const caption = m.text && !/^\[[a-z]+(:.*)?\]$/.test(m.text) ? m.text : null
      nodes.push(
        h('div', { class: `bubble ${m.direction} ${m.author}${m.agent === 'AI' ? ' ai' : ''}`, title: m.error || '' },
          by ? h('div', { class: 'by' }, by) : null,
          m.media ? mediaNode(m) : null,
          m.media ? caption : m.text || `[${m.type}]`,
          h('div', { class: 'foot' }, fmtTime(m.at), m.direction === 'out' ? tick(m.status) : null,
            m.status === 'failed' && m.error ? ` ${m.error}` : '')),
      )
    }
    if (!nodes.length) nodes.push(h('div', { class: 'placeholder' }, 'No messages yet'))
    msgs.replaceChildren(...nodes)
    if (forceBottom || nearBottom) msgs.scrollTop = msgs.scrollHeight
  }

  function drawDetails(force = false) {
    const c = data.chat
    const sig = JSON.stringify([c.tags, data.notes, data.marketingOptIn, data.whatsappOptOut, c.site])
    const busy = details.contains(document.activeElement) && document.activeElement.value
    if (!force && (sig === detailsSignature || busy)) return
    detailsSignature = sig

    async function saveTags(tags) {
      try {
        await api(`/chats/${phone}/tags`, { method: 'PUT', body: { tags } })
        await refresh()
        onChange()
      } catch (e) {
        toast(e.message, 'error')
      }
    }
    const tagInput = h('input', {
      type: 'text', placeholder: 'Add tag + Enter', maxlength: 24,
      onkeydown: (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return
        e.preventDefault()
        const value = e.target.value
        e.target.value = ''
        saveTags([...c.tags, value])
      },
    })
    const note = h('textarea', { rows: 2, placeholder: 'Internal note (customer never sees this)' })
    const addNote = h('button', {
      class: 'btn small',
      onclick: async () => {
        if (!note.value.trim()) return
        try {
          await api(`/chats/${phone}/notes`, { method: 'POST', body: { text: note.value.trim() } })
          note.value = ''
          await refresh()
          drawDetails(true)
        } catch (e) {
          toast(e.message, 'error')
        }
      },
    }, 'Add note')

    details.replaceChildren(
      h('div', { class: 'dhead' }, h('b', null, 'Customer'), h('button', { class: 'x', onclick: toggleDetails, title: 'Hide' }, '×')),
      h('dl', null,
        h('dt', null, 'Phone'), h('dd', null, phoneLabel(c.phone)),
        h('dt', null, 'Website'), h('dd', null, siteName(c.site)),
        h('dt', null, 'First seen'), h('dd', null, c.createdAt ? fmtDateTime(c.createdAt) : '—'),
        h('dt', null, 'Last wrote'), h('dd', null, c.lastInboundAt ? fmtDateTime(c.lastInboundAt) : 'never'),
        h('dt', null, 'Marketing'), h('dd', null, data.whatsappOptOut ? 'Opted out (STOP)' : data.marketingOptIn === true ? 'Opted in' : data.marketingOptIn === false ? 'Declined' : 'Not asked')),
      h('div', { class: 'dsec' }, h('b', null, 'Tags'),
        h('div', { class: 'chips' }, c.tags.map((t) => h('span', { class: 'pill tag' }, `#${t}`,
          h('button', { class: 'chipx', title: `Remove ${t}`, onclick: () => saveTags(c.tags.filter((x) => x !== t)) }, '×')))),
        tagInput),
      h('div', { class: 'dsec' }, h('b', null, 'Notes'), note, addNote,
        data.notes.length
          ? data.notes.map((n) => h('div', { class: 'note' },
              h('div', { class: 'pre' }, n.text),
              h('div', { class: 'small muted' }, `${n.author} · ${ago(n.at)}`,
                n.author === state.staff || state.role === 'admin'
                  ? h('button', {
                      class: 'linkbtn small',
                      onclick: async () => {
                        try {
                          await api(`/notes/${n.id}`, { method: 'DELETE' })
                          await refresh()
                          drawDetails(true)
                        } catch (e) {
                          toast(e.message, 'error')
                        }
                      },
                    }, 'delete')
                  : null)))
          : h('div', { class: 'small muted' }, 'No notes yet.')),
    )
  }

  async function refresh(forceBottom = false) {
    try {
      data = await api(`/chats/${phone}`)
    } catch (e) {
      if (!mounted) pane.replaceChildren(h('div', { class: 'placeholder' }, e.status === 404 ? 'No chat with this number yet.' : e.message))
      return
    }
    if (!mounted) {
      pane.replaceChildren(chatMain, details)
      mounted = true
      forceBottom = true
    }
    drawHead()
    drawNotices()
    drawDetails()
    const sig = data.messages.map((m) => `${m.id}:${m.status}`).join('|')
    if (sig !== lastSignature || forceBottom) {
      lastSignature = sig
      drawMessages(forceBottom)
    }
  }

  refresh()
  return { refresh }
}

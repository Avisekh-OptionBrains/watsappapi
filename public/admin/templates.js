import { api, field, h, loadTemplates, openModal, phoneLabel, put, state, toast } from './core.js'

const VAR_RE = /\{\{\s*([\w]+)\s*\}\}/g
const MEDIA_HEADERS = ['IMAGE', 'VIDEO', 'DOCUMENT']

function fill(text, values, prefix) {
  return (text || '').replace(VAR_RE, (_, name) => values[`${prefix}.${name}`] || `{{${name}}}`)
}

/**
 * Template picker with inputs for every blank and a live preview.
 * `filter(t)` limits the list (e.g. campaigns: marketing / utility only).
 */
export function templateForm({ filter, prefill = {} } = {}) {
  const root = h('div', { class: 'tform' }, h('div', { class: 'muted small' }, 'Loading templates…'))
  const values = {}
  let current = null
  let templates = []

  const select = h('select', { onchange: () => pick(select.value) })
  const fields = h('div', { class: 'tfields' })
  const preview = h('div', { class: 'bubble out agent preview' })
  const refresh = h('button', {
    class: 'btn small', type: 'button', title: 'Reload approved templates from Meta',
    onclick: () => load(true).catch((e) => toast(e.message, 'error')),
  }, '↻')

  function drawPreview() {
    if (!current) return put(preview, h('span', { class: 'muted' }, 'Pick a template'))
    const t = current
    put(preview,
      t.header && t.header.format === 'TEXT' && t.header.text ? h('b', null, fill(t.header.text, values, 'header'), '\n') : null,
      t.header && MEDIA_HEADERS.includes(t.header.format) ? h('div', { class: 'small muted' }, `[${t.header.format.toLowerCase()} header]`) : null,
      fill(t.body, values, 'body'),
      t.footer ? h('div', { class: 'small muted' }, t.footer) : null,
      t.buttons.length ? h('div', { class: 'tbuttons' }, t.buttons.map((b) => h('span', null, b.text))) : null,
    )
  }

  function input(key, label, hint) {
    const el = h('input', {
      type: 'text',
      value: values[key] || '',
      oninput: (e) => {
        values[key] = e.target.value
        drawPreview()
      },
    })
    return field(label, el, hint)
  }

  function pick(id) {
    current = templates.find((t) => `${t.name}|${t.language}` === id) || null
    for (const k of Object.keys(values)) delete values[k]
    Object.assign(values, current ? prefill : {})
    const rows = []
    if (current) {
      const t = current
      if (t.header && MEDIA_HEADERS.includes(t.header.format)) {
        rows.push(input('headerMedia', `Header ${t.header.format.toLowerCase()} link`, 'Public https:// link to the file'))
      }
      for (const v of t.header?.vars || []) rows.push(input(`header.${v}`, `Header {{${v}}}`))
      for (const v of t.bodyVars) rows.push(input(`body.${v}`, `{{${v}}}`))
      for (const b of t.buttons) {
        if (!b.needsValue) continue
        rows.push(b.type === 'COPY_CODE'
          ? input(`button.${b.index}`, `Coupon code for "${b.text}"`)
          : input(`button.${b.index}`, `Link ending for "${b.text}"`, b.url || ''))
      }
      if (!rows.length) rows.push(h('div', { class: 'small muted' }, 'No blanks to fill in.'))
    }
    fields.replaceChildren(...rows)
    drawPreview()
  }

  async function load(refreshList = false) {
    templates = (await loadTemplates(refreshList)).filter((t) => !filter || filter(t))
    put(select,
      h('option', { value: '' }, templates.length ? 'Choose a template…' : 'No approved templates'),
      templates.map((t) => h('option', { value: `${t.name}|${t.language}` }, `${t.name} · ${t.language} · ${t.category.toLowerCase()}`)),
    )
    root.replaceChildren(
      h('div', { class: 'row' }, field('Template', select), refresh),
      h('div', { class: 'tgrid' }, fields, h('div', null, h('div', { class: 'small muted' }, 'Preview'), preview)),
    )
    pick('')
  }
  load().catch((e) => root.replaceChildren(h('div', { class: 'error' }, e.message)))

  return {
    root,
    value: () => (current ? { name: current.name, language: current.language, category: current.category, values: { ...values } } : null),
  }
}

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || ''

/** Send a template inside an existing chat (also works after the 24 h window). */
export function openTemplateModal(chat, onSent) {
  const form = templateForm({ prefill: { 'body.1': firstName(chat.name) } })
  const send = h('button', { class: 'btn primary' }, 'Send template')
  const m = openModal(`Template to ${chat.name || phoneLabel(chat.phone)}`, h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'Approved templates can be sent anytime. Marketing templates only reach customers who opted in.'),
    form.root,
    h('div', { class: 'row end' }, send)), { wide: true })
  send.addEventListener('click', async () => {
    const v = form.value()
    if (!v) return toast('Choose a template', 'error')
    send.disabled = true
    try {
      await api(`/chats/${chat.phone}/template`, { method: 'POST', body: { name: v.name, language: v.language, values: v.values } })
      toast('Template sent')
      m.close()
      onSent?.()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      send.disabled = false
    }
  })
}

/** Start a conversation with a number that has not written (template only, per WhatsApp rules). */
export function openNewChatModal() {
  const phone = h('input', { type: 'tel', placeholder: '98765 43210 or +91 98765 43210', required: true })
  const name = h('input', { type: 'text', placeholder: 'Optional' })
  const site = h('select', null, state.sites.map((s) => h('option', { value: s.id, selected: s.id === state.site ? true : null }, s.name)))
  const form = templateForm()
  const send = h('button', { class: 'btn primary' }, 'Send & open chat')
  const m = openModal('New chat', h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'WhatsApp only lets businesses start a conversation with an approved template. When the customer replies, you can chat freely for 24 hours.'),
    h('div', { class: 'grid3' }, field('Phone number', phone), field('Customer name', name), state.sites.length > 1 ? field('From website', site) : null),
    form.root,
    h('div', { class: 'row end' }, send)), { wide: true })
  phone.focus()
  send.addEventListener('click', async () => {
    const v = form.value()
    if (!phone.value.trim()) return toast('Enter a phone number', 'error')
    if (!v) return toast('Choose a template', 'error')
    send.disabled = true
    try {
      const res = await api(`/chats/${encodeURIComponent(phone.value.trim())}/template`, {
        method: 'POST',
        body: { name: v.name, language: v.language, values: v.values, site: site.value || state.sites[0]?.id, customerName: name.value.trim() || undefined },
      })
      toast('Template sent')
      m.close()
      location.hash = `#/inbox/${res.phone}`
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      send.disabled = false
    }
  })
}

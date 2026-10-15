import { Hono } from 'hono'
import { z } from 'zod'
import { allStaff, requireAdmin } from '../auth'
import { suggestReply } from '../bot/ai'
import { handBackToBot, startBotFor, takeOverChat } from '../bot/engine'
import type { AppEnv, Env } from '../env'
import { alertsConfigured } from '../lib/alerts'
import { getConsent, isOptedIn } from '../lib/consent'
import { canReplyFreely, effectiveMode, type ConversationRow } from '../lib/conversations'
import { fetchMedia, mediaKindFor, sendMedia, sendTemplate, sendText, uploadMedia } from '../lib/meta'
import { recordOutbound } from '../lib/outbound'
import { markStaffReplied } from '../lib/support'
import { buildTemplateMessage, getTemplates } from '../lib/templates'
import { getSite, getSites, type Site } from '../sites'
import { DAY_MS, chatFor, siteFilter, toChat, toMessage, type MessageRow } from './admin-shared'
import { adminReports } from './admin-reports'
import { adminTools } from './admin-tools'
import { readJson, upstreamStatus } from './util'

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

export const admin = new Hono<AppEnv>()
admin.use(requireAdmin)

admin.get('/me', (c) => {
  const sites = getSites(c.env).map((s) => ({ id: s.id, name: s.name, bot: Boolean(s.bot?.enabled) }))
  return c.json({
    ok: true,
    staff: c.get('staff'),
    role: c.get('role'),
    team: allStaff(c.env).map((s) => s.name),
    sites,
    features: {
      templates: Boolean(c.env.WHATSAPP_WABA_ID),
      ai: Boolean(c.env.GEMINI_API_KEY) && c.env.AI_ENABLED !== '0',
      alerts: alertsConfigured(c.env),
    },
  })
})

admin.get('/overview', async (c) => {
  const since = Date.now() - DAY_MS
  const staleBefore = Date.now() - DAY_MS
  const f = siteFilter(c.req.query('site'))
  const db = c.env.DB

  const [messages, chats, modes, failed, optOuts, campaigns, perSite, waiting, ai] = await Promise.all([
    db
      .prepare(`SELECT direction, author, COUNT(*) AS n FROM chat_messages WHERE created_at >= ?${f.sql} GROUP BY direction, author`)
      .bind(since, ...f.args)
      .all<{ direction: string; author: string; n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS active, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new
         FROM conversations WHERE last_inbound_at >= ?${f.sql}`,
      )
      .bind(since, since, ...f.args)
      .first<{ active: number; new: number | null }>(),
    db
      .prepare(`SELECT mode, COUNT(*) AS n FROM conversations WHERE mode != 'bot' AND mode_at >= ?${f.sql} GROUP BY mode`)
      .bind(staleBefore, ...f.args)
      .all<{ mode: string; n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE status = 'failed' AND created_at >= ?${f.sql}`)
      .bind(since, ...f.args)
      .first<{ n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM consents WHERE site_id = '*' AND opted_in = 0 AND updated_at >= ?`)
      .bind(since)
      .first<{ n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM campaigns WHERE status IN ('queued', 'processing')${f.sql}`)
      .bind(...f.args)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT site_id,
           COUNT(DISTINCT CASE WHEN direction = 'in' THEN phone END) AS chats,
           SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inbound,
           SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outbound
         FROM chat_messages WHERE created_at >= ? GROUP BY site_id`,
      )
      .bind(since)
      .all<{ site_id: string; chats: number; inbound: number; outbound: number }>(),
    db
      .prepare(
        `SELECT * FROM conversations WHERE mode = 'needs_help' AND mode_at >= ?${f.sql}
         ORDER BY mode_at ASC LIMIT 10`,
      )
      .bind(staleBefore, ...f.args)
      .all<ConversationRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE author = 'bot' AND agent = 'AI' AND created_at >= ?${f.sql}`)
      .bind(since, ...f.args)
      .first<{ n: number }>(),
  ])

  const count = (pred: (r: { direction: string; author: string }) => boolean) =>
    messages.results.filter(pred).reduce((sum, r) => sum + r.n, 0)

  return c.json({
    ok: true,
    window: '24h',
    stats: {
      activeChats: chats?.active ?? 0,
      newChats: chats?.new ?? 0,
      needsHelp: modes.results.find((m) => m.mode === 'needs_help')?.n ?? 0,
      withAgent: modes.results.find((m) => m.mode === 'agent')?.n ?? 0,
      inbound: count((r) => r.direction === 'in'),
      botReplies: count((r) => r.author === 'bot'),
      aiReplies: ai?.n ?? 0,
      agentReplies: count((r) => r.author === 'agent'),
      systemMessages: count((r) => r.author === 'system'),
      campaignMessages: count((r) => r.author === 'campaign'),
      failed: failed?.n ?? 0,
      optOuts: optOuts?.n ?? 0,
      runningCampaigns: campaigns?.n ?? 0,
    },
    sites: getSites(c.env).map((s) => {
      const row = perSite.results.find((r) => r.site_id === s.id)
      return { id: s.id, name: s.name, chats: row?.chats ?? 0, inbound: row?.inbound ?? 0, outbound: row?.outbound ?? 0 }
    }),
    waiting: waiting.results.map(toChat),
  })
})

admin.get('/chats', async (c) => {
  const mode = c.req.query('mode')
  const q = c.req.query('q')?.trim().toLowerCase()
  const tag = c.req.query('tag')?.trim().toLowerCase()
  const before = Number(c.req.query('before') || 0)
  const limit = Math.min(Number(c.req.query('limit') || 50), 100)
  const f = siteFilter(c.req.query('site'))
  const staff = c.get('staff')
  const fresh = Date.now() - DAY_MS

  let where = `WHERE 1 = 1${f.sql}`
  const args: Array<string | number> = [...f.args]
  if (mode === 'needs_help' || mode === 'agent') {
    where += ' AND mode = ? AND mode_at >= ?'
    args.push(mode, fresh)
  } else if (mode === 'mine') {
    where += ` AND mode = 'agent' AND mode_at >= ? AND assigned_to = ?`
    args.push(fresh, staff)
  } else if (mode === 'bot') {
    where += ` AND (mode = 'bot' OR mode_at < ?)`
    args.push(fresh)
  } else if (mode === 'unread') {
    where += ' AND unread > 0'
  }
  if (tag) {
    where += ' AND EXISTS (SELECT 1 FROM json_each(conversations.tags) WHERE value = ?)'
    args.push(tag)
  }
  if (q) {
    where += ' AND (instr(phone, ?) > 0 OR instr(lower(COALESCE(name, \'\')), ?) > 0)'
    args.push(q.replace(/\D/g, '') || q, q)
  }
  if (before > 0) {
    where += ' AND last_message_at < ?'
    args.push(before)
  }

  const [{ results }, modes, mine] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM conversations ${where} ORDER BY last_message_at DESC LIMIT ?`)
      .bind(...args, limit)
      .all<ConversationRow>(),
    c.env.DB.prepare(
      `SELECT mode, COUNT(*) AS n FROM conversations WHERE mode != 'bot' AND mode_at >= ?${f.sql} GROUP BY mode`,
    )
      .bind(fresh, ...f.args)
      .all<{ mode: string; n: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(unread), 0) AS unread FROM conversations
       WHERE mode = 'agent' AND mode_at >= ? AND assigned_to = ?${f.sql}`,
    )
      .bind(fresh, staff, ...f.args)
      .first<{ n: number; unread: number }>(),
  ])
  return c.json({
    ok: true,
    counts: {
      needsHelp: modes.results.find((m) => m.mode === 'needs_help')?.n ?? 0,
      withAgent: modes.results.find((m) => m.mode === 'agent')?.n ?? 0,
      mine: mine?.n ?? 0,
      mineUnread: mine?.unread ?? 0,
    },
    chats: results.map(toChat),
    next: results.length === limit ? results[results.length - 1].last_message_at : null,
  })
})

admin.get('/chats/:phone', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)

  const [messages, consent, handoff, notes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM (SELECT * FROM chat_messages WHERE phone = ? ORDER BY created_at DESC LIMIT 300) ORDER BY created_at ASC`,
    )
      .bind(phone)
      .all<MessageRow>(),
    getConsent(c.env, conv.site_id, phone),
    c.env.DB.prepare(
      `SELECT message, requested_at AS created_at FROM support_requests
       WHERE phone = ? AND resolved_at IS NULL ORDER BY requested_at DESC`,
    )
      .bind(phone)
      .first<{ message: string | null; created_at: number }>(),
    c.env.DB.prepare('SELECT id, author, text, created_at FROM staff_notes WHERE phone = ? ORDER BY created_at DESC LIMIT 50')
      .bind(phone)
      .all<{ id: string; author: string; text: string; created_at: number }>(),
  ])
  if (conv.unread) {
    await c.env.DB.prepare('UPDATE conversations SET unread = 0 WHERE phone = ?').bind(phone).run()
  }

  return c.json({
    ok: true,
    chat: { ...toChat(conv), unread: 0, createdAt: conv.created_at },
    marketingOptIn: consent.consent?.optedIn ?? null,
    whatsappOptOut: consent.whatsappOptOut,
    handoff,
    notes: notes.results.map((n) => ({ id: n.id, author: n.author, text: n.text, at: n.created_at })),
    messages: messages.results.map(toMessage),
  })
})

/** Staff speaking in a chat take it over, and the first reply counts for response times. */
async function claimForReply(env: Env, conv: ConversationRow, site: Site, staff: string): Promise<void> {
  if (effectiveMode(conv) !== 'agent' || conv.assigned_to !== staff) {
    await takeOverChat(env, conv.phone, site.id, staff)
  } else {
    await env.DB.prepare('UPDATE conversations SET mode_at = ? WHERE phone = ?').bind(Date.now(), conv.phone).run()
  }
}

const WINDOW_CLOSED =
  'More than 24 hours since the customer last wrote. WhatsApp only allows approved templates now.'

const replySchema = z.object({ text: z.string().trim().min(1).max(4096) })

admin.post('/chats/:phone/reply', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)
  const site = getSite(c.env, conv.site_id)
  if (!site) return c.json({ ok: false, message: `Site ${conv.site_id} is no longer configured` }, 409)
  if (!canReplyFreely(conv)) return c.json({ ok: false, message: WINDOW_CLOSED }, 409)
  const { text } = await readJson(c, replySchema)
  const staff = c.get('staff')

  await claimForReply(c.env, conv, site, staff)
  const sent = await sendText(c.env, phone, text)
  if (!sent.ok) return c.json({ ok: false, message: sent.message }, upstreamStatus(sent.status))
  await recordOutbound(c.env, site, { messageId: sent.messageId, phone, kind: 'text', text, author: 'agent', agent: staff })
  await markStaffReplied(c.env, phone, staff)
  return c.json({ ok: true, messageId: sent.messageId })
})

admin.post('/chats/:phone/media', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)
  const site = getSite(c.env, conv.site_id)
  if (!site) return c.json({ ok: false, message: `Site ${conv.site_id} is no longer configured` }, 409)
  if (!canReplyFreely(conv)) return c.json({ ok: false, message: WINDOW_CLOSED }, 409)

  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!file || typeof file === 'string') return c.json({ ok: false, message: 'Attach a file' }, 400)
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ ok: false, message: 'Files must be 16 MB or smaller' }, 413)
  const caption = String(form?.get('caption') ?? '').trim().slice(0, 1024)
  const name = (file.name || 'file').replace(/[\\/\r\n]/g, '_').slice(0, 120)
  const mime = file.type || 'application/octet-stream'
  const kind = mediaKindFor(mime)
  if (kind === 'image' && file.size > 5 * 1024 * 1024) {
    return c.json({ ok: false, message: 'WhatsApp images must be 5 MB or smaller; send it as a document instead' }, 413)
  }
  const staff = c.get('staff')

  const uploaded = await uploadMedia(c.env, file, name)
  if (!uploaded.ok) return c.json({ ok: false, message: uploaded.message }, upstreamStatus(uploaded.status))
  await claimForReply(c.env, conv, site, staff)
  const sent = await sendMedia(c.env, phone, { kind, mediaId: uploaded.id, caption, filename: name })
  if (!sent.ok) return c.json({ ok: false, message: sent.message }, upstreamStatus(sent.status))
  await recordOutbound(c.env, site, {
    messageId: sent.messageId,
    phone,
    kind: 'media',
    text: caption || `[${kind}: ${name}]`,
    author: 'agent',
    agent: staff,
    media: { id: uploaded.id, mime, name },
  })
  await markStaffReplied(c.env, phone, staff)
  return c.json({ ok: true, messageId: sent.messageId })
})

const templateSendSchema = z.object({
  name: z.string().min(1),
  language: z.string().min(2),
  values: z.record(z.string().max(1024)).default({}),
  /** Required when there is no chat with this number yet. */
  site: z.string().optional(),
  customerName: z.string().trim().max(80).optional(),
})

/** Approved template: works outside the 24 h window and starts brand-new chats. */
admin.post('/chats/:phone/template', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  const body = await readJson(c, templateSendSchema)
  const site = getSite(c.env, conv?.site_id ?? body.site)
  if (!site) return c.json({ ok: false, message: 'Choose which website this message is from' }, 400)

  const list = await getTemplates(c.env)
  if (!list.ok) return c.json({ ok: false, message: list.message }, upstreamStatus(list.status))
  const template = list.templates.find((t) => t.name === body.name && t.language === body.language)
  if (!template) return c.json({ ok: false, message: 'Template not found or not approved' }, 404)
  if (template.category === 'MARKETING' && !(await isOptedIn(c.env, site.id, phone))) {
    return c.json(
      { ok: false, message: 'This customer has not opted in to marketing messages (or replied STOP). Use a utility template.' },
      409,
    )
  }
  let built: ReturnType<typeof buildTemplateMessage>
  try {
    built = buildTemplateMessage(template, body.values)
  } catch (err) {
    return c.json({ ok: false, message: (err as Error).message }, 400)
  }

  const staff = c.get('staff')
  const sent = await sendTemplate(c.env, phone, { name: template.name, language: template.language, components: built.components })
  if (!sent.ok) return c.json({ ok: false, message: sent.message }, upstreamStatus(sent.status))
  await recordOutbound(c.env, site, {
    messageId: sent.messageId,
    phone,
    kind: 'template',
    text: built.preview,
    author: 'agent',
    agent: staff,
  })
  await takeOverChat(c.env, phone, site.id, staff)
  if (!conv && body.customerName) {
    await c.env.DB.prepare('UPDATE conversations SET name = COALESCE(name, ?) WHERE phone = ?')
      .bind(body.customerName, phone)
      .run()
  }
  await markStaffReplied(c.env, phone, staff)
  return c.json({ ok: true, messageId: sent.messageId, phone })
})

admin.post('/chats/:phone/takeover', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)
  await takeOverChat(c.env, phone, conv.site_id, c.get('staff'))
  return c.json({ ok: true })
})

const assignSchema = z.object({ to: z.string().min(1).max(40) })

admin.post('/chats/:phone/assign', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)
  const { to } = await readJson(c, assignSchema)
  if (!allStaff(c.env).some((s) => s.name === to)) return c.json({ ok: false, message: `${to} is not a staff member` }, 400)
  await takeOverChat(c.env, phone, conv.site_id, to)
  return c.json({ ok: true })
})

const releaseSchema = z.object({ sendMenu: z.boolean().default(false) })

admin.post('/chats/:phone/release', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)
  const { sendMenu } = await readJson(c, releaseSchema)
  await handBackToBot(c.env, phone, conv.site_id)
  const site = getSite(c.env, conv.site_id)
  if (sendMenu && site?.bot?.enabled && canReplyFreely(conv)) await startBotFor(c.env, site, phone)
  return c.json({ ok: true })
})

admin.post('/chats/:phone/suggest', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)
  const site = getSite(c.env, conv.site_id)
  if (!site) return c.json({ ok: false, message: `Site ${conv.site_id} is no longer configured` }, 409)
  try {
    return c.json({ ok: true, text: await suggestReply(c.env, site, phone, c.get('staff')) })
  } catch (err) {
    return c.json({ ok: false, message: `Could not draft a reply: ${(err as Error).message}` }, 502)
  }
})

/** Streams a photo / document / voice note through the gateway (Meta needs our token). */
admin.get('/media/:id', async (c) => {
  const id = c.req.param('id')
  if (!/^[\w.-]{1,128}$/.test(id)) return c.json({ ok: false, message: 'Bad media id' }, 400)
  const known = await c.env.DB.prepare('SELECT media_name FROM chat_messages WHERE media_id = ? LIMIT 1')
    .bind(id)
    .first<{ media_name: string | null }>()
  if (!known) return c.json({ ok: false, message: 'Media not found' }, 404)
  const file = await fetchMedia(c.env, id)
  if (!file) return c.json({ ok: false, message: 'WhatsApp no longer has this file (kept ~30 days)' }, 404)
  const headers = new Headers(file.headers)
  headers.set('Cache-Control', 'private, max-age=3600')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
  headers.set('Content-Disposition', `attachment; filename="${(known.media_name || id).replace(/["\\\r\n]/g, '_')}"`)
  return new Response(file.body, { headers })
})

admin.get('/activity', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 300)
  const author = c.req.query('author')
  const f = siteFilter(c.req.query('site'), 'm.site_id')
  const authorSql = author === 'ai' ? ` AND m.author = 'bot' AND m.agent = 'AI'` : author ? ' AND m.author = ?' : ''
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, v.name
     FROM chat_messages m LEFT JOIN conversations v ON v.phone = m.phone
     WHERE 1 = 1${f.sql}${authorSql}
     ORDER BY m.created_at DESC LIMIT ?`,
  )
    .bind(...f.args, ...(author && author !== 'ai' ? [author] : []), limit)
    .all<MessageRow & { phone: string; name: string | null }>()
  return c.json({
    ok: true,
    events: results.map((m) => ({ ...toMessage(m), phone: m.phone, name: m.name })),
  })
})

admin.route('/', adminTools)
admin.route('/', adminReports)

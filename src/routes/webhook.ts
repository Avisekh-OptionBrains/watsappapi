import { Hono } from 'hono'
import { handleBotMessage, resolveConversationSite } from '../bot/engine'
import { createReplier } from '../bot/reply'
import { clearSession } from '../bot/state'
import { isDevelopment, type AppEnv, type Env } from '../env'
import { GLOBAL_SCOPE, setConsent } from '../lib/consent'
import { recordInboundChat } from '../lib/conversations'
import { safeEqual, verifyMetaSignature } from '../lib/crypto'
import { emitSiteEvent } from '../lib/events'
import {
  STATUS_RANK,
  classifyCrmKind,
  extractInbound,
  extractStatuses,
  type CrmKind,
  type InboundMessage,
  type StatusUpdate,
} from '../lib/inbound'
import { deliveryErrorText, markRead } from '../lib/meta'
import { defaultSite, getSite, type Site } from '../sites'

export const webhook = new Hono<AppEnv>()

webhook.get('/meta', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')
  if (mode !== 'subscribe' || !token || !challenge) return c.text('Missing verification parameters', 400)
  if (!c.env.WHATSAPP_VERIFY_TOKEN || !safeEqual(token, c.env.WHATSAPP_VERIFY_TOKEN)) {
    return c.text('Forbidden', 403)
  }
  return c.text(challenge)
})

webhook.post('/meta', async (c) => {
  const raw = await c.req.arrayBuffer()
  const secret = c.env.WHATSAPP_APP_SECRET
  if (secret) {
    if (!(await verifyMetaSignature(secret, raw, c.req.header('x-hub-signature-256')))) {
      return c.json({ ok: false, message: 'Invalid Meta signature' }, 401)
    }
  } else if (!isDevelopment(c.env)) {
    console.error('[webhook] WHATSAPP_APP_SECRET is not set; refusing unsigned webhook')
    return c.json({ ok: false, message: 'Webhook signature verification is not configured' }, 503)
  }

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return c.json({ ok: false, message: 'Invalid JSON' }, 400)
  }

  // Acknowledge Meta immediately; it retries slow or failed deliveries.
  c.executionCtx.waitUntil(
    processWebhook(c.env, body).catch((err) => console.error('[webhook] processing failed', err)),
  )
  return c.json({ ok: true })
})

export async function processWebhook(env: Env, body: unknown): Promise<void> {
  for (const status of extractStatuses(body)) {
    await handleStatus(env, status)
  }
  for (const msg of extractInbound(body)) {
    await handleInbound(env, msg)
  }
}

async function handleStatus(env: Env, s: StatusUpdate): Promise<void> {
  const rank = STATUS_RANK[s.status]
  const error = s.status === 'failed' ? deliveryErrorText(s.errors) : null
  const now = Date.now()
  const rankSql = `CASE status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 0 WHEN 'sent' THEN 1
    WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END`

  await env.DB.prepare(`UPDATE chat_messages SET status = ?, error = ? WHERE id = ? AND ${rankSql} < ?`)
    .bind(s.status, error, s.id, rank)
    .run()

  const row = await env.DB.prepare(
    `UPDATE outbound_messages SET status = ?, error = ?, updated_at = ?
     WHERE id = ? AND ${rankSql} < ?
     RETURNING site_id, phone, kind, preview, campaign_id`,
  )
    .bind(s.status, error, now, s.id, rank)
    .first<{ site_id: string; phone: string; kind: string; preview: string | null; campaign_id: string | null }>()
  if (!row) return

  if (row.campaign_id) {
    await env.DB.prepare(
      `UPDATE campaign_recipients SET status = ?, error = COALESCE(?, error), updated_at = ?
       WHERE campaign_id = ? AND message_id = ? AND ${rankSql} < ?`,
    )
      .bind(s.status, error, now, row.campaign_id, s.id, rank)
      .run()
    return
  }

  if (s.status === 'failed') console.warn('[webhook] delivery failed', row.site_id, s.id, error)
  await emitSiteEvent(getSite(env, row.site_id), 'whatsapp.status', {
    messageId: s.id,
    phone: s.recipientId ?? row.phone,
    status: s.status,
    error,
    kind: row.kind,
    preview: row.preview,
  })
}

async function handleInbound(env: Env, msg: InboundMessage): Promise<void> {
  const first = await env.DB.prepare('INSERT OR IGNORE INTO processed_messages (id, created_at) VALUES (?, ?)')
    .bind(msg.messageId, Date.now())
    .run()
  if (!first.meta.changes) return

  const kind = msg.type === 'text' ? classifyCrmKind(msg.text) : 'message'
  const site = (await resolveConversationSite(env, msg.from)) ?? defaultSite(env)
  await recordInboundChat(env, {
    id: msg.messageId,
    phone: msg.from,
    siteId: site.id,
    type: msg.type,
    text: msg.text,
    name: msg.profileName,
    media: msg.media,
  })
  // A slow site webhook must not delay the customer's reply.
  const background = Promise.all([
    markRead(env, msg.messageId),
    emitSiteEvent(site, 'whatsapp.crm', {
      phone: msg.from,
      text: msg.text,
      messageId: msg.messageId,
      kind,
      type: msg.type,
      interactiveId: msg.interactiveId,
      profileName: msg.profileName,
    }),
  ])
  try {
    await respondToInbound(env, site, msg, kind)
  } finally {
    await background
  }
}

async function respondToInbound(env: Env, site: Site, msg: InboundMessage, kind: CrmKind): Promise<void> {
  const reply = createReplier(env, site, msg.from)
  if (kind === 'opt_out') {
    await setConsent(env, { siteId: GLOBAL_SCOPE, phone: msg.from, optedIn: false, source: 'whatsapp', purpose: 'marketing' })
    await clearSession(env, msg.from)
    await reply.text(
      'You are unsubscribed from promotional WhatsApp messages. Reply START to subscribe again. Service messages (login codes, payment updates) may still be sent.',
    )
    return
  }
  if (kind === 'opt_in') {
    await setConsent(env, { siteId: GLOBAL_SCOPE, phone: msg.from, optedIn: true, source: 'whatsapp', purpose: 'marketing' })
    await setConsent(env, { siteId: site.id, phone: msg.from, optedIn: true, source: 'whatsapp', purpose: 'marketing' })
    await reply.text(`You are subscribed to ${site.name} updates on WhatsApp. Reply STOP anytime to unsubscribe.`)
    return
  }

  if (env.BOT_ENABLED === '0') return
  if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') return
  await handleBotMessage(env, { phone: msg.from, text: msg.text, interactiveId: msg.interactiveId })
}

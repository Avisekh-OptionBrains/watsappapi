import type { Env } from '../env'
import type { Site } from '../sites'
import { recordOutboundChat, type Author, type ChatMedia } from './conversations'
import { emitSiteEvent } from './events'

export type OutboundKind = 'otp' | 'template' | 'text' | 'media'

/**
 * Remembers which site sent a message (so Meta delivery receipts reach that site), adds it to
 * the chat transcript and tells the site it was accepted. Never pass OTP codes in `text`.
 */
export async function recordOutbound(
  env: Env,
  site: Site,
  opts: {
    messageId: string | null
    phone: string
    kind: OutboundKind
    text: string
    author: Author
    agent?: string | null
    media?: ChatMedia | null
    campaignId?: string
    notifySite?: boolean
  },
): Promise<void> {
  if (!opts.messageId) return
  const now = Date.now()
  const preview = opts.text.slice(0, 180)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO outbound_messages
       (id, site_id, phone, kind, preview, campaign_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
  )
    .bind(opts.messageId, site.id, opts.phone, opts.kind, preview, opts.campaignId ?? null, now, now)
    .run()
  await recordOutboundChat(env, {
    id: opts.messageId,
    phone: opts.phone,
    siteId: site.id,
    author: opts.author,
    agent: opts.agent,
    type: opts.kind,
    text: opts.text,
    media: opts.media,
  })

  if (opts.notifySite === false) return
  await emitSiteEvent(site, 'whatsapp.outbound', {
    messageId: opts.messageId,
    phone: opts.phone,
    kind: opts.kind,
    preview,
  })
}

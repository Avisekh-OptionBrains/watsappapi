import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { config } from '../config'
import { markByMessageId } from '../lib/campaign-store'
import { requireServiceKey } from '../auth'
import { handleTypebotInbound } from '../lib/typebot-bridge'
import { verifyMetaSignature } from '../lib/meta-signature'
import { forwardToObResearch } from '../lib/research-webhook'
import { deliveryErrorText, notifyDeliveryStatus } from '../lib/research-messages'

const recentMetaEvents: Array<{ ts: string; summary: string }> = []

export function getRecentMetaEvents() {
  return recentMetaEvents.slice(-50)
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function summarizeMetaBody(body: unknown): string {
  try {
    const b = body as {
      entry?: Array<{ changes?: Array<{ value?: { messages?: unknown[]; statuses?: unknown[] } }> }>
    }
    const value = b?.entry?.[0]?.changes?.[0]?.value
    const msgCount = Array.isArray(value?.messages) ? value.messages.length : 0
    const statusCount = Array.isArray(value?.statuses) ? value.statuses.length : 0
    return `messages=${msgCount} statuses=${statusCount}`
  } catch {
    return 'payload'
  }
}

function extractStatuses(body: unknown): Array<{
  id: string
  status: string
  recipientId?: string
  errors?: unknown
}> {
  const out: Array<{ id: string; status: string; recipientId?: string; errors?: unknown }> = []
  if (!body || typeof body !== 'object') return out
  const b = body as Record<string, unknown>
  const data = b.data as Record<string, unknown> | undefined
  const candidates = [b, data, data?.message as Record<string, unknown> | undefined].filter(Boolean)

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    const obj = c as Record<string, unknown>
    const status = obj.status
    const key = obj.key as { id?: string } | undefined
    if (typeof status === 'string' && key?.id) {
      out.push({ id: key.id, status, errors: obj.errors })
    }
    const statuses = obj.statuses as
      | Array<{ id?: string; status?: string; recipient_id?: string; errors?: unknown }>
      | undefined
    if (Array.isArray(statuses)) {
      for (const s of statuses) {
        if (s.id && s.status) {
          out.push({ id: s.id, status: s.status, recipientId: s.recipient_id, errors: s.errors })
        }
      }
    }
  }

  const entry = b.entry as
    | Array<{
        changes?: Array<{
          value?: {
            statuses?: Array<{ id?: string; status?: string; recipient_id?: string; errors?: unknown }>
          }
        }>
      }>
    | undefined
  if (Array.isArray(entry)) {
    for (const e of entry) {
      for (const ch of e.changes ?? []) {
        for (const s of ch.value?.statuses ?? []) {
          if (s.id && s.status) {
            out.push({ id: s.id, status: s.status, recipientId: s.recipient_id, errors: s.errors })
          }
        }
      }
    }
  }
  return out
}

export async function webhookRoutes(app: FastifyInstance) {
  app.get('/webhook/meta', async (request, reply) => {
    const q = request.query as Record<string, string>
    const mode = q['hub.mode']
    const token = q['hub.verify_token']
    const challenge = q['hub.challenge']
    if (mode === 'subscribe' && token && challenge) {
      if (
        config.waBusinessTokenWebhook &&
        timingSafeEqualString(token, config.waBusinessTokenWebhook)
      ) {
        return reply.type('text/plain').send(challenge)
      }
      return reply.code(403).send('Forbidden')
    }
    return reply.code(400).send('Missing webhook verification parameters')
  })

  app.post('/webhook/meta', { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string | undefined
    if (!verifyMetaSignature(request.rawBody, signature)) {
      return reply.code(401).send({ ok: false, message: 'Invalid Meta signature' })
    }
    const body = request.body
    recentMetaEvents.push({ ts: new Date().toISOString(), summary: summarizeMetaBody(body) })
    if (recentMetaEvents.length > 100) recentMetaEvents.shift()

    // Acknowledge Meta immediately; process chat/status work asynchronously.
    // Dedupe in the Typebot bridge makes webhook retries safe.
    void (async () => {
      for (const s of extractStatuses(body)) {
        console.log('[meta-webhook] status', JSON.stringify(s))
        if (s.status.toLowerCase() === 'failed') {
          console.error('[meta-webhook] DELIVERY FAILED', JSON.stringify(s))
        }
        const normalized = s.status.toLowerCase()
        const receipt =
          normalized === 'read' || normalized === 'played'
            ? 'read'
            : normalized === 'delivered'
              ? 'delivered'
              : normalized === 'failed'
                ? 'failed'
                : normalized === 'sent'
                  ? 'sent'
                  : null
        if (receipt) {
          if (receipt === 'delivered' || receipt === 'read' || receipt === 'failed') {
            await markByMessageId(s.id, receipt === 'read' ? 'read' : receipt)
          }
          await notifyDeliveryStatus({
            messageId: s.id,
            phone: s.recipientId,
            status: receipt,
            error: receipt === 'failed' ? deliveryErrorText(s.errors) : null,
          })
        }
      }

      const n = await handleTypebotInbound(body)
      if (n > 0) console.log(`[typebot-bridge] handled ${n} inbound message(s)`)

      if (!config.evolutionEnabled) return
      try {
        await fetch(`${config.evolutionApiUrl}/webhook/meta`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (err) {
        console.error('[meta-webhook] forward to evolution failed', err)
      }
    })().catch((err) => console.error('[meta-webhook] processing failed', err))

    return { ok: true }
  })

  app.get('/v1/debug/meta-events', { preHandler: requireServiceKey }, async () => ({
    ok: true,
    events: getRecentMetaEvents(),
  }))

  app.post('/webhooks/evolution', async (request, reply) => {
    const requireSecret =
      Boolean(config.webhookSharedSecret) ||
      process.env.NODE_ENV === 'production' ||
      config.evolutionEnabled
    if (requireSecret) {
      if (!config.webhookSharedSecret) {
        return reply.code(503).send({ ok: false, message: 'Webhook secret not configured' })
      }
      const provided =
        (request.headers['x-webhook-secret'] as string | undefined) ||
        (request.headers['x-evolution-secret'] as string | undefined) ||
        ''
      if (!timingSafeEqualString(provided, config.webhookSharedSecret)) {
        return reply.code(401).send({ ok: false, message: 'Invalid webhook secret' })
      }
    }

    const body = request.body
    const event =
      body && typeof body === 'object' && 'event' in body
        ? String((body as { event: unknown }).event)
        : 'unknown'

    for (const s of extractStatuses(body)) {
      const normalized = s.status.toLowerCase()
      if (normalized === 'delivered' || normalized === 'read' || normalized === 'played') {
        await markByMessageId(
          s.id,
          normalized === 'read' || normalized === 'played' ? 'read' : 'delivered',
        )
      } else if (normalized === 'failed') {
        await markByMessageId(s.id, 'failed')
      }
    }

    await forwardToObResearch(event, body)
    return { ok: true }
  })
}

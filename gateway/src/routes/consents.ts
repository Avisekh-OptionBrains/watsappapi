import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireServiceKey } from '../auth'
import { getConsent, setConsent } from '../lib/consent-store'
import { toWhatsAppRecipient } from '../lib/phone'

const consentSchema = z.object({
  phone: z.string().min(8),
  optedIn: z.boolean(),
  source: z.enum(['website', 'checkout', 'admin', 'whatsapp', 'import']),
  purpose: z.string().min(1).max(200).default('marketing'),
})

export async function consentRoutes(app: FastifyInstance) {
  app.post('/v1/consents', { preHandler: requireServiceKey }, async (request, reply) => {
    const parsed = consentSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.flatten() })
    }

    const phone = toWhatsAppRecipient(parsed.data.phone)
    if (!phone) {
      return reply.code(400).send({ ok: false, message: 'Invalid Indian mobile number' })
    }

    const record = {
      phone,
      optedIn: parsed.data.optedIn,
      source: parsed.data.source,
      purpose: parsed.data.purpose,
      updatedAt: new Date().toISOString(),
    }
    await setConsent(record)
    return { ok: true, consent: record }
  })

  app.get('/v1/consents/:phone', { preHandler: requireServiceKey }, async (request, reply) => {
    const raw = (request.params as { phone: string }).phone
    const phone = toWhatsAppRecipient(raw)
    if (!phone) {
      return reply.code(400).send({ ok: false, message: 'Invalid Indian mobile number' })
    }
    return { ok: true, consent: await getConsent(phone) }
  })
}


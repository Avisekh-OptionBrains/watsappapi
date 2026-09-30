import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireServiceKey } from '../auth'
import { extractMessageId } from '../clients/evolution'
import { sendMetaTemplate, sendMetaText } from '../clients/meta-cloud'
import { toWhatsAppRecipient } from '../lib/phone'
import { isOptedIn } from '../lib/consent-store'

const templateSchema = z.object({
  phone: z.string().min(8),
  name: z.string().min(1),
  language: z.string().min(2).default('en_US'),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).default('UTILITY'),
  components: z.array(z.record(z.unknown())).optional(),
})

const textSchema = z.object({
  phone: z.string().min(8),
  text: z.string().min(1).max(4096),
  delay: z.number().int().min(0).max(120_000).optional(),
})

export async function messageRoutes(app: FastifyInstance) {
  app.post('/v1/messages/template', { preHandler: requireServiceKey }, async (request, reply) => {
    const parsed = templateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.flatten() })
    }

    const to = toWhatsAppRecipient(parsed.data.phone)
    if (!to) {
      return reply.code(400).send({
        ok: false,
        message: 'Enter a valid Indian mobile number (+91, 10 digits starting 6–9)',
      })
    }

    if (parsed.data.category === 'MARKETING' && !(await isOptedIn(to))) {
      return reply.code(403).send({
        ok: false,
        message: 'Recipient has no active WhatsApp marketing consent',
      })
    }

    const result = await sendMetaTemplate({
      number: to,
      name: parsed.data.name,
      language: parsed.data.language,
      components: (parsed.data.components as never) ?? [],
    })

    if (!result.ok) {
      return reply.code(result.status >= 400 && result.status < 600 ? result.status : 502).send({
        ok: false,
        message: result.message,
        provider: 'meta_cloud',
        details: result.data,
      })
    }

    return {
      ok: true,
      provider: 'meta_cloud',
      category: parsed.data.category,
      messageId: extractMessageId(result.data),
      data: result.data,
    }
  })

  app.post('/v1/messages/text', { preHandler: requireServiceKey }, async (request, reply) => {
    const parsed = textSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.flatten() })
    }

    const to = toWhatsAppRecipient(parsed.data.phone)
    if (!to) {
      return reply.code(400).send({
        ok: false,
        message: 'Enter a valid Indian mobile number (+91, 10 digits starting 6–9)',
      })
    }

    const result = await sendMetaText({
      number: to,
      text: parsed.data.text,
    })

    if (!result.ok) {
      return reply.code(result.status >= 400 && result.status < 600 ? result.status : 502).send({
        ok: false,
        message: result.message,
        provider: 'meta_cloud',
        details: result.data,
      })
    }

    return {
      ok: true,
      provider: 'meta_cloud',
      messageId: extractMessageId(result.data),
      data: result.data,
    }
  })
}

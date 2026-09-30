import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireServiceKey } from '../auth'
import { config } from '../config'
import { toWhatsAppRecipient } from '../lib/phone'
import {
  closeConversationForPhone,
  startConversationForPhone,
} from '../lib/typebot-bridge'

const createBotSchema = z.object({
  enabled: z.boolean().default(true),
  url: z.string().url().optional(),
  typebot: z.string().min(1),
  description: z.string().optional(),
  triggerType: z.enum(['keyword', 'all']).default('keyword'),
  triggerOperator: z.enum(['equals', 'contains', 'startsWith', 'endsWith', 'regex']).default('equals'),
  triggerValue: z.string().default('hello'),
  expire: z.number().int().positive().default(300),
  keywordFinish: z.string().default('#EXIT'),
  delayMessage: z.number().int().min(0).default(1000),
  unknownMessage: z.string().default('Sorry, I did not understand.'),
  listeningFromMe: z.boolean().default(false),
  stopBotFromMe: z.boolean().default(false),
  keepOpen: z.boolean().default(false),
  debounceTime: z.number().int().min(0).default(10),
})

const startSchema = z.object({
  phone: z.string().min(8),
  typebot: z.string().min(1),
  url: z.string().url().optional(),
  startSession: z.boolean().default(true),
  variables: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional()
    .default([]),
})

const statusSchema = z.object({
  phone: z.string().min(8),
  status: z.enum(['opened', 'paused', 'closed']),
})

export async function typebotRoutes(app: FastifyInstance) {
  app.post('/v1/typebot/bots', { preHandler: requireServiceKey }, async (request, reply) => {
    const parsed = createBotSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.flatten() })
    }

    return reply.code(409).send({
      ok: false,
      message:
        'Bot registration is configuration-based. Publish the Typebot and set TYPEBOT_PUBLIC_ID; Evolution registration is optional.',
      currentPublicId: config.typebotPublicId,
    })
  })

  app.post('/v1/typebot/start', { preHandler: requireServiceKey }, async (request, reply) => {
    const parsed = startSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.flatten() })
    }

    const number = toWhatsAppRecipient(parsed.data.phone)
    if (!number) {
      return reply.code(400).send({
        ok: false,
        message: 'Enter a valid Indian mobile number (+91, 10 digits starting 6–9)',
      })
    }

    if (parsed.data.typebot !== config.typebotPublicId) {
      return reply.code(400).send({
        ok: false,
        message: `Configured Typebot is "${config.typebotPublicId}"`,
      })
    }

    try {
      const chat = await startConversationForPhone(
        number,
        Object.fromEntries(parsed.data.variables.map((item) => [item.name, item.value])),
      )
      return {
        ok: true,
        provider: 'typebot_direct',
        sessionId: chat.sessionId,
        resultId: chat.resultId,
      }
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        message: err instanceof Error ? err.message : 'Could not start Typebot',
      })
    }
  })

  app.post('/v1/typebot/status', { preHandler: requireServiceKey }, async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.flatten() })
    }

    const number = toWhatsAppRecipient(parsed.data.phone)
    if (!number) {
      return reply.code(400).send({
        ok: false,
        message: 'Enter a valid Indian mobile number (+91, 10 digits starting 6–9)',
      })
    }

    if (parsed.data.status === 'opened') {
      const chat = await startConversationForPhone(number)
      return { ok: true, status: 'opened', sessionId: chat.sessionId }
    }
    await closeConversationForPhone(number)
    return { ok: true, status: parsed.data.status }
  })
}

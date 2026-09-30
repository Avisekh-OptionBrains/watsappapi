import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireServiceKey } from '../auth'
import { toWhatsAppRecipient } from '../lib/phone'
import { getRedis } from '../lib/redis'

const updateSchema = z.object({
  status: z.enum(['pending', 'assigned', 'resolved']),
  assignedTo: z.string().max(120).optional(),
})

function key(phone: string) {
  return `wa:handoff:${phone}`
}

export async function handoffRoutes(app: FastifyInstance) {
  app.get('/v1/handoffs/:phone', { preHandler: requireServiceKey }, async (request, reply) => {
    const phone = toWhatsAppRecipient((request.params as { phone: string }).phone)
    if (!phone) return reply.code(400).send({ ok: false, message: 'Invalid phone' })
    const raw = await getRedis().get(key(phone))
    return { ok: true, handoff: raw ? JSON.parse(raw) : null }
  })

  app.patch('/v1/handoffs/:phone', { preHandler: requireServiceKey }, async (request, reply) => {
    const phone = toWhatsAppRecipient((request.params as { phone: string }).phone)
    const parsed = updateSchema.safeParse(request.body)
    if (!phone || !parsed.success) {
      return reply.code(400).send({ ok: false, message: 'Invalid handoff update' })
    }
    const raw = await getRedis().get(key(phone))
    if (!raw) return reply.code(404).send({ ok: false, message: 'Handoff not found' })
    const handoff = {
      ...JSON.parse(raw),
      ...parsed.data,
      updatedAt: new Date().toISOString(),
    }
    await getRedis().set(key(phone), JSON.stringify(handoff), 'EX', 60 * 60 * 24 * 30)
    return { ok: true, handoff }
  })
}


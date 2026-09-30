import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from './config'

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export async function requireServiceKey(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const serviceKey = (request.headers['x-service-key'] as string | undefined)?.trim() ?? ''
  const provided = bearer || serviceKey

  if (!provided || !timingSafeEqualString(provided, config.serviceApiKey)) {
    return reply.code(401).send({ ok: false, message: 'Unauthorized' })
  }
}

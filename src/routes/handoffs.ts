import { Hono } from 'hono'
import { z } from 'zod'
import { requireSite } from '../auth'
import { handBackToBot, takeOverChat } from '../bot/engine'
import type { AppEnv } from '../env'
import { setConversationMode } from '../lib/conversations'
import { readJson, recipientOr400 } from './util'

const updateSchema = z.object({
  status: z.enum(['pending', 'assigned', 'resolved']),
  assignedTo: z.string().max(120).optional(),
})

type HandoffRow = {
  phone: string
  status: string
  message: string | null
  assigned_to: string | null
  created_at: number
  updated_at: number
}

function toHandoff(row: HandoffRow) {
  return {
    phone: row.phone,
    status: row.status,
    message: row.message,
    assignedTo: row.assigned_to,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export const handoffs = new Hono<AppEnv>()
handoffs.use(requireSite)

handoffs.get('/', async (c) => {
  const status = c.req.query('status') || 'pending'
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM handoffs WHERE site_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 200',
  )
    .bind(c.get('site').id, status)
    .all<HandoffRow>()
  return c.json({ ok: true, handoffs: results.map(toHandoff) })
})

handoffs.get('/:phone', async (c) => {
  const phone = recipientOr400(c.req.param('phone'))
  const row = await c.env.DB.prepare('SELECT * FROM handoffs WHERE site_id = ? AND phone = ?')
    .bind(c.get('site').id, phone)
    .first<HandoffRow>()
  return c.json({ ok: true, handoff: row ? toHandoff(row) : null })
})

handoffs.patch('/:phone', async (c) => {
  const phone = recipientOr400(c.req.param('phone'))
  const body = await readJson(c, updateSchema)
  const row = await c.env.DB.prepare(
    `UPDATE handoffs SET status = ?, assigned_to = COALESCE(?, assigned_to), updated_at = ?
     WHERE site_id = ? AND phone = ? RETURNING *`,
  )
    .bind(body.status, body.assignedTo ?? null, Date.now(), c.get('site').id, phone)
    .first<HandoffRow>()
  if (!row) return c.json({ ok: false, message: 'Handoff not found' }, 404)
  const siteId = c.get('site').id
  if (body.status === 'resolved') await handBackToBot(c.env, phone, siteId)
  else if (body.status === 'assigned') await takeOverChat(c.env, phone, siteId, row.assigned_to || siteId)
  else await setConversationMode(c.env, { phone, siteId, mode: 'needs_help' })
  return c.json({ ok: true, handoff: toHandoff(row) })
})

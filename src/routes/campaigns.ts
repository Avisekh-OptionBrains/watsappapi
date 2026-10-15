import { Hono } from 'hono'
import { z } from 'zod'
import { requireSite } from '../auth'
import type { AppEnv, Env } from '../env'
import { createCampaign } from '../lib/campaigns'
import { readJson } from './util'

const createSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  templateName: z.string().min(1),
  language: z.string().default('en_US'),
  components: z.array(z.record(z.unknown())).default([]),
  category: z.enum(['MARKETING', 'UTILITY']).default('MARKETING'),
  requireOptIn: z.boolean().default(true),
  phones: z.array(z.string().min(8)).min(1),
})

type CampaignRow = {
  id: string
  site_id: string
  name: string
  template_name: string
  language: string
  category: string
  status: string
  created_at: number
  updated_at: number
}

type Totals = { total: number; pending: number; sent: number; delivered: number; read: number; failed: number }

export async function campaignTotals(env: Env, campaignId: string): Promise<Totals> {
  const { results } = await env.DB.prepare(
    'SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY status',
  )
    .bind(campaignId)
    .all<{ status: string; n: number }>()
  const totals: Totals = { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 }
  for (const row of results) {
    totals.total += row.n
    if (row.status in totals) totals[row.status as keyof Totals] += row.n
  }
  return totals
}

function toCampaign(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    templateName: row.template_name,
    language: row.language,
    category: row.category,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export const campaigns = new Hono<AppEnv>()
campaigns.use(requireSite)

campaigns.post('/', async (c) => {
  const body = await readJson(c, createSchema)
  const max = Number(c.env.CAMPAIGN_MAX_RECIPIENTS || 5000)
  if (body.phones.length > max) {
    return c.json({ ok: false, message: `Campaign exceeds maximum ${max} recipients` }, 400)
  }
  const created = await createCampaign(c.env, c.get('site'), body)
  return c.json({ ok: true, ...created }, 202)
})

campaigns.get('/', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 20), 100)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM campaigns WHERE site_id = ? ORDER BY created_at DESC LIMIT ?',
  )
    .bind(c.get('site').id, limit)
    .all<CampaignRow>()
  return c.json({ ok: true, campaigns: results.map(toCampaign) })
})

campaigns.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM campaigns WHERE id = ? AND site_id = ?')
    .bind(c.req.param('id'), c.get('site').id)
    .first<CampaignRow>()
  if (!row) return c.json({ ok: false, message: 'Campaign not found' }, 404)
  return c.json({ ok: true, campaign: { ...toCampaign(row), totals: await campaignTotals(c.env, row.id) } })
})

campaigns.get('/:id/recipients', async (c) => {
  const owned = await c.env.DB.prepare('SELECT id FROM campaigns WHERE id = ? AND site_id = ?')
    .bind(c.req.param('id'), c.get('site').id)
    .first()
  if (!owned) return c.json({ ok: false, message: 'Campaign not found' }, 404)
  const status = c.req.query('status')
  const limit = Math.min(Number(c.req.query('limit') || 200), 1000)
  const offset = Math.max(Number(c.req.query('offset') || 0), 0)
  const { results } = await c.env.DB.prepare(
    `SELECT phone, status, error, message_id, updated_at FROM campaign_recipients
     WHERE campaign_id = ? ${status ? 'AND status = ?' : ''} ORDER BY phone LIMIT ? OFFSET ?`,
  )
    .bind(...(status ? [c.req.param('id'), status, limit, offset] : [c.req.param('id'), limit, offset]))
    .all<{ phone: string; status: string; error: string | null; message_id: string | null; updated_at: number }>()
  return c.json({
    ok: true,
    recipients: results.map((r) => ({
      phone: r.phone,
      status: r.status,
      error: r.error,
      messageId: r.message_id,
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
  })
})

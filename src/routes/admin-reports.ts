import { Hono } from 'hono'
import { z } from 'zod'
import { adminOnly } from '../auth'
import type { AppEnv } from '../env'
import { cancelCampaign, createCampaign } from '../lib/campaigns'
import { buildTemplateMessage, getTemplates } from '../lib/templates'
import { getSite } from '../sites'
import { campaignTotals } from './campaigns'
import { DAY_MS, siteFilter } from './admin-shared'
import { readJson, upstreamStatus } from './util'

/** Mounted inside `admin` (already behind requireAdmin). */
export const adminReports = new Hono<AppEnv>()

// ---------- campaigns ----------

adminReports.get('/campaigns', async (c) => {
  const f = siteFilter(c.req.query('site'), 'c.site_id')
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.site_id, c.name, c.template_name, c.category, c.status, c.created_at,
            COUNT(r.phone) AS total,
            SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN r.status IN ('sent', 'delivered', 'read') THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN r.status IN ('delivered', 'read') THEN 1 ELSE 0 END) AS delivered,
            SUM(CASE WHEN r.status = 'read' THEN 1 ELSE 0 END) AS read,
            SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id = c.id
     WHERE 1 = 1${f.sql}
     GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50`,
  )
    .bind(...f.args)
    .all()
  return c.json({ ok: true, campaigns: results })
})

adminReports.get('/campaigns/:id', async (c) => {
  const id = c.req.param('id')
  const campaign = await c.env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<Record<string, unknown>>()
  if (!campaign) return c.json({ ok: false, message: 'Campaign not found' }, 404)
  const [totals, failed] = await Promise.all([
    campaignTotals(c.env, id),
    c.env.DB.prepare(
      `SELECT phone, error, updated_at FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'
       ORDER BY updated_at DESC LIMIT 200`,
    )
      .bind(id)
      .all<{ phone: string; error: string | null; updated_at: number }>(),
  ])
  return c.json({ ok: true, campaign, totals, failed: failed.results })
})

const campaignSchema = z.object({
  site: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  templateName: z.string().min(1),
  language: z.string().min(2),
  values: z.record(z.string().max(1024)).default({}),
  audience: z.enum(['list', 'tag', 'opted_in']),
  phones: z.array(z.string()).max(20_000).default([]),
  tag: z.string().optional(),
  requireOptIn: z.boolean().default(true),
})

adminReports.post('/campaigns', adminOnly, async (c) => {
  const body = await readJson(c, campaignSchema)
  const site = getSite(c.env, body.site)
  if (!site) return c.json({ ok: false, message: 'Unknown site' }, 400)

  const list = await getTemplates(c.env)
  if (!list.ok) return c.json({ ok: false, message: list.message }, upstreamStatus(list.status))
  const template = list.templates.find((t) => t.name === body.templateName && t.language === body.language)
  if (!template) return c.json({ ok: false, message: 'Template not found or not approved' }, 404)
  if (template.category !== 'MARKETING' && template.category !== 'UTILITY') {
    return c.json({ ok: false, message: 'Campaigns can use marketing or utility templates only' }, 400)
  }
  let components
  try {
    components = buildTemplateMessage(template, body.values).components
  } catch (err) {
    return c.json({ ok: false, message: (err as Error).message }, 400)
  }

  let phones = body.phones
  if (body.audience === 'tag') {
    if (!body.tag) return c.json({ ok: false, message: 'Pick a tag' }, 400)
    const { results } = await c.env.DB.prepare(
      `SELECT phone FROM conversations WHERE site_id = ?
       AND EXISTS (SELECT 1 FROM json_each(conversations.tags) WHERE value = ?)`,
    )
      .bind(site.id, body.tag.toLowerCase())
      .all<{ phone: string }>()
    phones = results.map((r) => r.phone)
  } else if (body.audience === 'opted_in') {
    const { results } = await c.env.DB.prepare('SELECT phone FROM consents WHERE site_id = ? AND opted_in = 1')
      .bind(site.id)
      .all<{ phone: string }>()
    phones = results.map((r) => r.phone)
  }
  const max = Number(c.env.CAMPAIGN_MAX_RECIPIENTS || 5000)
  if (!phones.length) return c.json({ ok: false, message: 'No recipients' }, 400)
  if (phones.length > max) return c.json({ ok: false, message: `Campaign exceeds maximum ${max} recipients` }, 400)

  const created = await createCampaign(c.env, site, {
    name: body.name,
    templateName: template.name,
    language: template.language,
    components,
    category: template.category,
    requireOptIn: template.category === 'MARKETING' || body.requireOptIn,
    phones,
  })
  return c.json({ ok: true, ...created }, 202)
})

adminReports.post('/campaigns/:id/cancel', adminOnly, async (c) => {
  const cancelled = await cancelCampaign(c.env, c.req.param('id'))
  if (!cancelled) return c.json({ ok: false, message: 'Campaign is not running' }, 409)
  return c.json({ ok: true })
})

// ---------- reports ----------

const GREETING_RE = /^(hi+|hello+|hey+|hii+|ok+|okay|thanks?|thank you|menu|start|stop|yes|no|bye)\W*$/i

adminReports.get('/reports', async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days') || 7), 1), 90)
  const offsetMs = Math.max(-840, Math.min(840, Number(c.req.query('tz') || 330))) * 60_000
  const firstDay = Math.floor((Date.now() + offsetMs) / DAY_MS) - (days - 1)
  const since = firstDay * DAY_MS - offsetMs
  const f = siteFilter(c.req.query('site'))
  const db = c.env.DB
  const dayExpr = `CAST((created_at + ?) / ${DAY_MS} AS INTEGER)`

  const [messages, newChats, requests, staff, choices, texts] = await Promise.all([
    db
      .prepare(
        `SELECT ${dayExpr} AS d, direction, author, CASE WHEN author = 'bot' AND agent = 'AI' THEN 1 ELSE 0 END AS ai,
                COUNT(*) AS n, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM chat_messages WHERE created_at >= ?${f.sql} GROUP BY d, direction, author, ai`,
      )
      .bind(offsetMs, since, ...f.args)
      .all<{ d: number; direction: string; author: string; ai: number; n: number; failed: number }>(),
    db
      .prepare(`SELECT ${dayExpr} AS d, COUNT(*) AS n FROM conversations WHERE created_at >= ?${f.sql} GROUP BY d`)
      .bind(offsetMs, since, ...f.args)
      .all<{ d: number; n: number }>(),
    db
      .prepare(
        `SELECT CAST((requested_at + ?) / ${DAY_MS} AS INTEGER) AS d, requested_at, first_reply_at, first_reply_by, resolved_at
         FROM support_requests WHERE requested_at >= ?${f.sql} ORDER BY requested_at LIMIT 5000`,
      )
      .bind(offsetMs, since, ...f.args)
      .all<{ d: number; requested_at: number; first_reply_at: number | null; first_reply_by: string | null; resolved_at: number | null }>(),
    db
      .prepare(
        `SELECT agent, COUNT(*) AS messages, COUNT(DISTINCT phone) AS chats FROM chat_messages
         WHERE author = 'agent' AND created_at >= ?${f.sql} GROUP BY agent ORDER BY messages DESC`,
      )
      .bind(since, ...f.args)
      .all<{ agent: string | null; messages: number; chats: number }>(),
    db
      .prepare(
        `SELECT text, COUNT(*) AS n FROM chat_messages
         WHERE direction = 'in' AND type IN ('interactive', 'button') AND created_at >= ?${f.sql}
         GROUP BY text ORDER BY n DESC LIMIT 12`,
      )
      .bind(since, ...f.args)
      .all<{ text: string; n: number }>(),
    db
      .prepare(
        `SELECT lower(trim(text)) AS text, COUNT(*) AS n FROM chat_messages
         WHERE direction = 'in' AND type = 'text' AND length(text) BETWEEN 3 AND 120 AND created_at >= ?${f.sql}
         GROUP BY lower(trim(text)) ORDER BY n DESC LIMIT 60`,
      )
      .bind(since, ...f.args)
      .all<{ text: string; n: number }>(),
  ])

  const series = Array.from({ length: days }, (_, i) => ({
    day: new Date((firstDay + i) * DAY_MS).toISOString().slice(0, 10),
    inbound: 0,
    bot: 0,
    ai: 0,
    agent: 0,
    system: 0,
    campaign: 0,
    failed: 0,
    newChats: 0,
    helpRequests: 0,
  }))
  const at = (d: number) => series[d - firstDay]
  for (const r of messages.results) {
    const s = at(r.d)
    if (!s) continue
    s.failed += r.failed
    if (r.direction === 'in') s.inbound += r.n
    else if (r.ai) s.ai += r.n
    else if (r.author === 'bot' || r.author === 'agent' || r.author === 'system' || r.author === 'campaign') s[r.author] += r.n
  }
  for (const r of newChats.results) if (at(r.d)) at(r.d).newChats += r.n
  for (const r of requests.results) if (at(r.d)) at(r.d).helpRequests += 1

  const waits = requests.results
    .filter((r) => r.first_reply_at)
    .map((r) => (r.first_reply_at! - r.requested_at) / 60_000)
    .sort((a, b) => a - b)
  const byStaff = new Map<string, number[]>()
  for (const r of requests.results) {
    if (!r.first_reply_at || !r.first_reply_by) continue
    const list = byStaff.get(r.first_reply_by) ?? []
    list.push((r.first_reply_at - r.requested_at) / 60_000)
    byStaff.set(r.first_reply_by, list)
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)

  return c.json({
    ok: true,
    days,
    series,
    support: {
      requests: requests.results.length,
      answered: waits.length,
      unanswered: requests.results.filter((r) => !r.first_reply_at).length,
      avgFirstReplyMin: avg(waits),
      medianFirstReplyMin: waits.length ? Math.round(waits[Math.floor(waits.length / 2)] * 10) / 10 : null,
      within15Min: waits.filter((w) => w <= 15).length,
    },
    staff: [...new Set([...staff.results.map((s) => s.agent ?? 'Unknown'), ...byStaff.keys()])].map((name) => {
      const row = staff.results.find((s) => (s.agent ?? 'Unknown') === name)
      return {
        name,
        messages: row?.messages ?? 0,
        chats: row?.chats ?? 0,
        firstReplies: byStaff.get(name)?.length ?? 0,
        avgFirstReplyMin: avg(byStaff.get(name) ?? []),
      }
    }),
    topChoices: choices.results,
    topQuestions: texts.results
      .filter((t) => !GREETING_RE.test(t.text) && !/^[\d\s+-]+$/.test(t.text) && !/\S+@\S+/.test(t.text))
      .slice(0, 15),
  })
})

// ---------- CSV export ----------

function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value)
  // Spreadsheet formula injection: customer text must never run as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

function csv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

function csvResponse(name: string, body: string): Response {
  return new Response(`\uFEFF${body}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  })
}

adminReports.get('/export/messages.csv', adminOnly, async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days') || 30), 1), 180)
  const f = siteFilter(c.req.query('site'), 'm.site_id')
  const since = Date.now() - days * DAY_MS
  const rows: unknown[][] = [['time_utc', 'site', 'phone', 'name', 'direction', 'author', 'staff', 'type', 'text', 'status', 'error']]
  let cursor = Number.MAX_SAFE_INTEGER
  for (let page = 0; page < 10; page++) {
    const { results } = await c.env.DB.prepare(
      `SELECT m.created_at, m.site_id, m.phone, v.name, m.direction, m.author, m.agent, m.type, m.text, m.status, m.error
       FROM chat_messages m LEFT JOIN conversations v ON v.phone = m.phone
       WHERE m.created_at >= ? AND m.created_at < ?${f.sql}
       ORDER BY m.created_at DESC LIMIT 5000`,
    )
      .bind(since, cursor, ...f.args)
      .all<Record<string, string | number | null>>()
    for (const r of results) {
      rows.push([
        new Date(Number(r.created_at)).toISOString(),
        r.site_id,
        r.phone,
        r.name,
        r.direction,
        r.author,
        r.agent,
        r.type,
        r.text,
        r.status,
        r.error,
      ])
    }
    if (results.length < 5000) break
    cursor = Number(results[results.length - 1].created_at)
  }
  return csvResponse(`whatsapp-messages-${days}d.csv`, csv(rows))
})

adminReports.get('/export/chats.csv', adminOnly, async (c) => {
  const f = siteFilter(c.req.query('site'))
  const { results } = await c.env.DB.prepare(
    `SELECT phone, site_id, name, mode, assigned_to, tags, last_message_at, last_inbound_at, created_at
     FROM conversations WHERE 1 = 1${f.sql} ORDER BY last_message_at DESC LIMIT 50000`,
  )
    .bind(...f.args)
    .all<Record<string, string | number | null>>()
  const iso = (v: unknown) => (v ? new Date(Number(v)).toISOString() : '')
  const rows: unknown[][] = [['phone', 'site', 'name', 'mode', 'assigned_to', 'tags', 'last_message_utc', 'last_customer_message_utc', 'first_seen_utc']]
  for (const r of results) {
    rows.push([
      r.phone,
      r.site_id,
      r.name,
      r.mode,
      r.assigned_to,
      (JSON.parse(String(r.tags || '[]')) as string[]).join(' '),
      iso(r.last_message_at),
      iso(r.last_inbound_at),
      iso(r.created_at),
    ])
  }
  return csvResponse('whatsapp-chats.csv', csv(rows))
})

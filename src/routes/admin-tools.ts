import { Hono } from 'hono'
import { z } from 'zod'
import { adminOnly, allStaff } from '../auth'
import type { AppEnv } from '../env'
import { normalizeTag } from '../lib/conversations'
import { newId } from '../lib/crypto'
import { getTemplates } from '../lib/templates'
import { getSite } from '../sites'
import { chatFor } from './admin-shared'
import { readJson, upstreamStatus } from './util'

/** Mounted inside `admin` (already behind requireAdmin). */
export const adminTools = new Hono<AppEnv>()

adminTools.get('/staff', (c) => c.json({ ok: true, staff: allStaff(c.env) }))

adminTools.get('/templates', async (c) => {
  const res = await getTemplates(c.env, c.req.query('refresh') === '1')
  if (!res.ok) return c.json({ ok: false, message: res.message }, upstreamStatus(res.status))
  return c.json({ ok: true, templates: res.templates })
})

// ---------- notes ----------

const noteSchema = z.object({ text: z.string().trim().min(1).max(2000) })

adminTools.post('/chats/:phone/notes', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)
  const { text } = await readJson(c, noteSchema)
  const note = { id: newId(), author: c.get('staff'), text, at: Date.now() }
  await c.env.DB.prepare('INSERT INTO staff_notes (id, phone, author, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(note.id, phone, note.author, note.text, note.at)
    .run()
  return c.json({ ok: true, note })
})

adminTools.delete('/notes/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT author FROM staff_notes WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ author: string }>()
  if (!row) return c.json({ ok: false, message: 'Note not found' }, 404)
  if (row.author !== c.get('staff') && c.get('role') !== 'admin') {
    return c.json({ ok: false, message: 'Only the author or an admin can delete this note' }, 403)
  }
  await c.env.DB.prepare('DELETE FROM staff_notes WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ---------- tags ----------

const tagsSchema = z.object({ tags: z.array(z.string().max(40)).max(20) })

adminTools.put('/chats/:phone/tags', async (c) => {
  const { phone, conv } = await chatFor(c.env, c.req.param('phone'))
  if (!conv) return c.json({ ok: false, message: 'Chat not found' }, 404)
  const { tags } = await readJson(c, tagsSchema)
  const clean = [...new Set(tags.map(normalizeTag).filter(Boolean))]
  await c.env.DB.prepare('UPDATE conversations SET tags = ? WHERE phone = ?').bind(JSON.stringify(clean), phone).run()
  return c.json({ ok: true, tags: clean })
})

adminTools.get('/tags', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT j.value AS tag, COUNT(*) AS n FROM conversations, json_each(conversations.tags) AS j
     GROUP BY j.value ORDER BY n DESC LIMIT 100`,
  ).all<{ tag: string; n: number }>()
  return c.json({ ok: true, tags: results.filter((r) => typeof r.tag === 'string') })
})

// ---------- quick replies ----------

type QuickReplyRow = { id: string; site_id: string | null; title: string; text: string; created_by: string; created_at: number }

adminTools.get('/quick-replies', async (c) => {
  const site = c.req.query('site')
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM quick_replies WHERE ${site ? '(site_id IS NULL OR site_id = ?)' : '1 = 1'} ORDER BY title`,
  )
    .bind(...(site ? [site] : []))
    .all<QuickReplyRow>()
  return c.json({
    ok: true,
    quickReplies: results.map((r) => ({ id: r.id, site: r.site_id, title: r.title, text: r.text, createdBy: r.created_by })),
  })
})

const quickReplySchema = z.object({
  title: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(4096),
  site: z.string().nullable().optional(),
})

adminTools.post('/quick-replies', adminOnly, async (c) => {
  const body = await readJson(c, quickReplySchema)
  if (body.site && !getSite(c.env, body.site)) return c.json({ ok: false, message: 'Unknown site' }, 400)
  const id = newId()
  await c.env.DB.prepare(
    'INSERT INTO quick_replies (id, site_id, title, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, body.site || null, body.title, body.text, c.get('staff'), Date.now())
    .run()
  return c.json({ ok: true, id })
})

adminTools.delete('/quick-replies/:id', adminOnly, async (c) => {
  await c.env.DB.prepare('DELETE FROM quick_replies WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

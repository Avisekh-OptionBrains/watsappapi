import { Hono } from 'hono'
import { requireAdmin, requireSite } from '../auth'
import type { AppEnv } from '../env'
import { getCatalog } from '../lib/catalog'
import { getSites } from '../sites'

export const catalog = new Hono<AppEnv>()

/** The calling site's own catalog, as the WhatsApp bot sees it. */
catalog.get('/catalog', requireSite, async (c) => {
  const result = await getCatalog(c.env, c.get('site'), { refresh: c.req.query('refresh') === '1' })
  if (!result) return c.json({ ok: false, message: 'Catalog unavailable (bot connector not configured or down)' }, 503)
  return c.json({ ok: true, ...result })
})

/** Every site's catalog in one place. */
catalog.get('/admin/catalog', requireAdmin, async (c) => {
  const refresh = c.req.query('refresh') === '1'
  const sites = await Promise.all(
    getSites(c.env).map(async (site) => ({
      site: site.id,
      name: site.name,
      catalog: site.bot ? await getCatalog(c.env, site, { refresh }) : null,
    })),
  )
  return c.json({ ok: true, sites })
})

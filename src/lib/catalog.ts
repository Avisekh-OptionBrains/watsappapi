import { connectorFor } from '../bot/connector'
import type { CatalogSection } from '../bot/types'
import type { Env } from '../env'
import type { Site } from '../sites'

const FRESH_MS = 10 * 60 * 1000

export type SiteCatalog = {
  site: string
  sections: CatalogSection[]
  fetchedAt: string
  stale: boolean
}

/**
 * Central catalog: each site's plans / portfolios / products normalised into sections and
 * cached in D1, so the bot and other sites do not hit the website on every message.
 * Falls back to the last good copy when the website is down.
 */
export async function getCatalog(env: Env, site: Site, opts?: { refresh?: boolean }): Promise<SiteCatalog | null> {
  const row = await env.DB.prepare('SELECT data, fetched_at FROM catalog_cache WHERE site_id = ?')
    .bind(site.id)
    .first<{ data: string; fetched_at: number }>()

  const cachedCopy = row
    ? { site: site.id, sections: JSON.parse(row.data) as CatalogSection[], fetchedAt: new Date(row.fetched_at).toISOString() }
    : null

  if (cachedCopy && !opts?.refresh && Date.now() - row!.fetched_at < FRESH_MS) {
    return { ...cachedCopy, stale: false }
  }

  const connector = connectorFor(site)
  if (!connector) return cachedCopy ? { ...cachedCopy, stale: true } : null

  const fresh = await connector.catalog()
  if (!fresh.ok) {
    console.warn('[catalog] fetch failed', site.id, fresh.message)
    return cachedCopy ? { ...cachedCopy, stale: true } : null
  }

  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO catalog_cache (site_id, data, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (site_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
  )
    .bind(site.id, JSON.stringify(fresh.data), now)
    .run()
  return { site: site.id, sections: fresh.data, fetchedAt: new Date(now).toISOString(), stale: false }
}

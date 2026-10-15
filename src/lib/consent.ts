import type { Env } from '../env'

/** site_id used for the WhatsApp-wide STOP / START switch on the shared number. */
export const GLOBAL_SCOPE = '*'

export type ConsentSource = 'website' | 'checkout' | 'admin' | 'whatsapp' | 'import'

export type ConsentRecord = {
  siteId: string
  phone: string
  optedIn: boolean
  source: string
  purpose: string
  updatedAt: string
}

export async function setConsent(
  env: Env,
  opts: { siteId: string; phone: string; optedIn: boolean; source: ConsentSource; purpose: string },
): Promise<ConsentRecord> {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO consents (site_id, phone, opted_in, source, purpose, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, phone) DO UPDATE SET
       opted_in = excluded.opted_in, source = excluded.source,
       purpose = excluded.purpose, updated_at = excluded.updated_at`,
  )
    .bind(opts.siteId, opts.phone, opts.optedIn ? 1 : 0, opts.source, opts.purpose, now)
    .run()
  return { ...opts, updatedAt: new Date(now).toISOString() }
}

type ConsentRow = {
  site_id: string
  phone: string
  opted_in: number
  source: string
  purpose: string
  updated_at: number
}

function toRecord(row: ConsentRow | null): ConsentRecord | null {
  if (!row) return null
  return {
    siteId: row.site_id,
    phone: row.phone,
    optedIn: row.opted_in === 1,
    source: row.source,
    purpose: row.purpose,
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export async function getConsent(env: Env, siteId: string, phone: string) {
  const [site, global] = await Promise.all([
    env.DB.prepare('SELECT * FROM consents WHERE site_id = ? AND phone = ?').bind(siteId, phone).first<ConsentRow>(),
    env.DB.prepare('SELECT * FROM consents WHERE site_id = ? AND phone = ?')
      .bind(GLOBAL_SCOPE, phone)
      .first<ConsentRow>(),
  ])
  return { consent: toRecord(site), whatsappOptOut: global ? global.opted_in === 0 : false }
}

/** Opted in for this site and not globally opted out with STOP. */
export async function optedInPhones(env: Env, siteId: string, phones: string[]): Promise<Set<string>> {
  const allowed = new Set<string>()
  const blocked = new Set<string>()
  // D1 allows at most 100 bound parameters per statement.
  for (let i = 0; i < phones.length; i += 90) {
    const chunk = phones.slice(i, i + 90)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await env.DB.prepare(
      `SELECT site_id, phone, opted_in FROM consents
       WHERE site_id IN (?, ?) AND phone IN (${placeholders})`,
    )
      .bind(siteId, GLOBAL_SCOPE, ...chunk)
      .all<{ site_id: string; phone: string; opted_in: number }>()
    for (const row of results) {
      if (row.site_id === GLOBAL_SCOPE && row.opted_in === 0) blocked.add(row.phone)
      if (row.site_id === siteId && row.opted_in === 1) allowed.add(row.phone)
    }
  }
  for (const phone of blocked) allowed.delete(phone)
  return allowed
}

export async function isOptedIn(env: Env, siteId: string, phone: string): Promise<boolean> {
  return (await optedInPhones(env, siteId, [phone])).has(phone)
}

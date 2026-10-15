import type { Env } from '../env'

export type BotStep =
  | { step: 'menu' }
  | { step: 'brands' }
  | { step: 'section'; sectionId: string }
  | { step: 'item'; sectionId: string; itemId: string }
  | { step: 'await_email'; next?: string }
  | { step: 'await_otp'; email: string; next?: string }

/** `options` are the ids of the last list/buttons shown, so "1", "2"... map to them. */
export type BotSession = BotStep & { options?: string[] }

export const SESSION_TTL_SEC = 45 * 60
const PHONE_SITE_TTL_MS = 90 * 24 * 60 * 60 * 1000

export async function loadSession(env: Env, phone: string): Promise<{ siteId: string; session: BotSession } | null> {
  const row = await env.DB.prepare('SELECT site_id, state, expires_at FROM bot_sessions WHERE phone = ?')
    .bind(phone)
    .first<{ site_id: string; state: string; expires_at: number }>()
  if (!row || row.expires_at < Date.now()) return null
  try {
    return { siteId: row.site_id, session: JSON.parse(row.state) as BotSession }
  } catch {
    return null
  }
}

export async function saveSession(
  env: Env,
  phone: string,
  siteId: string,
  session: BotSession,
  ttlSec = SESSION_TTL_SEC,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bot_sessions (phone, site_id, state, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (phone) DO UPDATE SET
       site_id = excluded.site_id, state = excluded.state, expires_at = excluded.expires_at`,
  )
    .bind(phone, siteId, JSON.stringify(session), Date.now() + ttlSec * 1000)
    .run()
}

export async function clearSession(env: Env, phone: string): Promise<void> {
  await env.DB.prepare('DELETE FROM bot_sessions WHERE phone = ?').bind(phone).run()
}

/** Brand the customer last chose on the shared number. */
export async function getPhoneSite(env: Env, phone: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT site_id, updated_at FROM phone_sites WHERE phone = ?')
    .bind(phone)
    .first<{ site_id: string; updated_at: number }>()
  if (!row || Date.now() - row.updated_at > PHONE_SITE_TTL_MS) return null
  return row.site_id
}

export async function setPhoneSite(env: Env, phone: string, siteId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO phone_sites (phone, site_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (phone) DO UPDATE SET site_id = excluded.site_id, updated_at = excluded.updated_at`,
  )
    .bind(phone, siteId, Date.now())
    .run()
}

/** Maps a numeric reply ("2") to the id of the second option last shown. */
export function resolveNumericReply(text: string, options: string[] | undefined): string | null {
  if (!options?.length || !/^\d{1,2}$/.test(text.trim())) return null
  const n = Number(text.trim())
  return n >= 1 && n <= options.length ? options[n - 1] : null
}

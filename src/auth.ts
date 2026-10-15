import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import type { AppEnv, Env, StaffRole } from './env'
import { safeEqual } from './lib/crypto'
import { siteForApiKey } from './sites'

function providedKey(header: string | undefined, serviceKey: string | undefined): string {
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  return bearer || serviceKey?.trim() || ''
}

/** Identifies the calling website by its API key. */
export const requireSite = createMiddleware<AppEnv>(async (c, next) => {
  const key = providedKey(c.req.header('authorization'), c.req.header('x-service-key'))
  const site = key ? siteForApiKey(c.env, key) : null
  if (!site) return c.json({ ok: false, message: 'Unauthorized' }, 401)
  c.set('site', site)
  await next()
})

export type StaffMember = { name: string; role: StaffRole }

const staffSchema = z.array(
  z.object({
    name: z.string().min(1).max(40),
    key: z.string().min(24),
    role: z.enum(['admin', 'agent']).default('agent'),
  }),
)
type StaffEntry = z.infer<typeof staffSchema>[number]
let staffCache: { raw: string; staff: StaffEntry[] } | null = null

function staffList(env: Env): StaffEntry[] {
  const raw = env.STAFF ?? ''
  if (staffCache?.raw === raw) return staffCache.staff
  let staff: StaffEntry[] = []
  if (raw) {
    try {
      staff = staffSchema.parse(JSON.parse(raw))
    } catch {
      console.error('[auth] STAFF is invalid; only ADMIN_API_KEY can sign in')
    }
  }
  staffCache = { raw, staff }
  return staff
}

/** Everyone who can sign in to the dashboard (names only). */
export function allStaff(env: Env): StaffMember[] {
  const members: StaffMember[] = env.ADMIN_API_KEY ? [{ name: 'Admin', role: 'admin' }] : []
  for (const s of staffList(env)) members.push({ name: s.name, role: s.role })
  return members
}

/** Staff member owning `key`, or null. Checks every key so timing reveals nothing. */
export function staffForKey(env: Env, key: string): StaffMember | null {
  let match: StaffMember | null = null
  if (env.ADMIN_API_KEY && env.ADMIN_API_KEY.length >= 24 && safeEqual(key, env.ADMIN_API_KEY)) {
    match = { name: 'Admin', role: 'admin' }
  }
  for (const member of staffList(env)) {
    if (safeEqual(key, member.key)) match = { name: member.name, role: member.role }
  }
  return match
}

/** Dashboard / admin API: ADMIN_API_KEY or a key from the STAFF list. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const key = providedKey(c.req.header('authorization'), c.req.header('x-service-key'))
  const staff = key ? staffForKey(c.env, key) : null
  if (!staff) return c.json({ ok: false, message: 'Unauthorized' }, 401)
  c.set('staff', staff.name)
  c.set('role', staff.role)
  await next()
})

/** Campaigns, quick-reply library, exports: admins only. */
export const adminOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('role') !== 'admin') return c.json({ ok: false, message: 'Only admins can do this' }, 403)
  await next()
})

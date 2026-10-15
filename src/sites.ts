import { z } from 'zod'
import type { Env } from './env'
import { safeEqual } from './lib/crypto'

const siteSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,32}$/, 'lowercase letters, digits and dashes only'),
  /** Shown in WhatsApp list rows (max 24 chars). */
  name: z.string().min(1).max(24),
  tagline: z.string().max(72).default(''),
  /** Key this website uses to call the gateway (Bearer / x-service-key). */
  apiKey: z.string().min(24),
  publicUrl: z.string().url(),
  supportUrl: z.string().url().optional(),
  supportEmail: z.string().email().optional(),
  /** Where gateway events (CRM messages, delivery receipts, handoffs) are posted. */
  webhook: z
    .object({
      url: z.string().url(),
      secret: z.string().min(16),
    })
    .optional(),
  /** Website endpoints the WhatsApp bot calls (catalog, sign-in, account status). */
  bot: z
    .object({
      enabled: z.boolean().default(true),
      apiUrl: z.string().url(),
      apiKey: z.string().min(16),
      connector: z.enum(['standard', 'optionbrains']).default('standard'),
    })
    .optional(),
  otp: z
    .object({
      template: z.string().min(1).default('otp_code'),
      language: z.string().min(2).default('en_US'),
      copyButton: z.boolean().default(true),
    })
    .default({}),
  /** Gemini answers for free-text questions (needs GEMINI_API_KEY). */
  ai: z
    .object({
      enabled: z.boolean().default(true),
      /** Extra facts / tone for this site, e.g. refund policy, opening hours. */
      instructions: z.string().max(4000).default(''),
    })
    .optional(),
})

export type Site = z.infer<typeof siteSchema>

let cached: { raw: string; sites: Site[] } | null = null

export function parseSites(raw: string): Site[] {
  let json: unknown
  try {
    json = JSON.parse(raw || '[]')
  } catch {
    throw new Error('SITES is not valid JSON')
  }
  const parsed = z.array(siteSchema).min(1).safeParse(json)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`SITES is invalid: ${detail}`)
  }
  const sites = parsed.data
  const ids = new Set<string>()
  const keys = new Set<string>()
  for (const site of sites) {
    if (ids.has(site.id)) throw new Error(`SITES has duplicate id "${site.id}"`)
    if (keys.has(site.apiKey)) throw new Error(`SITES has a duplicate apiKey (site "${site.id}")`)
    ids.add(site.id)
    keys.add(site.apiKey)
  }
  return sites
}

export function getSites(env: Env): Site[] {
  if (cached?.raw === env.SITES) return cached.sites
  const sites = parseSites(env.SITES)
  cached = { raw: env.SITES, sites }
  return sites
}

export function getSite(env: Env, id: string | null | undefined): Site | null {
  if (!id) return null
  return getSites(env).find((site) => site.id === id) ?? null
}

export function defaultSite(env: Env): Site {
  const sites = getSites(env)
  return getSite(env, env.DEFAULT_SITE) ?? sites[0]
}

export function botSites(env: Env): Site[] {
  return getSites(env).filter((site) => site.bot?.enabled)
}

export function siteForApiKey(env: Env, key: string): Site | null {
  let match: Site | null = null
  // Compare against every key so timing does not reveal which site matched.
  for (const site of getSites(env)) {
    if (safeEqual(key, site.apiKey)) match = site
  }
  return match
}

export function siteUrl(site: Site, path: string): string {
  const base = site.publicUrl.replace(/\/$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

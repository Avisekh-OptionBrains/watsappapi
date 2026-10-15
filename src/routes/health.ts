import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { metaConfigured } from '../lib/meta'
import { botSites, getSites } from '../sites'

export const health = new Hono<AppEnv>()

health.get('/', async (c) => {
  const warnings: string[] = []
  let db = false
  try {
    await c.env.DB.prepare('SELECT 1').first()
    db = true
  } catch {
    warnings.push('D1 database unreachable')
  }

  let sites = 0
  let bots = 0
  try {
    sites = getSites(c.env).length
    bots = botSites(c.env).length
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : 'SITES is invalid')
  }

  if (!metaConfigured(c.env)) warnings.push('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set')
  if (!c.env.WHATSAPP_APP_SECRET) warnings.push('WHATSAPP_APP_SECRET not set - Meta webhooks will be rejected')
  if (!c.env.WHATSAPP_VERIFY_TOKEN) warnings.push('WHATSAPP_VERIFY_TOKEN not set')

  const ok = db && sites > 0
  return c.json(
    {
      ok,
      service: 'wa-gateway',
      provider: 'meta_cloud',
      sites,
      bots: c.env.BOT_ENABLED === '0' ? 0 : bots,
      warnings,
    },
    ok ? 200 : 503,
  )
})

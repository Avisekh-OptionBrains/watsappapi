import { Hono } from 'hono'
import { z } from 'zod'
import { requireSite } from '../auth'
import type { AppEnv } from '../env'
import { getConsent, setConsent } from '../lib/consent'
import { readJson, recipientOr400 } from './util'

const consentSchema = z.object({
  phone: z.string().min(8),
  optedIn: z.boolean(),
  source: z.enum(['website', 'checkout', 'admin', 'whatsapp', 'import']),
  purpose: z.string().min(1).max(200).default('marketing'),
})

export const consents = new Hono<AppEnv>()
consents.use(requireSite)

consents.post('/', async (c) => {
  const body = await readJson(c, consentSchema)
  const phone = recipientOr400(body.phone)
  const consent = await setConsent(c.env, { ...body, phone, siteId: c.get('site').id })
  return c.json({ ok: true, consent })
})

consents.get('/:phone', async (c) => {
  const phone = recipientOr400(c.req.param('phone'))
  const { consent, whatsappOptOut } = await getConsent(c.env, c.get('site').id, phone)
  return c.json({ ok: true, consent, whatsappOptOut })
})

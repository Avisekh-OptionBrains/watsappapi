import { Hono } from 'hono'
import { z } from 'zod'
import { requireSite } from '../auth'
import { startBotFor } from '../bot/engine'
import { clearSession } from '../bot/state'
import type { AppEnv } from '../env'
import { readJson, recipientOr400 } from './util'

const phoneSchema = z.object({ phone: z.string().min(8) }).passthrough()

export const bot = new Hono<AppEnv>()

/**
 * Sends the calling site's menu to a customer. Free-form messages only reach customers who
 * wrote to the number in the last 24 hours; otherwise send a template instead.
 * `/typebot/start` is kept for older callers.
 */
for (const path of ['/bot/start', '/typebot/start']) {
  bot.post(path, requireSite, async (c) => {
    if (c.env.BOT_ENABLED === '0') return c.json({ ok: false, message: 'Bot is disabled' }, 409)
    const site = c.get('site')
    if (!site.bot?.enabled) return c.json({ ok: false, message: `Bot is not configured for ${site.id}` }, 409)
    const { phone } = await readJson(c, phoneSchema)
    const to = recipientOr400(phone)
    await startBotFor(c.env, site, to)
    return c.json({ ok: true, provider: 'native_bot', site: site.id })
  })
}

bot.post('/bot/stop', requireSite, async (c) => {
  const { phone } = await readJson(c, phoneSchema)
  await clearSession(c.env, recipientOr400(phone))
  return c.json({ ok: true })
})

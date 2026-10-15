import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv, CampaignJob, Env } from './env'
import { escalateWaiting } from './lib/support'
import { handleCampaignBatch } from './queue'
import { admin } from './routes/admin'
import { bot } from './routes/bot'
import { campaigns } from './routes/campaigns'
import { catalog } from './routes/catalog'
import { consents } from './routes/consents'
import { handoffs } from './routes/handoffs'
import { health } from './routes/health'
import { messages } from './routes/messages'
import { webhook } from './routes/webhook'

const app = new Hono<AppEnv>()

app.get('/', (c) => c.json({ ok: true, service: 'wa-gateway' }))
app.route('/health', health)
app.route('/webhook', webhook)
app.route('/v1', messages)
app.route('/v1', bot)
app.route('/v1', catalog)
app.route('/v1/consents', consents)
app.route('/v1/campaigns', campaigns)
app.route('/v1/handoffs', handoffs)
app.route('/v1/admin', admin)

app.notFound((c) => c.json({ ok: false, message: 'Not found' }, 404))
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('[gateway] unhandled error', c.req.method, c.req.path, err)
  return c.json({ ok: false, message: 'Internal error' }, 500)
})

const DAY_MS = 24 * 60 * 60 * 1000

async function cleanup(env: Env): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM processed_messages WHERE created_at < ?').bind(now - 7 * DAY_MS),
    env.DB.prepare('DELETE FROM bot_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM outbound_messages WHERE created_at < ?').bind(now - 90 * DAY_MS),
    env.DB.prepare(`DELETE FROM handoffs WHERE status = 'resolved' AND updated_at < ?`).bind(now - 30 * DAY_MS),
    env.DB.prepare('DELETE FROM chat_messages WHERE created_at < ?').bind(now - 180 * DAY_MS),
    env.DB.prepare('DELETE FROM support_requests WHERE requested_at < ?').bind(now - 365 * DAY_MS),
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now),
  ])
}

const CLEANUP_CRON = '17 3 * * *'

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<CampaignJob>, env: Env): Promise<void> {
    await handleCampaignBatch(batch, env)
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(controller.cron === CLEANUP_CRON ? cleanup(env) : escalateWaiting(env).then(() => undefined))
  },
} satisfies ExportedHandler<Env, CampaignJob>

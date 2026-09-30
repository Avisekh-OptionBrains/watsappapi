import type { FastifyInstance } from 'fastify'
import { config } from '../config'
import { getRedis } from '../lib/redis'

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    const checks = {
      metaCloud: Boolean(config.whatsappToken && config.whatsappPhoneNumberId),
      typebot: false,
      redis: false,
    }

    try {
      checks.redis = (await getRedis().ping()) === 'PONG'
    } catch {
      checks.redis = false
    }

    try {
      const res = await fetch(config.typebotApiUrl, { signal: AbortSignal.timeout(5000) })
      // Viewer intentionally returns 404 at `/`; any non-5xx response proves it is reachable.
      checks.typebot = res.status < 500
    } catch {
      checks.typebot = false
    }

    const ok = Object.values(checks).every(Boolean)
    return reply.code(ok ? 200 : 503).send({
      ok,
      service: 'watsappapi-gateway',
      provider: 'meta_cloud',
      checks,
      warnings: [
        ...(!config.whatsappAppSecret
          ? ['WHATSAPP_APP_SECRET is not set; webhook signature validation is disabled']
          : []),
        ...(!config.waBusinessTokenWebhook
          ? ['WA_BUSINESS_TOKEN_WEBHOOK is not set; Meta hub verification will fail']
          : []),
        ...(!config.whatsappProductBotEnabled
          ? ['WHATSAPP_PRODUCT_BOT_ENABLED is off; inbound chats use the published Typebot']
          : []),
      ],
      productBotEnabled: config.whatsappProductBotEnabled,
      ts: new Date().toISOString(),
    })
  })
}

import Fastify from 'fastify'
import cors from '@fastify/cors'
import rawBody from 'fastify-raw-body'
import { config } from './config'
import { healthRoutes } from './routes/health'
import { otpRoutes } from './routes/otp'
import { messageRoutes } from './routes/messages'
import { campaignRoutes } from './routes/campaigns'
import { typebotRoutes } from './routes/typebot'
import { webhookRoutes } from './routes/webhooks'
import { closeCampaignQueue, startCampaignWorker } from './workers/campaign-worker'
import { consentRoutes } from './routes/consents'
import { handoffRoutes } from './routes/handoffs'
import { closeRedis } from './lib/redis'

async function main() {
  const app = Fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024,
  })

  await app.register(cors, { origin: true })
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
  })

  await healthRoutes(app)
  await otpRoutes(app)
  await messageRoutes(app)
  await campaignRoutes(app)
  await consentRoutes(app)
  await handoffRoutes(app)
  await typebotRoutes(app)
  await webhookRoutes(app)

  const campaignWorker = startCampaignWorker()
  app.addHook('onClose', async () => {
    await campaignWorker.close()
    await closeCampaignQueue()
    await closeRedis()
  })

  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info(`Gateway listening on :${config.port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

import { Queue, Worker, type ConnectionOptions } from 'bullmq'
import { config } from '../config'
import { extractMessageId, type TemplateComponent } from '../clients/evolution'
import { sendMetaTemplate } from '../clients/meta-cloud'
import { toWhatsAppRecipient } from '../lib/phone'
import {
  getCampaign,
  setCampaignStatus,
  updateRecipient,
} from '../lib/campaign-store'
import { notifyDeliveryStatus } from '../lib/research-messages'

export const CAMPAIGN_QUEUE = 'wa-campaigns'

export type CampaignJobData = {
  campaignId: string
  phone: string
  templateName: string
  language: string
  components: TemplateComponent[]
}

function redisConnection(): ConnectionOptions {
  const u = new URL(config.redisUrl)
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: Number(u.pathname.replace('/', '') || 0),
    maxRetriesPerRequest: null,
  }
}

let queue: Queue<CampaignJobData> | null = null

export function getCampaignQueue() {
  if (!queue) {
    queue = new Queue<CampaignJobData>(CAMPAIGN_QUEUE, { connection: redisConnection() })
  }
  return queue
}

export async function closeCampaignQueue() {
  if (!queue) return
  await queue.close()
  queue = null
}

export function startCampaignWorker() {
  const worker = new Worker<CampaignJobData>(
    CAMPAIGN_QUEUE,
    async (job) => {
      const { campaignId, phone, templateName, language, components } = job.data
      await setCampaignStatus(campaignId, 'processing')

      const to = toWhatsAppRecipient(phone)
      if (!to) {
        await updateRecipient(campaignId, phone, {
          status: 'failed',
          error: 'Invalid Indian mobile number',
        })
        return
      }

      const result = await sendMetaTemplate({
        number: to,
        name: templateName,
        language,
        components,
      })

      if (!result.ok) {
        throw new Error(result.message)
      }

      await updateRecipient(campaignId, phone, {
        status: 'sent',
        messageId: extractMessageId(result.data),
        error: undefined,
      })

      if (config.campaignSendDelayMs > 0) {
        await new Promise((r) => setTimeout(r, config.campaignSendDelayMs))
      }
    },
    {
      connection: redisConnection(),
      concurrency: 1,
    },
  )

  worker.on('failed', async (job, err) => {
    console.error('[campaign-worker] job failed', job?.id, err.message)
    if (!job) return
    const maxAttempts = job.opts.attempts ?? 1
    if (job.attemptsMade >= maxAttempts) {
      await updateRecipient(job.data.campaignId, job.data.phone, {
        status: 'failed',
        error: err.message,
      })
      void notifyDeliveryStatus({
        messageId: `fail:${job.data.campaignId}:${job.data.phone}`,
        phone: job.data.phone,
        status: 'failed',
        error: err.message,
        kind: 'template',
        preview: job.data.templateName,
      })
      const c = await getCampaign(job.data.campaignId)
      if (c && !c.recipients.some((r) => r.status === 'pending')) {
        const allFailed = c.recipients.every((r) => r.status === 'failed')
        await setCampaignStatus(c.id, allFailed ? 'failed' : 'completed')
      }
    }
  })

  worker.on('completed', async (job) => {
    const c = await getCampaign(job.data.campaignId)
    if (!c) return
    const pending = c.recipients.some((r) => r.status === 'pending')
    if (!pending) {
      const allFailed = c.recipients.every((r) => r.status === 'failed')
      await setCampaignStatus(job.data.campaignId, allFailed ? 'failed' : 'completed')
    }
  })

  return worker
}

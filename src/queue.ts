import type { CampaignJob, Env } from './env'
import { isOptedIn } from './lib/consent'
import { sendTemplate, type TemplateComponent } from './lib/meta'
import { recordOutbound } from './lib/outbound'
import { getSite } from './sites'

type CampaignRow = {
  id: string
  site_id: string
  template_name: string
  language: string
  category: string
  components: string
  status: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function markRecipient(env: Env, job: CampaignJob, status: string, error: string | null, messageId?: string) {
  await env.DB.prepare(
    `UPDATE campaign_recipients SET status = ?, error = ?, message_id = COALESCE(?, message_id), updated_at = ?
     WHERE campaign_id = ? AND phone = ?`,
  )
    .bind(status, error, messageId ?? null, Date.now(), job.campaignId, job.phone)
    .run()
}

async function finalizeCampaign(env: Env, campaignId: string) {
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status != 'failed' THEN 1 ELSE 0 END) AS ok
     FROM campaign_recipients WHERE campaign_id = ?`,
  )
    .bind(campaignId)
    .first<{ pending: number | null; ok: number | null }>()
  if (counts?.pending) return
  await env.DB.prepare(`UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'processing')`)
    .bind(counts?.ok ? 'completed' : 'failed', Date.now(), campaignId)
    .run()
}

/** Sends one campaign template per queue message, paced to stay under Meta's rate limits. */
export async function handleCampaignBatch(batch: MessageBatch<CampaignJob>, env: Env): Promise<void> {
  const delayMs = Number(env.CAMPAIGN_SEND_DELAY_MS || 300)
  const campaigns = new Map<string, CampaignRow | null>()
  const touched = new Set<string>()

  for (const msg of batch.messages) {
    const job = msg.body
    touched.add(job.campaignId)

    const recipient = await env.DB.prepare('SELECT status FROM campaign_recipients WHERE campaign_id = ? AND phone = ?')
      .bind(job.campaignId, job.phone)
      .first<{ status: string }>()
    if (recipient?.status !== 'pending') {
      msg.ack()
      continue
    }

    if (!campaigns.has(job.campaignId)) {
      const row = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(job.campaignId).first<CampaignRow>()
      campaigns.set(job.campaignId, row)
      if (row?.status === 'queued') {
        await env.DB.prepare(`UPDATE campaigns SET status = 'processing', updated_at = ? WHERE id = ?`)
          .bind(Date.now(), row.id)
          .run()
      }
    }
    const campaign = campaigns.get(job.campaignId)
    const site = getSite(env, job.siteId)
    if (!campaign || !site) {
      await markRecipient(env, job, 'failed', 'Campaign or site no longer exists')
      msg.ack()
      continue
    }

    // Consent can be withdrawn (STOP) between queueing and sending.
    if (campaign.category === 'MARKETING' && !(await isOptedIn(env, site.id, job.phone))) {
      await markRecipient(env, job, 'failed', 'No active WhatsApp marketing consent')
      msg.ack()
      continue
    }

    const sent = await sendTemplate(env, job.phone, {
      name: campaign.template_name,
      language: campaign.language,
      components: JSON.parse(campaign.components) as TemplateComponent[],
    })
    if (sent.ok) {
      await markRecipient(env, job, 'sent', null, sent.messageId ?? undefined)
      await recordOutbound(env, site, {
        messageId: sent.messageId,
        phone: job.phone,
        kind: 'template',
        text: `Campaign: ${campaign.template_name}`,
        author: 'campaign',
        campaignId: campaign.id,
        notifySite: false,
      })
      msg.ack()
    } else if ((sent.status === 429 || sent.status >= 500) && msg.attempts < 3) {
      msg.retry({ delaySeconds: 30 })
    } else {
      await markRecipient(env, job, 'failed', sent.message.slice(0, 200))
      msg.ack()
    }

    if (delayMs > 0) await sleep(delayMs)
  }

  for (const campaignId of touched) await finalizeCampaign(env, campaignId)
}

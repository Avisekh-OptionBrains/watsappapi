import type { CampaignJob, Env } from '../env'
import type { Site } from '../sites'
import { optedInPhones } from './consent'
import { newId } from './crypto'
import type { TemplateComponent } from './meta'
import { toWhatsAppRecipient } from './phone'

export type NewCampaign = {
  name?: string
  templateName: string
  language: string
  components: TemplateComponent[]
  category: 'MARKETING' | 'UTILITY'
  requireOptIn: boolean
  phones: string[]
}

export type CampaignCreated = {
  campaignId: string
  queued: number
  skipped: number
  invalid: number
  status: 'queued' | 'failed'
}

/** Stores the campaign and recipients, then queues one job per sendable phone. */
export async function createCampaign(env: Env, site: Site, body: NewCampaign): Promise<CampaignCreated> {
  const unique = new Map<string, string | null>()
  let invalid = 0
  for (const raw of body.phones) {
    const phone = toWhatsAppRecipient(raw)
    if (!phone) invalid++
    else if (!unique.has(phone)) unique.set(phone, null)
  }
  if (body.requireOptIn || body.category === 'MARKETING') {
    const allowed = await optedInPhones(env, site.id, [...unique.keys()])
    for (const phone of unique.keys()) {
      if (!allowed.has(phone)) unique.set(phone, 'No active WhatsApp marketing consent')
    }
  }

  const id = newId()
  const now = Date.now()
  const pending = [...unique].filter(([, error]) => !error).map(([phone]) => phone)
  const status = pending.length ? 'queued' : 'failed'

  const statements = [
    env.DB.prepare(
      `INSERT INTO campaigns (id, site_id, name, template_name, language, category, components, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      site.id,
      body.name || `campaign-${id}`,
      body.templateName,
      body.language,
      body.category,
      JSON.stringify(body.components),
      status,
      now,
      now,
    ),
    ...[...unique].map(([phone, error]) =>
      env.DB.prepare(
        `INSERT INTO campaign_recipients (campaign_id, phone, status, error, message_id, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      ).bind(id, phone, error ? 'failed' : 'pending', error, now),
    ),
  ]
  for (let i = 0; i < statements.length; i += 500) {
    await env.DB.batch(statements.slice(i, i + 500))
  }

  const jobs = pending.map((phone) => ({ body: { campaignId: id, siteId: site.id, phone } satisfies CampaignJob }))
  for (let i = 0; i < jobs.length; i += 100) {
    await env.CAMPAIGN_QUEUE.sendBatch(jobs.slice(i, i + 100))
  }
  return { campaignId: id, queued: pending.length, skipped: unique.size - pending.length, invalid, status }
}

/** Pending recipients are skipped by the queue consumer once marked failed. */
export async function cancelCampaign(env: Env, campaignId: string): Promise<boolean> {
  const now = Date.now()
  const updated = await env.DB.prepare(
    `UPDATE campaigns SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued', 'processing')`,
  )
    .bind(now, campaignId)
    .run()
  if (!updated.meta.changes) return false
  await env.DB.prepare(
    `UPDATE campaign_recipients SET status = 'failed', error = 'Cancelled', updated_at = ? WHERE campaign_id = ? AND status = 'pending'`,
  )
    .bind(now, campaignId)
    .run()
  return true
}

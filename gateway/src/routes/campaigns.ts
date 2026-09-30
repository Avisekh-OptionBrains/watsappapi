import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { requireServiceKey } from '../auth'
import type { TemplateComponent } from '../clients/evolution'
import { getCampaign, saveCampaign, type CampaignRecipient } from '../lib/campaign-store'
import { getCampaignQueue } from '../workers/campaign-worker'
import { toWhatsAppRecipient } from '../lib/phone'
import { config } from '../config'
import { isOptedIn } from '../lib/consent-store'

const createSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  templateName: z.string().min(1),
  language: z.string().default('en_US'),
  components: z.array(z.record(z.unknown())).optional().default([]),
  category: z.enum(['MARKETING', 'UTILITY']).default('MARKETING'),
  requireOptIn: z.boolean().default(true),
  phones: z.array(z.string().min(8)).min(1),
})

export async function campaignRoutes(app: FastifyInstance) {
  app.post('/v1/campaigns', { preHandler: requireServiceKey }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.flatten() })
    }
    if (parsed.data.phones.length > config.campaignMaxRecipients) {
      return reply.code(400).send({
        ok: false,
        message: `Campaign exceeds maximum ${config.campaignMaxRecipients} recipients`,
      })
    }

    const now = new Date().toISOString()
    const id = nanoid(12)
    const recipients: CampaignRecipient[] = []
    const seen = new Set<string>()

    for (const phone of parsed.data.phones) {
      const digits = toWhatsAppRecipient(phone)
      if (!digits) {
        recipients.push({
          phone,
          status: 'failed',
          error: 'Invalid Indian mobile',
          updatedAt: now,
        })
        continue
      }
      if (seen.has(digits)) continue
      seen.add(digits)

      const requiresConsent =
        parsed.data.requireOptIn || config.campaignRequireOptIn || parsed.data.category === 'MARKETING'
      if (requiresConsent && !(await isOptedIn(digits))) {
        recipients.push({
          phone: digits,
          status: 'failed',
          error: 'No active WhatsApp marketing consent',
          updatedAt: now,
        })
        continue
      }
      recipients.push({ phone: digits, status: 'pending', updatedAt: now })
    }

    const pending = recipients.filter((r) => r.status === 'pending')
    const campaign = {
      id,
      name: parsed.data.name || `campaign-${id}`,
      templateName: parsed.data.templateName,
      language: parsed.data.language,
      category: parsed.data.category,
      requireOptIn: parsed.data.requireOptIn,
      components: parsed.data.components,
      status: (pending.length === 0
        ? recipients.every((r) => r.status === 'failed')
          ? 'failed'
          : 'completed'
        : 'queued') as 'queued' | 'processing' | 'completed' | 'failed',
      createdAt: now,
      updatedAt: now,
      totals: {
        total: recipients.length,
        sent: 0,
        failed: recipients.filter((r) => r.status === 'failed').length,
        delivered: 0,
        read: 0,
      },
      recipients,
    }
    await saveCampaign(campaign)

    const queue = getCampaignQueue()
    for (const r of pending) {
      await queue.add(
        'send',
        {
          campaignId: id,
          phone: r.phone,
          templateName: parsed.data.templateName,
          language: parsed.data.language,
          components: parsed.data.components as TemplateComponent[],
        },
        {
          jobId: `${id}:${r.phone}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      )
    }

    return reply.code(202).send({
      ok: true,
      campaignId: id,
      queued: pending.length,
      totals: campaign.totals,
    })
  })

  app.get('/v1/campaigns/:id', { preHandler: requireServiceKey }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const campaign = await getCampaign(id)
    if (!campaign) {
      return reply.code(404).send({ ok: false, message: 'Campaign not found' })
    }
    return { ok: true, campaign }
  })
}

export type CampaignRecipientStatus = 'pending' | 'sent' | 'failed' | 'delivered' | 'read'

export type CampaignRecipient = {
  phone: string
  status: CampaignRecipientStatus
  messageId?: string | null
  error?: string
  updatedAt: string
}

export type CampaignRecord = {
  id: string
  name: string
  templateName: string
  language: string
  category: 'MARKETING' | 'UTILITY'
  requireOptIn: boolean
  components: unknown[]
  status: 'queued' | 'processing' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  totals: { total: number; sent: number; failed: number; delivered: number; read: number }
  recipients: CampaignRecipient[]
}

const CAMPAIGN_TTL_SECONDS = 60 * 60 * 24 * 90

function campaignKey(id: string) {
  return `wa:campaign:${id}`
}

function messageKey(messageId: string) {
  return `wa:message-campaign:${messageId}`
}

async function writeCampaign(campaign: CampaignRecord) {
  const { getRedis } = await import('./redis')
  await getRedis().set(campaignKey(campaign.id), JSON.stringify(campaign), 'EX', CAMPAIGN_TTL_SECONDS)
}

export async function saveCampaign(campaign: CampaignRecord) {
  await writeCampaign(campaign)
}

export async function getCampaign(id: string): Promise<CampaignRecord | undefined> {
  const { getRedis } = await import('./redis')
  const raw = await getRedis().get(campaignKey(id))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as CampaignRecord
  } catch {
    return undefined
  }
}

export async function updateRecipient(
  campaignId: string,
  phone: string,
  patch: Partial<CampaignRecipient>,
) {
  const c = await getCampaign(campaignId)
  if (!c) return
  const r = c.recipients.find((x) => x.phone === phone)
  if (!r) return
  Object.assign(r, patch, { updatedAt: new Date().toISOString() })
  c.totals.sent = c.recipients.filter((x) => x.status === 'sent' || x.status === 'delivered' || x.status === 'read').length
  c.totals.failed = c.recipients.filter((x) => x.status === 'failed').length
  c.totals.delivered = c.recipients.filter((x) => x.status === 'delivered' || x.status === 'read').length
  c.totals.read = c.recipients.filter((x) => x.status === 'read').length
  c.updatedAt = new Date().toISOString()
  await writeCampaign(c)

  if (patch.messageId) {
    const { getRedis } = await import('./redis')
    await getRedis().set(
      messageKey(patch.messageId),
      JSON.stringify({ campaignId, phone }),
      'EX',
      CAMPAIGN_TTL_SECONDS,
    )
  }
}

export async function setCampaignStatus(id: string, status: CampaignRecord['status']) {
  const c = await getCampaign(id)
  if (!c) return
  c.status = status
  c.updatedAt = new Date().toISOString()
  await writeCampaign(c)
}

/** Match webhook message id → campaign recipient for delivery updates */
export async function markByMessageId(messageId: string, status: CampaignRecipientStatus) {
  const { getRedis } = await import('./redis')
  const raw = await getRedis().get(messageKey(messageId))
  if (!raw) return null
  const link = JSON.parse(raw) as { campaignId: string; phone: string }
  await updateRecipient(link.campaignId, link.phone, { status })
  return link
}

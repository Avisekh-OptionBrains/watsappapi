const OPT_OUT_RE = /^(stop|unsubscribe|opt[\s-]?out|cancel)\b/i
const OPT_IN_RE = /^(start|subscribe|opt[\s-]?in)\b/i

export type CrmKind = 'opt_out' | 'opt_in' | 'message'

/** STOP / START keywords. A bare "subscribe" is a normal question, not consent. */
export function classifyCrmKind(text: string): CrmKind {
  if (OPT_OUT_RE.test(text)) return 'opt_out'
  if (OPT_IN_RE.test(text) && !/^subscribe$/i.test(text.trim())) return 'opt_in'
  return 'message'
}

export type InboundMessage = {
  from: string
  messageId: string
  type: string
  /** Text body, or the tapped option's title, or `[image]` etc. for media. */
  text: string
  interactiveId: string | null
  profileName: string | null
  media: InboundMedia | null
}

export type InboundMedia = { id: string; mime: string | null; name: string | null }

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker'])

function mediaOf(m: Record<string, unknown>, type: string): { media: InboundMedia | null; caption: string } {
  if (!MEDIA_TYPES.has(type)) return { media: null, caption: '' }
  const raw = m[type] as { id?: string; mime_type?: string; filename?: string; caption?: string } | undefined
  if (!raw?.id) return { media: null, caption: '' }
  return {
    media: { id: raw.id, mime: raw.mime_type ?? null, name: raw.filename ?? null },
    caption: raw.caption?.trim() ?? '',
  }
}

export type StatusUpdate = {
  id: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  recipientId: string | null
  errors: unknown
}

type MetaValue = {
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
  messages?: Array<Record<string, unknown>>
  statuses?: Array<{ id?: string; status?: string; recipient_id?: string; errors?: unknown }>
}

function values(body: unknown): MetaValue[] {
  const entry = (body as { entry?: Array<{ changes?: Array<{ value?: MetaValue }> }> } | null)?.entry
  if (!Array.isArray(entry)) return []
  return entry.flatMap((e) => (e.changes ?? []).map((ch) => ch.value).filter((v): v is MetaValue => Boolean(v)))
}

export function extractInbound(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = []
  for (const value of values(body)) {
    for (const m of value.messages ?? []) {
      const from = typeof m.from === 'string' ? m.from : ''
      const messageId = typeof m.id === 'string' ? m.id : ''
      const type = typeof m.type === 'string' ? m.type : 'unknown'
      if (!from || !messageId) continue

      const interactive = m.interactive as
        | { list_reply?: { id?: string; title?: string }; button_reply?: { id?: string; title?: string } }
        | undefined
      const button = m.button as { payload?: string; text?: string } | undefined
      const interactiveId = interactive?.list_reply?.id || interactive?.button_reply?.id || button?.payload || null
      const { media, caption } = mediaOf(m, type)
      const text = String(
        (m.text as { body?: string } | undefined)?.body ??
          interactive?.button_reply?.title ??
          interactive?.list_reply?.title ??
          button?.text ??
          button?.payload ??
          (caption || (type === 'text' ? '' : `[${type}]`)),
      ).trim()

      const contact = value.contacts?.find((c) => c.wa_id === from) ?? value.contacts?.[0]
      out.push({ from, messageId, type, text, interactiveId, profileName: contact?.profile?.name ?? null, media })
    }
  }
  return out
}

export function extractStatuses(body: unknown): StatusUpdate[] {
  const out: StatusUpdate[] = []
  for (const value of values(body)) {
    for (const s of value.statuses ?? []) {
      const raw = s.status?.toLowerCase()
      const status = raw === 'played' ? 'read' : raw
      if (!s.id || (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed')) continue
      out.push({ id: s.id, status, recipientId: s.recipient_id ?? null, errors: s.errors })
    }
  }
  return out
}

/** Receipts can arrive out of order; never move a message backwards (read -> delivered). */
export const STATUS_RANK: Record<string, number> = {
  accepted: 0,
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
}

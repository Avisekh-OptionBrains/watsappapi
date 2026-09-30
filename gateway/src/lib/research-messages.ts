import { forwardToObResearch } from './research-webhook'

export type OutboundKind = 'otp' | 'template' | 'text'

/** Tell the website a WhatsApp message was accepted by Meta. Never include OTP codes. */
export async function notifyOutbound(opts: {
  phone: string
  messageId: string | null | undefined
  kind: OutboundKind
  preview: string
}): Promise<void> {
  const messageId = opts.messageId?.trim()
  if (!messageId) return
  await forwardToObResearch('whatsapp.outbound', {
    messageId,
    phone: opts.phone,
    kind: opts.kind,
    preview: opts.preview.slice(0, 180),
  })
}

/** Tell the website Meta's delivery receipt (sent, delivered, read, failed). */
export async function notifyDeliveryStatus(opts: {
  messageId: string
  phone?: string | null
  status: 'sent' | 'delivered' | 'read' | 'failed'
  error?: string | null
  kind?: OutboundKind
  preview?: string
}): Promise<void> {
  await forwardToObResearch('whatsapp.status', {
    messageId: opts.messageId,
    phone: opts.phone ?? null,
    status: opts.status,
    error: opts.error?.slice(0, 200) ?? null,
    kind: opts.kind ?? null,
    preview: opts.preview?.slice(0, 180) ?? null,
  })
}

export function deliveryErrorText(errors: unknown): string | null {
  if (!errors) return null
  const list = Array.isArray(errors) ? errors : [errors]
  const first = list[0]
  if (!first || typeof first !== 'object') return null
  const row = first as { title?: string; message?: string; error_data?: { details?: string } }
  const text = row.error_data?.details || row.title || row.message || ''
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 200) : null
}

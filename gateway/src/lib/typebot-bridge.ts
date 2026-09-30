import { config } from '../config'
import { markMetaMessageRead, sendMetaText } from '../clients/meta-cloud'
import { classifyWhatsAppCrmKind } from './crm-kind'
import { getRedis } from './redis'
import { setConsent } from './consent-store'
import { clearProductFlow, handleProductBotMessage } from './product-bot'
import { forwardToObResearch } from './research-webhook'
import { handlePublishedTypebot } from './typebot-runner'

function extractInboundTexts(body: unknown): Array<{
  from: string
  text: string
  messageId: string
  interactiveId: string | null
}> {
  const out: Array<{
    from: string
    text: string
    messageId: string
    interactiveId: string | null
  }> = []
  if (!body || typeof body !== 'object') return out
  const entry = (body as { entry?: unknown }).entry
  if (!Array.isArray(entry)) return out

  for (const e of entry) {
    const changes = (e as { changes?: unknown }).changes
    if (!Array.isArray(changes)) continue
    for (const ch of changes) {
      const value = (ch as { value?: { messages?: Array<Record<string, unknown>> } }).value
      const messages = value?.messages
      if (!Array.isArray(messages)) continue
      for (const m of messages) {
        const from = String(m.from ?? '')
        const messageId = String(m.id ?? '')
        const interactive = m.interactive as
          | {
              button_reply?: { id?: string; title?: string }
              list_reply?: { id?: string; title?: string }
            }
          | undefined
        const button = m.button as { payload?: string; text?: string } | undefined
        const interactiveId =
          interactive?.list_reply?.id ||
          interactive?.button_reply?.id ||
          button?.payload ||
          null
        const text = String(
          (m.text as { body?: string } | undefined)?.body ??
            button?.text ??
            button?.payload ??
            interactive?.button_reply?.title ??
            interactive?.list_reply?.title ??
            interactiveId ??
            '',
        ).trim()
        if (from && messageId && (text || interactiveId)) {
          out.push({
            from,
            text: text || interactiveId || '',
            messageId,
            interactiveId,
          })
        }
      }
    }
  }
  return out
}

async function replyAll(phone: string, lines: string[]) {
  for (const line of lines) {
    const sent = await sendMetaText({ number: phone, text: line })
    if (!sent.ok) {
      console.error('[typebot-bridge] send failed', phone, sent.message)
    }
  }
}

/** Customer entry — product menu (plans, portfolios, sign-in, account, help). */
export async function startConversationForPhone(
  phone: string,
  _variables?: Record<string, string>,
) {
  if (!config.whatsappProductBotEnabled) {
    return { sessionId: null as string | null, resultId: null as string | null }
  }
  await clearProductFlow(phone)
  await handleProductBotMessage(phone, 'hi')
  return { sessionId: null as string | null, resultId: null as string | null }
}

export async function closeConversationForPhone(phone: string) {
  await clearProductFlow(phone)
}

export async function handleTypebotInbound(body: unknown): Promise<number> {
  if (!config.typebotBridgeEnabled) return 0

  const msgs = extractInboundTexts(body)
  if (!msgs.length) return 0

  const r = getRedis()
  let handled = 0

  for (const { from, text, messageId, interactiveId } of msgs) {
    const dedupeKey = `wa:inbound:${messageId}`
    const firstDelivery = await r.set(dedupeKey, '1', 'EX', 60 * 60 * 24 * 7, 'NX')
    if (!firstDelivery) continue

    handled += 1
    try {
      void markMetaMessageRead(messageId)
      const kind = classifyWhatsAppCrmKind(text)
      await forwardToObResearch('whatsapp.crm', {
        phone: from,
        text,
        messageId,
        kind,
      })

      if (kind === 'opt_out') {
        await clearProductFlow(from)
        await setConsent({
          phone: from,
          optedIn: false,
          source: 'whatsapp',
          purpose: 'marketing',
          updatedAt: new Date().toISOString(),
        })
        await replyAll(from, [
          'You are unsubscribed from promotional WhatsApp messages. Reply START to subscribe again. Service messages may still be sent when required.',
        ])
        continue
      }

      if (kind === 'opt_in') {
        await setConsent({
          phone: from,
          optedIn: true,
          source: 'whatsapp',
          purpose: 'marketing',
          updatedAt: new Date().toISOString(),
        })
      }

      // Product chatbot is opt-in via WHATSAPP_PRODUCT_BOT_ENABLED=1.
      // When it is off, WhatsApp plays the published Typebot (public id ob-support).
      if (!config.whatsappProductBotEnabled) {
        await handlePublishedTypebot(from, text)
        continue
      }

      await handleProductBotMessage(from, text, interactiveId)
    } catch (err) {
      console.error('[typebot-bridge] error', from, err)
      await clearProductFlow(from)
      await replyAll(from, [
        'Sorry, chat is temporarily unavailable. Please try again in a moment or email support@optionbrains.com',
      ])
    }
  }

  return handled
}

export { mapChoiceReply } from './choice-map'

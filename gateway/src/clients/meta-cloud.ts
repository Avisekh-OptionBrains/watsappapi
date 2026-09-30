import { config } from '../config'
import type { EvolutionResult, TemplateComponent } from './evolution'
import { notifyOutbound } from '../lib/research-messages'

/** Send template via official Meta Cloud API (bypasses Evolution Cloud template bugs). */
export async function sendMetaTemplate(opts: {
  number: string
  name: string
  language: string
  components?: TemplateComponent[]
}): Promise<EvolutionResult> {
  if (!config.whatsappToken || !config.whatsappPhoneNumberId) {
    return {
      ok: false,
      status: 500,
      message: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required for Cloud sends',
    }
  }

  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.number.replace(/\D/g, ''),
    type: 'template',
    template: {
      name: opts.name,
      language: { code: opts.language },
      components: opts.components ?? [],
    },
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string; message_status?: string }[]
      error?: { message?: string; error_user_msg?: string; code?: number; type?: string }
    }

    if (!res.ok || data.error) {
      const msg =
        data.error?.error_user_msg ||
        data.error?.message ||
        `Meta Graph HTTP ${res.status}`
      return { ok: false, status: res.status || 502, message: msg, data }
    }

    const messageId = data.messages?.[0]?.id ?? null
    const preview =
      opts.name === config.otpTemplateName || /otp/i.test(opts.name) ? 'Login code' : opts.name
    void notifyOutbound({
      phone: opts.number,
      messageId,
      kind: opts.name === config.otpTemplateName || /otp/i.test(opts.name) ? 'otp' : 'template',
      preview,
    })

    return {
      ok: true,
      status: res.status,
      data: {
        key: { id: messageId },
        messages: data.messages,
        message_status: data.messages?.[0]?.message_status,
      },
    }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message : 'Meta Graph request failed',
    }
  }
}

export async function sendMetaText(opts: {
  number: string
  text: string
}): Promise<EvolutionResult> {
  return sendMetaPayload(opts.number, {
    type: 'text',
    text: { preview_url: false, body: opts.text.slice(0, 4096) },
  })
}

export type MetaListRow = {
  id: string
  title: string
  description?: string
}

/** Bank-style list message (title + description rows). */
export async function sendMetaInteractiveList(opts: {
  number: string
  body: string
  buttonLabel?: string
  sectionTitle?: string
  rows: MetaListRow[]
  header?: string
  footer?: string
}): Promise<EvolutionResult> {
  const rows = opts.rows.slice(0, 10).map((r) => ({
    id: r.id.slice(0, 200),
    title: r.title.slice(0, 24),
    ...(r.description ? { description: r.description.slice(0, 72) } : {}),
  }))
  if (!rows.length) {
    return sendMetaText({ number: opts.number, text: opts.body })
  }

  const interactive: Record<string, unknown> = {
    type: 'list',
    body: { text: opts.body.slice(0, 1024) },
    action: {
      button: (opts.buttonLabel ?? 'Open menu').slice(0, 20),
      sections: [
        {
          title: (opts.sectionTitle ?? 'OptionBrains').slice(0, 24),
          rows,
        },
      ],
    },
  }
  if (opts.header?.trim()) {
    interactive.header = { type: 'text', text: opts.header.slice(0, 60) }
  }
  if (opts.footer?.trim()) {
    interactive.footer = { text: opts.footer.slice(0, 60) }
  }

  const sent = await sendMetaPayload(opts.number, { type: 'interactive', interactive })
  if (!sent.ok) {
    const fallback = [
      opts.body,
      '',
      'Reply with the number of your choice:',
      ...rows.map((r, i) => `${i + 1}. ${r.title}${r.description ? ` - ${r.description}` : ''}`),
    ].join('\n')
    return sendMetaText({ number: opts.number, text: fallback })
  }
  return sent
}

/** Up to 3 quick-reply buttons. */
export async function sendMetaReplyButtons(opts: {
  number: string
  body: string
  buttons: Array<{ id: string; title: string }>
}): Promise<EvolutionResult> {
  const buttons = opts.buttons.slice(0, 3).map((b) => ({
    type: 'reply' as const,
    reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
  }))
  if (!buttons.length) {
    return sendMetaText({ number: opts.number, text: opts.body })
  }

  const sent = await sendMetaPayload(opts.number, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: opts.body.slice(0, 1024) },
      action: { buttons },
    },
  })
  if (!sent.ok) {
    const fallback = [
      opts.body,
      ...buttons.map((b, i) => `${i + 1}. ${b.reply.title}`),
    ].join('\n')
    return sendMetaText({ number: opts.number, text: fallback })
  }
  return sent
}

/** CTA with a website button - do not paste token URLs in the body. */
export async function sendMetaCtaUrl(opts: {
  number: string
  body: string
  displayText: string
  url: string
}): Promise<EvolutionResult> {
  const sent = await sendMetaPayload(opts.number, {
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: opts.body.slice(0, 1024) },
      action: {
        name: 'cta_url',
        parameters: {
          display_text: opts.displayText.slice(0, 20),
          url: opts.url,
        },
      },
    },
  })
  if (!sent.ok) {
    const sensitive = /[?&]token=|\/auth\/whatsapp-handoff/i.test(opts.url)
    const text = sensitive
      ? `${opts.body}\n\nOpen OptionBrains in your browser and sign in with the same email.`
      : `${opts.body}\n\n${opts.displayText}: ${opts.url}`
    return sendMetaText({
      number: opts.number,
      text,
    })
  }
  return sent
}

async function sendMetaPayload(
  number: string,
  message: Record<string, unknown>,
): Promise<EvolutionResult> {
  if (!config.whatsappToken || !config.whatsappPhoneNumberId) {
    return {
      ok: false,
      status: 500,
      message: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required for Cloud sends',
    }
  }

  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: number.replace(/\D/g, ''),
    ...message,
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[]
      error?: { message?: string; error_user_msg?: string }
    }
    if (!res.ok || data.error) {
      return {
        ok: false,
        status: res.status || 502,
        message: data.error?.error_user_msg || data.error?.message || `Meta Graph HTTP ${res.status}`,
        data,
      }
    }
    const messageId = data.messages?.[0]?.id ?? null
    const text = message.type === 'text' ? (message.text as { body?: string } | undefined)?.body : null
    const interactive = message.interactive as { body?: { text?: string } } | undefined
    void notifyOutbound({
      phone: number,
      messageId,
      kind: 'text',
      preview: text || interactive?.body?.text || 'WhatsApp message',
    })
    return {
      ok: true,
      status: res.status,
      data: { key: { id: messageId }, messages: data.messages },
    }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message : 'Meta Graph request failed',
    }
  }
}

export async function markMetaMessageRead(messageId: string): Promise<EvolutionResult> {
  if (!config.whatsappToken || !config.whatsappPhoneNumberId) {
    return { ok: false, status: 500, message: 'Meta Cloud credentials are not configured' }
  }

  const url = `https://graph.facebook.com/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, status: res.status, message: `Meta Graph HTTP ${res.status}`, data }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message : 'Meta Graph request failed',
    }
  }
}

export function preferMetaCloud(): boolean {
  return Boolean(config.whatsappToken && config.whatsappPhoneNumberId)
}

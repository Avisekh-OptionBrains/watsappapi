import type { Env } from '../env'

export type TemplateComponent = Record<string, unknown>

export type SendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; status: number; message: string; details?: unknown }

export type ListRow = { id: string; title: string; description?: string }
export type ReplyButton = { id: string; title: string }

function graphBase(env: Env): string {
  return `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`
}

function messagesUrl(env: Env): string {
  return `${graphBase(env)}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`
}

function graphError(status: number, data: unknown): SendResult & { ok: false } {
  const error = (data as { error?: { message?: string; error_user_msg?: string } } | null)?.error
  return {
    ok: false,
    status: status || 502,
    message: error?.error_user_msg || error?.message || `Meta Graph HTTP ${status}`,
    details: error,
  }
}

export function metaConfigured(env: Env): boolean {
  return Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID)
}

async function graphPost(env: Env, body: Record<string, unknown>): Promise<SendResult> {
  if (!metaConfigured(env)) {
    return { ok: false, status: 500, message: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not set' }
  }
  try {
    const res = await fetch(messagesUrl(env), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>
      error?: { message?: string; error_user_msg?: string; code?: number }
    }
    if (!res.ok || data.error) {
      return {
        ok: false,
        status: res.status || 502,
        message: data.error?.error_user_msg || data.error?.message || `Meta Graph HTTP ${res.status}`,
        details: data.error,
      }
    }
    return { ok: true, messageId: data.messages?.[0]?.id ?? null }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message : 'Meta Graph request failed',
    }
  }
}

function toMessage(to: string, message: Record<string, unknown>) {
  return { recipient_type: 'individual', to: to.replace(/\D/g, ''), ...message }
}

export function sendTemplate(
  env: Env,
  to: string,
  template: { name: string; language: string; components?: TemplateComponent[] },
): Promise<SendResult> {
  return graphPost(
    env,
    toMessage(to, {
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components: template.components ?? [],
      },
    }),
  )
}

export function sendText(env: Env, to: string, text: string): Promise<SendResult> {
  return graphPost(env, toMessage(to, { type: 'text', text: { preview_url: false, body: text.slice(0, 4096) } }))
}

/** List message (max 10 rows). Falls back to numbered text when interactive is rejected. */
export async function sendList(
  env: Env,
  to: string,
  opts: { body: string; button: string; sectionTitle: string; rows: ListRow[]; footer?: string },
): Promise<SendResult> {
  const rows = opts.rows.slice(0, 10).map((row) => ({
    id: row.id.slice(0, 200),
    title: row.title.slice(0, 24),
    ...(row.description ? { description: row.description.slice(0, 72) } : {}),
  }))
  if (!rows.length) return sendText(env, to, opts.body)

  const sent = await graphPost(
    env,
    toMessage(to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: opts.body.slice(0, 1024) },
        ...(opts.footer ? { footer: { text: opts.footer.slice(0, 60) } } : {}),
        action: {
          button: opts.button.slice(0, 20),
          sections: [{ title: opts.sectionTitle.slice(0, 24), rows }],
        },
      },
    }),
  )
  if (sent.ok) return sent
  const fallback = [
    opts.body,
    '',
    'Reply with the number of your choice:',
    ...rows.map((row, i) => `${i + 1}. ${row.title}${row.description ? ` - ${row.description}` : ''}`),
  ].join('\n')
  return sendText(env, to, fallback)
}

/** Up to 3 reply buttons. Falls back to numbered text. */
export async function sendButtons(
  env: Env,
  to: string,
  opts: { body: string; buttons: ReplyButton[] },
): Promise<SendResult> {
  const buttons = opts.buttons.slice(0, 3).map((b) => ({
    type: 'reply',
    reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
  }))
  if (!buttons.length) return sendText(env, to, opts.body)

  const sent = await graphPost(
    env,
    toMessage(to, {
      type: 'interactive',
      interactive: { type: 'button', body: { text: opts.body.slice(0, 1024) }, action: { buttons } },
    }),
  )
  if (sent.ok) return sent
  const fallback = [opts.body, '', ...buttons.map((b, i) => `${i + 1}. ${b.reply.title}`)].join('\n')
  return sendText(env, to, fallback)
}

/** Single website button. Sign-in links are never pasted as plain text. */
export async function sendCtaUrl(
  env: Env,
  to: string,
  opts: { body: string; label: string; url: string; sensitive?: boolean },
): Promise<SendResult> {
  const sent = await graphPost(
    env,
    toMessage(to, {
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: opts.body.slice(0, 1024) },
        action: { name: 'cta_url', parameters: { display_text: opts.label.slice(0, 20), url: opts.url } },
      },
    }),
  )
  if (sent.ok) return sent
  const text = opts.sensitive
    ? `${opts.body}\n\nOpen the website in your browser and sign in with the same email.`
    : `${opts.body}\n\n${opts.label}: ${opts.url}`
  return sendText(env, to, text)
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

/** WhatsApp message type for an uploaded file (anything unusual goes as a document). */
export function mediaKindFor(mime: string): MediaKind {
  if (/^image\/(jpeg|png)$/.test(mime)) return 'image'
  if (mime === 'image/webp') return 'sticker'
  if (/^video\/(mp4|3gpp)$/.test(mime)) return 'video'
  if (/^audio\/(aac|amr|mpeg|mp4|ogg)$/.test(mime)) return 'audio'
  return 'document'
}

export async function uploadMedia(
  env: Env,
  file: Blob,
  filename: string,
): Promise<{ ok: true; id: string } | (SendResult & { ok: false })> {
  if (!metaConfigured(env)) {
    return { ok: false, status: 500, message: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not set' }
  }
  const form = new FormData()
  form.set('messaging_product', 'whatsapp')
  form.set('type', file.type || 'application/octet-stream')
  form.set('file', file, filename)
  try {
    const res = await fetch(`${graphBase(env)}/${env.WHATSAPP_PHONE_NUMBER_ID}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
      body: form,
    })
    const data = (await res.json().catch(() => ({}))) as { id?: string }
    if (!res.ok || !data.id) return graphError(res.status, data)
    return { ok: true, id: data.id }
  } catch (err) {
    return { ok: false, status: 502, message: err instanceof Error ? err.message : 'Media upload failed' }
  }
}

export function sendMedia(
  env: Env,
  to: string,
  opts: { kind: MediaKind; mediaId: string; caption?: string; filename?: string },
): Promise<SendResult> {
  const media: Record<string, unknown> = { id: opts.mediaId }
  if (opts.caption && opts.kind !== 'audio' && opts.kind !== 'sticker') media.caption = opts.caption.slice(0, 1024)
  if (opts.kind === 'document' && opts.filename) media.filename = opts.filename.slice(0, 240)
  return graphPost(env, toMessage(to, { type: opts.kind, [opts.kind]: media }))
}

/** Downloads a media file Meta holds for us (customer uploads and our own uploads, ~30 days). */
export async function fetchMedia(env: Env, mediaId: string): Promise<Response | null> {
  if (!metaConfigured(env)) return null
  const auth = { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` }
  const meta = await fetch(`${graphBase(env)}/${encodeURIComponent(mediaId)}`, { headers: auth })
  if (!meta.ok) return null
  const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string }
  if (!info.url) return null
  const file = await fetch(info.url, { headers: auth })
  if (!file.ok || !file.body) return null
  return new Response(file.body, {
    headers: { 'Content-Type': info.mime_type || file.headers.get('content-type') || 'application/octet-stream' },
  })
}

export type GraphTemplate = {
  name: string
  language: string
  category: string
  status: string
  parameter_format?: string
  components?: Array<{
    type: string
    format?: string
    text?: string
    buttons?: Array<{ type: string; text?: string; url?: string; example?: unknown }>
  }>
}

/** Approved message templates of the WhatsApp Business Account. */
export async function listTemplates(
  env: Env,
): Promise<{ ok: true; templates: GraphTemplate[] } | (SendResult & { ok: false })> {
  if (!metaConfigured(env) || !env.WHATSAPP_WABA_ID) {
    return { ok: false, status: 500, message: 'Set WHATSAPP_WABA_ID to list templates' }
  }
  const templates: GraphTemplate[] = []
  let url: string | null =
    `${graphBase(env)}/${env.WHATSAPP_WABA_ID}/message_templates?` +
    new URLSearchParams({
      fields: 'name,language,category,status,parameter_format,components',
      status: 'APPROVED',
      limit: '200',
    })
  for (let page = 0; url && page < 5; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } })
    const data = (await res.json().catch(() => ({}))) as { data?: GraphTemplate[]; paging?: { next?: string } }
    if (!res.ok || !data.data) return graphError(res.status, data)
    templates.push(...data.data)
    url = data.paging?.next ?? null
  }
  return { ok: true, templates }
}

export async function markRead(env: Env, messageId: string): Promise<void> {
  await graphPost(env, { status: 'read', message_id: messageId })
}

export function otpComponents(code: string, copyButton: boolean): TemplateComponent[] {
  const components: TemplateComponent[] = [{ type: 'body', parameters: [{ type: 'text', text: code }] }]
  if (copyButton) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: code }],
    })
  }
  return components
}

export function deliveryErrorText(errors: unknown): string | null {
  if (!errors) return null
  const first = (Array.isArray(errors) ? errors : [errors])[0]
  if (!first || typeof first !== 'object') return null
  const row = first as { title?: string; message?: string; error_data?: { details?: string } }
  const text = (row.error_data?.details || row.title || row.message || '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 200) : null
}

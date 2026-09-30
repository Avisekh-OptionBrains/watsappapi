import { config } from '../config'

export type TypebotChatMessage = {
  id?: string
  type?: string
  content?: {
    type?: string
    richText?: unknown
    markdown?: string
    url?: string
  }
}

export type TypebotChatResponse = {
  sessionId?: string
  messages?: TypebotChatMessage[]
  input?: {
    id?: string
    type?: string
    items?: Array<{ id?: string; content?: string }>
  }
  resultId?: string
}

function flattenRichText(nodes: unknown): string {
  if (!nodes) return ''
  if (typeof nodes === 'string') return nodes
  if (!Array.isArray(nodes)) {
    if (typeof nodes === 'object' && nodes !== null) {
      const o = nodes as Record<string, unknown>
      if (typeof o.text === 'string') return o.text
      if (o.children) return flattenRichText(o.children)
    }
    return ''
  }
  return nodes
    .map((n) => {
      if (typeof n === 'string') return n
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>
        if (typeof o.text === 'string') return o.text
        if (o.children) return flattenRichText(o.children)
      }
      return ''
    })
    .join('')
}

/** Convert Typebot chat messages into WhatsApp-friendly plain text lines. */
export function stripChoiceNumberPrefix(content: string): string {
  return content.replace(/^\d+[\).:\-]\s*/, '').trim()
}

export function formatChoiceLines(items: Array<{ id?: string; content?: string }>): string {
  return items
    .map((it, i) => {
      const label = stripChoiceNumberPrefix(it.content ?? it.id ?? '')
      return label ? `${i + 1}. ${label}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

export function typebotMessagesToText(res: TypebotChatResponse): string[] {
  const lines: string[] = []
  for (const m of res.messages ?? []) {
    if (m.type === 'text' && m.content) {
      if (m.content.type === 'markdown' && m.content.markdown) {
        lines.push(m.content.markdown)
      } else if (m.content.richText) {
        const rich = m.content.richText
        const t = Array.isArray(rich)
          ? rich.map((node) => flattenRichText(node).trim()).filter(Boolean).join('\n')
          : flattenRichText(rich).trim()
        if (t) lines.push(t)
      }
    } else if (m.type === 'image' && m.content?.url) {
      lines.push(m.content.url)
    }
  }
  if (res.input?.items?.length) {
    const opts = formatChoiceLines(res.input.items)
    if (opts) lines.push(opts)
  }
  return lines.filter(Boolean)
}

export async function startTypebotChat(opts?: {
  message?: string
  variables?: Record<string, string>
}): Promise<TypebotChatResponse> {
  const publicId = config.typebotPublicId
  if (!publicId) throw new Error('TYPEBOT_PUBLIC_ID is not set')

  const url = `${config.typebotApiUrl}/api/v1/typebots/${publicId}/startChat`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: opts?.message,
      prefilledVariables: opts?.variables,
    }),
  })
  const data = (await res.json().catch(() => ({}))) as TypebotChatResponse & {
    message?: string
  }
  if (!res.ok) {
    throw new Error(data.message || `Typebot startChat HTTP ${res.status}`)
  }
  return data
}

export async function continueTypebotChat(
  sessionId: string,
  message: string,
): Promise<TypebotChatResponse> {
  const url = `${config.typebotApiUrl}/api/v1/sessions/${sessionId}/continueChat`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  const data = (await res.json().catch(() => ({}))) as TypebotChatResponse & {
    message?: string
  }
  if (!res.ok) {
    throw new Error(data.message || `Typebot continueChat HTTP ${res.status}`)
  }
  return data
}

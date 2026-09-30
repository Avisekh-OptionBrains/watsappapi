import { config } from '../config'

export type EvolutionResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; data?: unknown }

async function evoFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<EvolutionResult<T>> {
  const url = `${config.evolutionApiUrl}${path}`
  try {
    const res = await fetch(url, {
      method,
      headers: {
        apikey: config.evolutionApiKey,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as T & {
      message?: string | string[]
      error?: string | { message?: string; code?: number; type?: string }
      code?: number
      type?: string
      error_data?: unknown
      response?: { message?: string | string[] }
      key?: { id?: string }
    }
    if (!res.ok) {
      const msg =
        (typeof data?.message === 'string' && data.message) ||
        (Array.isArray(data?.message) && data.message.join(', ')) ||
        (typeof data?.error === 'string' && data.error) ||
        (typeof data?.error === 'object' && data.error?.message) ||
        (typeof data?.response?.message === 'string' && data.response.message) ||
        `Evolution HTTP ${res.status}`
      return { ok: false, status: res.status, message: String(msg), data }
    }

    // Evolution sometimes returns HTTP 200 with Meta OAuth / Graph errors in the body
    const metaFail =
      data?.type === 'OAuthException' ||
      (typeof data?.code === 'number' && data.code >= 100 && !data?.key?.id) ||
      (typeof data?.message === 'string' &&
        /does not exist|OAuthException|#\d{5,}/i.test(data.message) &&
        !data?.key?.id)

    if (metaFail) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'object' && data.error?.message) ||
        'WhatsApp send failed'
      return { ok: false, status: 502, message: msg, data }
    }

    return { ok: true, status: res.status, data }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: err instanceof Error ? err.message : 'Evolution request failed',
    }
  }
}

export type TemplateComponent = {
  type: string
  sub_type?: string
  index?: string | number
  parameters?: Array<{ type: string; text?: string }>
}

export function buildOtpComponents(otp: string, includeButton: boolean): TemplateComponent[] {
  const components: TemplateComponent[] = [
    {
      type: 'body',
      parameters: [{ type: 'text', text: otp }],
    },
  ]
  if (includeButton) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: otp }],
    })
  }
  return components
}

export async function sendTemplate(opts: {
  number: string
  name: string
  language: string
  components?: TemplateComponent[]
}) {
  return evoFetch('POST', `/message/sendTemplate/${config.evolutionInstanceName}`, {
    number: opts.number,
    name: opts.name,
    language: opts.language,
    components: opts.components ?? [],
  })
}

export async function sendText(opts: { number: string; text: string; delay?: number }) {
  return evoFetch('POST', `/message/sendText/${config.evolutionInstanceName}`, {
    number: opts.number,
    text: opts.text,
    delay: opts.delay,
  })
}

export async function createCloudInstance(opts: {
  instanceName: string
  token: string
  phoneNumberId: string
  businessId: string
}) {
  return evoFetch('POST', '/instance/create', {
    instanceName: opts.instanceName,
    token: opts.token,
    number: opts.phoneNumberId,
    businessId: opts.businessId,
    qrcode: false,
    integration: 'WHATSAPP-BUSINESS',
  })
}

export async function fetchInstances() {
  return evoFetch('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(config.evolutionInstanceName)}`)
}

export async function setTypebotSettings(body: Record<string, unknown>) {
  return evoFetch('POST', `/typebot/settings/${config.evolutionInstanceName}`, body)
}

export async function createTypebot(body: Record<string, unknown>) {
  return evoFetch('POST', `/typebot/create/${config.evolutionInstanceName}`, body)
}

export async function startTypebot(body: Record<string, unknown>) {
  return evoFetch('POST', `/typebot/start/${config.evolutionInstanceName}`, body)
}

export async function changeTypebotStatus(body: Record<string, unknown>) {
  return evoFetch('POST', `/typebot/changeStatus/${config.evolutionInstanceName}`, body)
}

export function extractMessageId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const key = d.key as { id?: string } | undefined
  if (key?.id) return key.id
  const messages = d.messages as { id?: string }[] | undefined
  if (messages?.[0]?.id) return messages[0].id
  if (typeof d.messageId === 'string') return d.messageId
  return null
}

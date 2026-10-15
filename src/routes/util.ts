import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ZodType, ZodTypeDef } from 'zod'
import { INVALID_PHONE_MESSAGE, toWhatsAppRecipient } from '../lib/phone'

function badRequest(message: unknown): never {
  throw new HTTPException(400, { res: Response.json({ ok: false, message }, { status: 400 }) })
}

export async function readJson<T>(c: Context, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const body = await c.req.json().catch(() => badRequest('Body must be JSON'))
  const parsed = schema.safeParse(body)
  if (!parsed.success) badRequest(parsed.error.flatten())
  return parsed.data
}

export function recipientOr400(raw: string): string {
  return toWhatsAppRecipient(raw) ?? badRequest(INVALID_PHONE_MESSAGE)
}

/**
 * Meta's HTTP status when it is an error code, else 502. Meta 401/403 mean the gateway's own
 * WhatsApp token is bad, not the caller's key, so they become 502.
 */
export function upstreamStatus(status: number): ContentfulStatusCode {
  if (status === 401 || status === 403) return 502
  return (status >= 400 && status < 600 ? status : 502) as ContentfulStatusCode
}

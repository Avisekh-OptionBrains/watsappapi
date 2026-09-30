import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config'

function requireAppSecret(): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.WA_REQUIRE_APP_SECRET === '1' ||
    process.env.WA_REQUIRE_APP_SECRET === 'true'
  )
}

export function verifyMetaSignature(
  rawBody: string | Buffer | undefined,
  signature: string | undefined,
) {
  if (!config.whatsappAppSecret) {
    // Fail closed when exposed publicly; local-only may omit the secret.
    return !requireAppSecret()
  }
  if (!rawBody || !signature?.startsWith('sha256=')) return false

  const expected = createHmac('sha256', config.whatsappAppSecret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody)
    .digest('hex')
  const provided = signature.slice('sha256='.length)
  if (provided.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}


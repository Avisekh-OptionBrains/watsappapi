const encoder = new TextEncoder()

export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i]
  return diff === 0
}

export async function hmacSha256Hex(secret: string, body: ArrayBuffer | string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const data = typeof body === 'string' ? encoder.encode(body) : body
  const signature = await crypto.subtle.sign('HMAC', key, data)
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Validates Meta's `X-Hub-Signature-256: sha256=<hex>` header. `appSecrets` may list several
 * comma-separated secrets: every Meta app subscribed to the WABA signs with its own secret.
 */
export async function verifyMetaSignature(
  appSecrets: string,
  rawBody: ArrayBuffer,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false
  const given = header.slice('sha256='.length).toLowerCase()
  for (const secret of appSecrets.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (safeEqual(given, await hmacSha256Hex(secret, rawBody))) return true
  }
  return false
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

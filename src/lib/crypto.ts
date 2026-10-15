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

/** Validates Meta's `X-Hub-Signature-256: sha256=<hex>` header. */
export async function verifyMetaSignature(
  appSecret: string,
  rawBody: ArrayBuffer,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false
  const expected = await hmacSha256Hex(appSecret, rawBody)
  return safeEqual(header.slice('sha256='.length).toLowerCase(), expected)
}

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

import { getRedis } from './redis'

export type ConsentSource = 'website' | 'checkout' | 'admin' | 'whatsapp' | 'import'

export type ConsentRecord = {
  phone: string
  optedIn: boolean
  source: ConsentSource
  purpose: string
  updatedAt: string
}

function key(phone: string) {
  return `wa:consent:${phone}`
}

export async function setConsent(record: ConsentRecord): Promise<void> {
  await getRedis().set(key(record.phone), JSON.stringify(record))
}

export async function getConsent(phone: string): Promise<ConsentRecord | null> {
  const raw = await getRedis().get(key(phone))
  if (!raw) return null
  try {
    return JSON.parse(raw) as ConsentRecord
  } catch {
    return null
  }
}

export async function isOptedIn(phone: string): Promise<boolean> {
  return (await getConsent(phone))?.optedIn === true
}


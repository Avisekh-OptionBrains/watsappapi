/** Strip +91 / spaces and return up to 10 national digits. */
export function toDisplayPhoneDigits(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length >= 10) return digits.slice(-10)
  return digits
}

export function isValidIndianMobile(digits: string): boolean {
  return /^[6-9]\d{9}$/.test(digits)
}

/** E.164 for India, e.g. +9198XXXXXXXX */
export function toE164Phone(raw: string): string | null {
  const national = toDisplayPhoneDigits(raw)
  if (!isValidIndianMobile(national)) return null
  return `+91${national}`
}

/** Digits only for Evolution / Cloud API `number` / `to` field. */
export function toWhatsAppRecipient(raw: string): string | null {
  const e164 = toE164Phone(raw)
  if (!e164) return null
  return e164.replace(/^\+/, '')
}

export function toRemoteJid(raw: string): string | null {
  const digits = toWhatsAppRecipient(raw)
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}

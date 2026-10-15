/** Last 10 national digits (strips +91 / spaces). */
export function toNationalDigits(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length >= 10) return digits.slice(-10)
  return digits
}

export function isValidIndianMobile(digits: string): boolean {
  return /^[6-9]\d{9}$/.test(digits)
}

/** Digits-only recipient for the Cloud API `to` field, e.g. 919876543210. */
export function toWhatsAppRecipient(raw: string): string | null {
  const national = toNationalDigits(raw)
  if (!isValidIndianMobile(national)) return null
  return `91${national}`
}

export const INVALID_PHONE_MESSAGE =
  'Enter a valid Indian mobile number (+91, 10 digits starting 6-9)'

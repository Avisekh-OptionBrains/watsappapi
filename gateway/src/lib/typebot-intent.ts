export type TypebotIntent = 'signin' | 'account' | 'support'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const GREETING = /^(hi+|hello+|hey+|menu|start)\b/i

export function isTypebotGreeting(text: string): boolean {
  return GREETING.test(text.trim())
}

export function isTypebotEmail(text: string): boolean {
  return EMAIL.test(text.trim())
}

export function intentFromChoice(text: string): TypebotIntent | null {
  const t = text.trim().toLowerCase()
  if (t.includes('sign')) return 'signin'
  if (t.includes('account') || t.includes('status')) return 'account'
  if (t.includes('support') || t.includes('help')) return 'support'
  return null
}

export function otpDigits(text: string): string | null {
  const compact = text.trim().replace(/\s/g, '')
  return /^\d{6}$/.test(compact) ? compact : null
}

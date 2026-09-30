import { getRedis } from './redis'
import {
  researchNextLink,
  researchSendOtp,
  researchStatus,
  researchVerifyOtp,
  whatsappToNationalPhone,
} from '../clients/research-api'

export type ResearchFlowState =
  | { step: 'await_email' }
  | { step: 'await_otp'; email: string }

const KEY = (phone: string) => `wa:research:${phone}`
const TTL_SEC = 60 * 30

function isEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim())
}

export async function getResearchFlow(phone: string): Promise<ResearchFlowState | null> {
  const raw = await getRedis().get(KEY(phone))
  if (!raw) return null
  try {
    return JSON.parse(raw) as ResearchFlowState
  } catch {
    return null
  }
}

export async function setResearchFlow(phone: string, state: ResearchFlowState): Promise<void> {
  await getRedis().set(KEY(phone), JSON.stringify(state), 'EX', TTL_SEC)
}

export async function clearResearchFlow(phone: string): Promise<void> {
  await getRedis().del(KEY(phone))
}

export function isSignInIntent(label: string): boolean {
  return /sign\s*in|subscribe/i.test(label)
}

export function isStatusIntent(label: string): boolean {
  return /status/i.test(label) && !/subscribe/i.test(label)
}

export function isSupportIntent(label: string): boolean {
  return /talk to support|support/i.test(label) && !/sign/i.test(label)
}

export async function beginSignInFlow(phone: string): Promise<string[]> {
  await setResearchFlow(phone, { step: 'await_email' })
  return [
    'Reply with your email address.',
    'We will send a one-time login code to that email (same login as the OptionBrains website).',
  ]
}

export async function handleResearchFlowMessage(
  phone: string,
  text: string,
  state: ResearchFlowState,
): Promise<string[]> {
  const national = whatsappToNationalPhone(phone)
  const trimmed = text.trim()

  if (state.step === 'await_email') {
    if (!isEmail(trimmed)) {
      return ['Please reply with a valid email address (example: you@example.com).']
    }
    const email = trimmed.toLowerCase()
    const sent = await researchSendOtp({ email, phone: national })
    if (!sent.ok) {
      return [
        `Could not send login code: ${sent.message}`,
        'Check the email and try again, or send hi for the menu.',
      ]
    }
    await setResearchFlow(phone, { step: 'await_otp', email })
    return [
      `Code sent to ${email}.`,
      'Reply with the 6-digit code from that email.',
    ]
  }

  if (state.step === 'await_otp') {
    const otp = trimmed.replace(/\D/g, '')
    if (otp.length < 6) {
      return ['Reply with the 6-digit code from your email.']
    }
    const verified = await researchVerifyOtp({
      email: state.email,
      phone: national,
      otp,
      intent: 'buy',
    })
    await clearResearchFlow(phone)
    if (!verified.ok) {
      await setResearchFlow(phone, { step: 'await_otp', email: state.email })
      return [
        `Login failed: ${verified.message}`,
        'Reply with the code again, or send hi to restart.',
      ]
    }

    const st = verified.data.status
    const cta = verified.data.ctaUrl
    const lines = [
      'You are signed in.',
      st?.kycReady
        ? 'Verification is ready - tap Continue on the website when prompted.'
        : `KYC: ${st?.kycStatus ?? 'needed'}. ${st?.kycMessage ?? 'Complete verification on the website, then subscribe.'}`,
      cta ? `Continue: ${cta}` : 'Open OptionBrains in your browser and sign in with the same email.',
      'Send hi for the menu.',
    ]
    return lines
  }

  return ['Send hi for the menu.']
}

export async function replyResearchStatus(phone: string): Promise<string[]> {
  const national = whatsappToNationalPhone(phone)
  const res = await researchStatus({ phone: national })
  if (!res.ok) {
    return [`Could not load status: ${res.message}`, 'Send hi for the menu.']
  }

  const st = res.data.status
  if (!st.found) {
    return [
      'No OptionBrains account found for this WhatsApp number yet.',
      'Reply 1 to Sign in / Subscribe (email OTP), then complete KYC or buy in the browser.',
    ]
  }

  const lines = [
    `Account: ${st.email ?? '-'}`,
    `KYC: ${st.kycStatus ?? '-'}${st.kycReady ? ' (ready to buy)' : ''}`,
  ]
  if (st.kycMessage && !st.kycReady) lines.push(st.kycMessage)

  const subs = st.subscriptions ?? []
  if (subs.length === 0) {
    lines.push('Subscriptions: none active')
  } else {
    lines.push('Active:')
    for (const s of subs.slice(0, 5)) {
      const name = s.planName || s.productName || s.productType
      lines.push(`- ${name}${s.expiresAt ? ` (until ${s.expiresAt.slice(0, 10)})` : ''}`)
    }
  }

  const intent = st.kycReady ? 'buy' : 'kyc'
  const link = await researchNextLink({ intent: intent === 'buy' ? 'buy' : 'kyc' })
  // Prefer verify handoff for session; for status-only give next-link path note
  if (link.ok) {
    lines.push(
      st.kycReady
        ? `To buy, reply 1 to sign in and get a secure handoff link (not a public pricing page).`
        : `To finish KYC, reply 1 to sign in and open your secure handoff link.`,
    )
  }
  lines.push('Send hi for the menu.')
  return lines
}

export function supportReplyLines(): string[] {
  return [
    'Our team can help at support@optionbrains.com.',
    'Reply here with your issue and we will follow up.',
    'Refunds are manual in Razorpay Dashboard only.',
    'Send hi for the menu.',
  ]
}

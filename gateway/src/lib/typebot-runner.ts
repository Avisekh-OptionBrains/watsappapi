import {
  continueTypebotChat,
  startTypebotChat,
  typebotMessagesToText,
  type TypebotChatResponse,
} from '../clients/typebot'
import {
  researchSendOtp,
  researchStatus,
  researchVerifyOtp,
  whatsappToNationalPhone,
} from '../clients/research-api'
import { sendMetaText } from '../clients/meta-cloud'
import { mapChoiceReply } from './choice-map'
import { getRedis } from './redis'
import {
  intentFromChoice,
  isTypebotEmail,
  isTypebotGreeting,
  otpDigits,
  type TypebotIntent,
} from './typebot-intent'

const SESSION_TTL_SEC = 45 * 60

function sessionKey(phone: string) {
  return `wa:tb:session:${phone}`
}
function choicesKey(phone: string) {
  return `wa:tb:choices:${phone}`
}
function intentKey(phone: string) {
  return `wa:tb:intent:${phone}`
}
function emailKey(phone: string) {
  return `wa:tb:email:${phone}`
}

async function say(phone: string, lines: string[]) {
  const text = lines.map((line) => line.trim()).filter(Boolean).join('\n\n')
  if (!text) return
  await sendMetaText({ number: phone, text })
}

async function storedChoices(phone: string): Promise<Array<{ id?: string; content?: string }>> {
  const raw = await getRedis().get(choicesKey(phone))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Array<{ id?: string; content?: string }>
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function accountLines(status: {
  name?: string | null
  kycLabel?: string | null
  kycMessage?: string | null
  kycReady?: boolean
  subscriptions?: Array<{ planName?: string | null; productName?: string | null; productType: string }>
}): string[] {
  const plans = (status.subscriptions ?? [])
    .map((sub) => sub.planName || sub.productName || sub.productType)
    .filter((name): name is string => Boolean(name))
  return [
    status.name ? `Hello ${status.name}.` : 'Here is your account.',
    status.kycLabel ||
      status.kycMessage ||
      (status.kycReady ? 'Verification is complete.' : 'Verification is not finished.'),
    plans.length ? `Plans: ${plans.join(', ')}` : 'No active plan on this account.',
    'Reply Menu to start again.',
  ]
}

export async function handlePublishedTypebot(phone: string, text: string): Promise<void> {
  const redis = getRedis()
  const trimmed = text.trim()
  const greeting = isTypebotGreeting(trimmed)

  if (greeting) {
    await redis.del(intentKey(phone), emailKey(phone), sessionKey(phone), choicesKey(phone))
  }

  const intent = greeting ? null : ((await redis.get(intentKey(phone))) as TypebotIntent | null)
  const savedEmail = greeting ? null : await redis.get(emailKey(phone))
  const code = otpDigits(trimmed)

  if (intent === 'signin' && savedEmail && code) {
    const verified = await researchVerifyOtp({
      email: savedEmail,
      phone: whatsappToNationalPhone(phone),
      otp: code,
      next: '/dashboard',
    })
    if (!verified.ok) {
      await say(phone, [
        'That code did not work. Check the email and reply with the 6-digit code, or reply Menu.',
      ])
      return
    }
    await redis.del(emailKey(phone), intentKey(phone))
    const link = verified.data.ux?.ctaUrl || verified.data.ctaUrl
    await say(phone, [
      verified.data.ux?.body || 'You are signed in.',
      link ? `Open this link to continue: ${link}` : 'Open the OptionBrains website to continue.',
      'Reply Menu to start again.',
    ])
    return
  }

  if ((intent === 'signin' || intent === 'account') && isTypebotEmail(trimmed)) {
    const email = trimmed.toLowerCase()
    const national = whatsappToNationalPhone(phone)
    if (intent === 'account') {
      const status = await researchStatus({ email, phone: national })
      await redis.del(intentKey(phone))
      if (!status.ok || !status.data.status.found) {
        await say(phone, [
          'We could not find an account for that email. Reply Sign in, or Menu to start again.',
        ])
        return
      }
      await say(phone, accountLines(status.data.status))
      return
    }

    const sent = await researchSendOtp({ email, phone: national })
    if (!sent.ok) {
      await say(phone, ['We could not send the code. Check the email and try again, or reply Menu.'])
      return
    }
    await redis.set(emailKey(phone), email, 'EX', SESSION_TTL_SEC)
    const extra = sent.data.isNewUser
      ? ' If you are new, this also creates your OptionBrains login.'
      : ''
    await say(phone, [`We emailed a 6-digit code to ${email}.${extra}`, 'Reply with that code.'])
    return
  }

  if (intent === 'support' && trimmed && !greeting) {
    await redis.del(intentKey(phone))
    await say(phone, [
      'Thanks. The team can see your message. You can also email support@optionbrains.com.',
      'Reply Menu to start again.',
    ])
    return
  }

  let chat: TypebotChatResponse
  try {
    const existing = greeting ? null : await redis.get(sessionKey(phone))
    if (!existing) {
      chat = await startTypebotChat()
      const session = chat.sessionId
      if (session) await redis.set(sessionKey(phone), session, 'EX', SESSION_TTL_SEC)
      const items = chat.input?.items ?? []
      await redis.set(choicesKey(phone), JSON.stringify(items), 'EX', SESSION_TTL_SEC)
      if (!greeting && session && trimmed) {
        const reply = mapChoiceReply(trimmed, items)
        const nextIntent = intentFromChoice(reply)
        if (nextIntent) await redis.set(intentKey(phone), nextIntent, 'EX', SESSION_TTL_SEC)
        const next = await continueTypebotChat(session, reply)
        chat = {
          ...next,
          messages: [...(chat.messages ?? []), ...(next.messages ?? [])],
          input: next.input ?? chat.input,
        }
        await redis.set(
          choicesKey(phone),
          JSON.stringify(next.input?.items ?? []),
          'EX',
          SESSION_TTL_SEC,
        )
      }
    } else {
      const items = await storedChoices(phone)
      const reply = mapChoiceReply(trimmed, items)
      const nextIntent = intentFromChoice(reply)
      if (nextIntent) await redis.set(intentKey(phone), nextIntent, 'EX', SESSION_TTL_SEC)
      chat = await continueTypebotChat(existing, reply)
      await redis.set(
        choicesKey(phone),
        JSON.stringify(chat.input?.items ?? []),
        'EX',
        SESSION_TTL_SEC,
      )
      if (chat.sessionId) {
        await redis.set(sessionKey(phone), chat.sessionId, 'EX', SESSION_TTL_SEC)
      }
    }
  } catch (err) {
    console.error('[typebot-runner]', phone, err)
    await redis.del(sessionKey(phone), choicesKey(phone))
    await say(phone, [
      'Chat is temporarily unavailable. Please try again in a moment or email support@optionbrains.com',
    ])
    return
  }

  const lines = typebotMessagesToText(chat)
  await say(phone, lines.length ? lines : ['Reply Menu to see the options again.'])
}

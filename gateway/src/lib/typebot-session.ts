import { getRedis } from './redis'
import { startTypebotChat } from '../clients/typebot'
import { sendMetaText } from '../clients/meta-cloud'
import { typebotMessagesToText } from '../clients/typebot'

function sessionKey(phone: string) {
  return `tb:session:${phone}`
}

/** Legacy Typebot session helpers (ops /v1/typebot/start may still use). */
export async function startConversationForPhone(
  phone: string,
  variables?: Record<string, string>,
) {
  const chat = await startTypebotChat({
    variables: { Phone: phone, ...(variables ?? {}) },
  })
  if (chat.sessionId) {
    await getRedis().set(
      sessionKey(phone),
      JSON.stringify({ sessionId: chat.sessionId, choices: chat.input?.items ?? [] }),
      'EX',
      60 * 60 * 6,
    )
  }
  for (const line of typebotMessagesToText(chat)) {
    await sendMetaText({ number: phone, text: line })
  }
  return chat
}

export async function closeConversationForPhone(phone: string) {
  await getRedis().del(sessionKey(phone))
}

import { Hono } from 'hono'
import { z } from 'zod'
import { requireSite } from '../auth'
import type { AppEnv } from '../env'
import { isOptedIn } from '../lib/consent'
import { otpComponents, sendTemplate, sendText } from '../lib/meta'
import { recordOutbound } from '../lib/outbound'
import { readJson, recipientOr400, upstreamStatus } from './util'

const otpSchema = z.object({
  phone: z.string().min(8),
  otp: z.string().min(4).max(16),
  templateName: z.string().optional(),
  templateLang: z.string().optional(),
  includeButton: z.boolean().optional(),
})

const templateSchema = z.object({
  phone: z.string().min(8),
  name: z.string().min(1),
  language: z.string().min(2).default('en_US'),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).default('UTILITY'),
  components: z.array(z.record(z.unknown())).optional(),
})

const textSchema = z.object({
  phone: z.string().min(8),
  text: z.string().min(1).max(4096),
})

export const messages = new Hono<AppEnv>()

messages.post('/otp/send', requireSite, async (c) => {
  const site = c.get('site')
  const body = await readJson(c, otpSchema)
  const code = body.otp.replace(/\D/g, '')
  if (code.length < 4 || code.length > 8) {
    return c.json({ ok: false, message: 'OTP must be 4-8 digits' }, 400)
  }
  const to = recipientOr400(body.phone)
  const name = body.templateName || site.otp.template
  let language = body.templateLang || site.otp.language
  const components = otpComponents(code, body.includeButton ?? site.otp.copyButton)

  let sent = await sendTemplate(c.env, to, { name, language, components })
  if (!sent.ok && language === 'en') {
    language = 'en_US'
    sent = await sendTemplate(c.env, to, { name, language, components })
  }
  const template = { name, language, category: 'AUTHENTICATION' }
  if (!sent.ok) {
    return c.json({ ok: false, message: sent.message, template, via: 'meta_cloud_template' }, upstreamStatus(sent.status))
  }
  await recordOutbound(c.env, site, { messageId: sent.messageId, phone: to, kind: 'otp', text: 'Login code', author: 'system' })
  return c.json({ ok: true, messageId: sent.messageId, template, via: 'meta_cloud_template' })
})

messages.post('/messages/template', requireSite, async (c) => {
  const site = c.get('site')
  const body = await readJson(c, templateSchema)
  const to = recipientOr400(body.phone)
  if (body.category === 'MARKETING' && !(await isOptedIn(c.env, site.id, to))) {
    return c.json({ ok: false, message: 'Recipient has no active WhatsApp marketing consent' }, 403)
  }
  const sent = await sendTemplate(c.env, to, {
    name: body.name,
    language: body.language,
    components: body.components,
  })
  if (!sent.ok) {
    return c.json(
      { ok: false, message: sent.message, provider: 'meta_cloud', details: sent.details },
      upstreamStatus(sent.status),
    )
  }
  await recordOutbound(c.env, site, {
    messageId: sent.messageId,
    phone: to,
    kind: 'template',
    text: `Template: ${body.name}`,
    author: 'system',
  })
  return c.json({ ok: true, provider: 'meta_cloud', category: body.category, messageId: sent.messageId })
})

/** Free-form text only reaches customers inside Meta's 24-hour customer service window. */
messages.post('/messages/text', requireSite, async (c) => {
  const site = c.get('site')
  const body = await readJson(c, textSchema)
  const to = recipientOr400(body.phone)
  const sent = await sendText(c.env, to, body.text)
  if (!sent.ok) {
    return c.json(
      { ok: false, message: sent.message, provider: 'meta_cloud', details: sent.details },
      upstreamStatus(sent.status),
    )
  }
  await recordOutbound(c.env, site, { messageId: sent.messageId, phone: to, kind: 'text', text: body.text, author: 'system' })
  return c.json({ ok: true, provider: 'meta_cloud', messageId: sent.messageId })
})

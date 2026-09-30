import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireServiceKey } from '../auth'
import { config } from '../config'
import { buildOtpComponents, extractMessageId, sendTemplate } from '../clients/evolution'
import { preferMetaCloud, sendMetaTemplate } from '../clients/meta-cloud'
import { toWhatsAppRecipient } from '../lib/phone'

const bodySchema = z.object({
  phone: z.string().min(8),
  otp: z.string().min(4).max(16),
  templateName: z.string().optional(),
  templateLang: z.string().optional(),
  includeButton: z.boolean().optional(),
})

export async function otpRoutes(app: FastifyInstance) {
  app.post('/v1/otp/send', { preHandler: requireServiceKey }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, message: parsed.error.flatten() })
    }

    const code = parsed.data.otp.replace(/\D/g, '')
    if (code.length < 4 || code.length > 8) {
      return reply.code(400).send({ ok: false, message: 'OTP must be 4–8 digits' })
    }

    const to = toWhatsAppRecipient(parsed.data.phone)
    if (!to) {
      return reply.code(400).send({
        ok: false,
        message: 'Enter a valid Indian mobile number (+91, 10 digits starting 6–9)',
      })
    }

    // Always use approved AUTHENTICATION template (default: otp_code)
    const name = parsed.data.templateName || config.otpTemplateName
    let language = parsed.data.templateLang || config.otpTemplateLang
    const includeButton = parsed.data.includeButton ?? config.includeOtpButton
    const components = buildOtpComponents(code, includeButton)

    const send = preferMetaCloud() ? sendMetaTemplate : sendTemplate
    const via = preferMetaCloud() ? 'meta_cloud_template' : 'evolution_template'

    let result = await send({ number: to, name, language, components })

    if (!result.ok && language === 'en') {
      language = 'en_US'
      result = await send({ number: to, name, language, components })
    }

    if (!result.ok) {
      return reply.code(result.status >= 400 && result.status < 600 ? result.status : 502).send({
        ok: false,
        message: result.message,
        template: { name, language, category: 'AUTHENTICATION' },
        via,
        evolution: result.data,
      })
    }

    return {
      ok: true,
      messageId: extractMessageId(result.data),
      template: { name, language, category: 'AUTHENTICATION' },
      via,
      data: result.data,
    }
  })
}

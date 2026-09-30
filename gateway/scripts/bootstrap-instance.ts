/**
 * Bootstrap Evolution Cloud instance + Typebot defaults.
 * Run after `docker compose up` with Meta credentials in ../.env
 *
 *   cd gateway && npm run bootstrap
 */
import path from 'node:path'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: path.resolve(__dirname, '../../.env') })
loadEnv()

/** Bootstrap runs on the host — never use Docker-only hostnames like evolution-api. */
function resolveEvolutionUrl(): string {
  const raw = (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/$/, '')
  try {
    const u = new URL(raw)
    if (u.hostname === 'evolution-api' || u.hostname === 'gateway') {
      return 'http://localhost:8080'
    }
  } catch {
    return 'http://localhost:8080'
  }
  return raw
}

const evoUrl = resolveEvolutionUrl()
const apiKey = process.env.AUTHENTICATION_API_KEY || process.env.EVOLUTION_API_KEY || ''
const instanceName = process.env.EVOLUTION_INSTANCE_NAME || 'optionbrains'
const token = process.env.WHATSAPP_TOKEN || ''
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
const businessId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || ''
const typebotUrl = (process.env.NEXT_PUBLIC_VIEWER_URL || 'http://localhost:3002').replace(/\/$/, '')
const typebotId = process.env.TYPEBOT_STARTER_ID || ''
const webhookUrl =
  process.env.WEBHOOK_GLOBAL_URL || 'http://gateway:3100/webhooks/evolution'

async function evo(method: string, p: string, body?: unknown) {
  const res = await fetch(`${evoUrl}${p}`, {
    method,
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

async function main() {
  if (!apiKey) throw new Error('AUTHENTICATION_API_KEY (or EVOLUTION_API_KEY) is required')
  if (!token || !phoneNumberId || !businessId) {
    throw new Error('WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID are required')
  }

  // Evolution validates `number` as digits (Meta Phone Number ID), not a label
  const numberId = phoneNumberId.replace(/\D/g, '')
  if (!/^\d{5,}$/.test(numberId)) {
    console.error(
      `WHATSAPP_PHONE_NUMBER_ID must be numeric (got "${phoneNumberId}"). Copy Phone number ID from Meta → WhatsApp → API Setup.`,
    )
    process.exit(1)
  }
  if (/EAAB\.\.\./i.test(token) || /your-/i.test(token)) {
    console.error('WHATSAPP_TOKEN still looks like a placeholder. Set the real permanent Meta token in .env.')
    process.exit(1)
  }

  console.log(`Creating Cloud instance "${instanceName}" at ${evoUrl}…`)
  const created = await evo('POST', '/instance/create', {
    instanceName,
    token,
    number: numberId,
    businessId: businessId.replace(/\D/g, '') || businessId,
    qrcode: false,
    integration: 'WHATSAPP-BUSINESS',
  })

  if (!created.ok) {
    const msg = JSON.stringify(created.data, null, 2)
    if (msg.toLowerCase().includes('already') || created.status === 403 || created.status === 409) {
      console.log('Instance may already exist — continuing.', created.status, msg)
    } else {
      console.error('Create failed', created.status, msg)
      console.error(
        'Hint: set real WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_BUSINESS_ACCOUNT_ID in d:\\watsappapi\\.env (not placeholders), then re-run.',
      )
      process.exit(1)
    }
  } else {
    console.log('Instance created:', JSON.stringify(created.data, null, 2))
  }

  console.log('Setting Typebot defaults…')
  const settings = await evo('POST', `/typebot/settings/${instanceName}`, {
    expire: 300,
    keywordFinish: '#EXIT',
    delayMessage: 1000,
    unknownMessage: 'Sorry, I did not understand. Type #EXIT to leave.',
    listeningFromMe: false,
    stopBotFromMe: true,
    keepOpen: false,
    debounceTime: 10,
    typebotIdFallback: typebotId || undefined,
  })
  console.log('Typebot settings:', settings.status, JSON.stringify(settings.data))

  if (typebotId) {
    console.log(`Registering starter Typebot ${typebotId}…`)
    const bot = await evo('POST', `/typebot/create/${instanceName}`, {
      enabled: true,
      url: typebotUrl,
      typebot: typebotId,
      description: 'OptionBrains starter bot',
      triggerType: 'keyword',
      triggerOperator: 'equals',
      triggerValue: 'hello',
      expire: 300,
      keywordFinish: '#EXIT',
      delayMessage: 1000,
      unknownMessage: 'Sorry, I did not understand.',
      listeningFromMe: false,
      stopBotFromMe: true,
      keepOpen: false,
      debounceTime: 10,
    })
    console.log('Typebot create:', bot.status, JSON.stringify(bot.data))
  } else {
    console.log(
      'Skip Typebot registration (set TYPEBOT_STARTER_ID after publishing a flow in the builder).',
    )
  }

  // Instance-level webhook as a belt-and-suspenders with global webhook
  console.log('Ensuring instance webhook…')
  const wh = await evo('POST', `/webhook/set/${instanceName}`, {
    webhook: {
      enabled: true,
      url: webhookUrl,
      byEvents: false,
      base64: false,
      events: [
        'MESSAGES_UPSERT',
        'MESSAGES_UPDATE',
        'SEND_MESSAGE',
        'CONNECTION_UPDATE',
        'TYPEBOT_START',
        'TYPEBOT_CHANGE_STATUS',
      ],
    },
  })
  console.log('Webhook set:', wh.status, JSON.stringify(wh.data))

  console.log('Bootstrap complete.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

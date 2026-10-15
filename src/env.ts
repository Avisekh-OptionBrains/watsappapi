import type { Site } from './sites'

export type CampaignJob = {
  campaignId: string
  siteId: string
  phone: string
}

export type Env = {
  DB: D1Database
  CAMPAIGN_QUEUE: Queue<CampaignJob>

  ENVIRONMENT?: string
  DEFAULT_SITE?: string
  /** JSON array of site definitions — see README "Sites". */
  SITES: string
  ADMIN_API_KEY?: string
  /** Dashboard logins: JSON `[{ "name": "Ravi", "key": "<min 24 chars>", "role": "agent" }]`. */
  STAFF?: string
  /** Dashboard origin used in alert links, e.g. https://wa.optionbrains.com */
  DASHBOARD_URL?: string

  WHATSAPP_TOKEN: string
  WHATSAPP_PHONE_NUMBER_ID: string
  /** WhatsApp Business Account id; needed to list approved templates. */
  WHATSAPP_WABA_ID?: string
  WHATSAPP_APP_SECRET?: string
  WHATSAPP_VERIFY_TOKEN: string
  WHATSAPP_GRAPH_VERSION?: string

  BOT_ENABLED?: string
  CAMPAIGN_SEND_DELAY_MS?: string
  CAMPAIGN_MAX_RECIPIENTS?: string

  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  /** "0" turns off AI answers for every site. */
  AI_ENABLED?: string
  /** Max AI answers per customer per hour (cost guard). */
  AI_MAX_PER_HOUR?: string

  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
  /** Slack / Discord / Google Chat incoming webhook. */
  ALERT_WEBHOOK_URL?: string
  RESEND_API_KEY?: string
  ALERT_EMAIL_FROM?: string
  /** Comma-separated recipients. */
  ALERT_EMAIL_TO?: string
  /** Alert again when a customer has waited this many minutes without a reply (default 10, 0 = off). */
  ALERT_ESCALATE_MINUTES?: string
}

export type StaffRole = 'admin' | 'agent'

export type AppEnv = {
  Bindings: Env
  Variables: { site: Site; staff: string; role: StaffRole }
}

export function isDevelopment(env: Env): boolean {
  return env.ENVIRONMENT === 'development'
}

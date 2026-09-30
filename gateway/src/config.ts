import path from 'node:path'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: path.resolve(__dirname, '../../.env') })
loadEnv()

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() ?? fallback
}

function required(name: string): string {
  const v = env(name)
  if (!v) throw new Error(`Missing required env: ${name}`)
  return v
}

export const config = {
  port: Number(env('PORT') || env('GATEWAY_PORT', '3100')),
  serviceApiKey: required('SERVICE_API_KEY'),
  webhookSharedSecret: env('WEBHOOK_SHARED_SECRET'),
  evolutionApiUrl: env('EVOLUTION_API_URL', 'http://localhost:8080').replace(/\/$/, ''),
  evolutionApiKey: env('EVOLUTION_API_KEY') || env('AUTHENTICATION_API_KEY'),
  evolutionInstanceName: env('EVOLUTION_INSTANCE_NAME', 'optionbrains'),
  redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379/0'),
  otpTemplateName: env('WHATSAPP_TEMPLATE_NAME', 'otp_code'),
  otpTemplateLang: env('WHATSAPP_TEMPLATE_LANG', 'en_US'),
  includeOtpButton: env('WHATSAPP_INCLUDE_OTP_BUTTON', '1') !== '0',
  /** Meta Cloud credentials — OTP/templates go via Graph API (Evolution Cloud template path is unreliable). */
  whatsappToken: env('WHATSAPP_TOKEN'),
  whatsappPhoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
  whatsappGraphVersion: env('WHATSAPP_GRAPH_VERSION', 'v21.0'),
  whatsappAppSecret: env('WHATSAPP_APP_SECRET'),
  /** Meta hub.verify_token — must be set; empty rejects webhook subscription. */
  waBusinessTokenWebhook: env('WA_BUSINESS_TOKEN_WEBHOOK'),
  /** URL Evolution / gateway use to talk to Typebot viewer (Docker service). */
  typebotViewerUrl: (
    env('TYPEBOT_EVOLUTION_URL') ||
    env('TYPEBOT_VIEWER_URL') ||
    'http://typebot-viewer:3000'
  ).replace(/\/$/, ''),
  typebotApiUrl: (
    env('TYPEBOT_API_URL') ||
    env('TYPEBOT_EVOLUTION_URL') ||
    env('TYPEBOT_VIEWER_URL') ||
    'http://typebot-viewer:3000'
  ).replace(/\/$/, ''),
  typebotPublicId: env('TYPEBOT_PUBLIC_ID', 'ob-support'),
  typebotBridgeEnabled: env('TYPEBOT_BRIDGE_ENABLED', '1') !== '0',
  /**
   * Product chatbot menus (plans / sign-in / account).
   * Default OFF so production WhatsApp stays human/OTP-only until you go live.
   * OTP templates (/v1/otp/send) are independent of this flag.
   */
  whatsappProductBotEnabled: env('WHATSAPP_PRODUCT_BOT_ENABLED', '0') === '1',
  evolutionEnabled: env('EVOLUTION_ENABLED', '0') === '1',
  campaignSendDelayMs: Number(env('CAMPAIGN_SEND_DELAY_MS', '1200')),
  campaignRequireOptIn: env('CAMPAIGN_REQUIRE_OPT_IN', '1') !== '0',
  campaignMaxRecipients: Number(env('CAMPAIGN_MAX_RECIPIENTS', '5000')),
  obResearchWebhookUrl: env('OB_RESEARCH_WEBHOOK_URL'),
  obResearchWebhookSecret: env('OB_RESEARCH_WEBHOOK_SECRET'),
  /** Base URL of ob-research (from Docker use http://host.docker.internal:3000). */
  obResearchApiUrl: env('OB_RESEARCH_API_URL', 'http://host.docker.internal:3000'),
  /** Bearer for /api/whatsapp/bot/* — defaults to SERVICE_API_KEY. */
  obResearchBotKey: env('OB_RESEARCH_BOT_KEY') || env('SERVICE_API_KEY'),
}

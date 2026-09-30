import { config } from '../config'

export type ResearchApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; status?: number }

export type ResearchPlanItem = {
  id: string
  name: string
  slug: string
  description: string
  fromPrice: string
  isTopTier: boolean
  highlights: string[]
  buyPath: string
  buyUrl: string
}

export type ResearchPortfolioItem = {
  id: string
  name: string
  slug: string
  tagline: string
  riskProfile?: string | null
  rebalanceFrequency?: string | null
  cagr?: number | null
  totalReturn?: number | null
  includedInElite?: boolean
  monthlyPrice?: number | null
  quarterlyPrice?: number | null
  yearlyPrice?: number | null
  viewPath: string
  viewUrl: string
}

function apiBase(): string {
  return config.obResearchApiUrl.replace(/\/$/, '')
}

function botKey(): string {
  return config.obResearchBotKey || config.serviceApiKey
}

async function botFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<ResearchApiResult<T>> {
  const base = apiBase()
  if (!base) {
    return {
      ok: false,
      message:
        'Research API is not configured. Set OB_RESEARCH_API_URL on the WhatsApp gateway.',
    }
  }

  try {
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${botKey()}`,
        'Content-Type': 'application/json',
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const json = (await res.json().catch(() => ({}))) as T & {
      ok?: boolean
      message?: string
      error?: string
    }
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        message:
          (typeof json.message === 'string' && json.message) ||
          (typeof json.error === 'string' && json.error) ||
          `HTTP ${res.status}`,
        status: res.status,
      }
    }
    return { ok: true, data: json as T }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Research API unreachable',
    }
  }
}

export function whatsappToNationalPhone(waFrom: string): string {
  const digits = waFrom.replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : digits
}

export async function researchSendOtp(opts: { email: string; phone: string }) {
  return botFetch<{
    ok: true
    sent: true
    message: string
    phone: string
    isNewUser?: boolean
  }>('/api/whatsapp/bot/send-otp', { method: 'POST', body: opts })
}

export async function researchVerifyOtp(opts: {
  email: string
  phone: string
  otp: string
  intent?: string
  productSlug?: string
  next?: string
}) {
  return botFetch<{
    ok: true
    ctaUrl?: string
    next: string
    email: string
    phone: string
    ux?: { title: string; body: string; ctaLabel: string; ctaUrl: string }
    status?: {
      kycReady?: boolean
      kycStatus?: string | null
      kycMessage?: string | null
      suggestedIntent?: string
      name?: string | null
      subscriptions?: Array<{
        productType: string
        planName?: string | null
        productName?: string | null
      }>
    }
  }>('/api/whatsapp/bot/verify-otp', { method: 'POST', body: opts })
}

export async function researchStatus(opts: { email?: string; phone?: string }) {
  return botFetch<{
    ok: true
    status: {
      found: boolean
      email?: string | null
      phone?: string | null
      name?: string | null
      kycReady?: boolean
      kycStatus?: string | null
      kycMessage?: string | null
      kycLabel?: string | null
      rekycRequired?: boolean
      suggestedIntent?: string
      suggestedLink?: { absoluteUrl?: string; path?: string; reason?: string }
      nextSteps?: Array<{ id: string; title: string; description: string }>
      subscriptions?: Array<{
        productType: string
        planName?: string | null
        productName?: string | null
        expiresAt?: string | null
      }>
    }
  }>('/api/whatsapp/bot/status', { method: 'POST', body: opts })
}

export async function researchNextLink(opts: {
  intent: 'kyc' | 'buy' | 'dashboard' | 'subscription' | 'checkout'
  productSlug?: string
  billingCycle?: string
  planId?: string
  productId?: string
  productType?: string
}) {
  return botFetch<{
    ok: true
    path: string
    absoluteUrl: string
    reason: string
  }>('/api/whatsapp/bot/next-link', { method: 'POST', body: opts })
}

export async function researchCatalogPlans() {
  return botFetch<{ ok: true; items: ResearchPlanItem[] }>(
    '/api/whatsapp/bot/catalog/plans',
  )
}

export async function researchCatalogPortfolios() {
  return botFetch<{ ok: true; items: ResearchPortfolioItem[] }>(
    '/api/whatsapp/bot/catalog/portfolios',
  )
}

export async function researchCatalogPortfolio(slug: string) {
  return botFetch<{ ok: true; item: ResearchPortfolioItem }>(
    `/api/whatsapp/bot/catalog/portfolios?slug=${encodeURIComponent(slug)}`,
  )
}

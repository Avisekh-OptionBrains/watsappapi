import type { Site } from '../sites'
import { mapOptionBrainsPlans, mapOptionBrainsPortfolios, mapOptionBrainsStatus, optionBrainsIntent } from './optionbrains'
import type { AccountStatus, CatalogSection, Connector, Result, SignInResult } from './types'

type BotConfig = NonNullable<Site['bot']>

async function botFetch<T>(
  bot: BotConfig,
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<Result<T>> {
  try {
    const res = await fetch(`${bot.apiUrl.replace(/\/$/, '')}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${bot.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(10_000),
    })
    const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; message?: string; error?: string }
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        status: res.status,
        message: json.message || json.error || `HTTP ${res.status}`,
      }
    }
    return { ok: true, data: json }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Website API unreachable' }
  }
}

type SignInResponse = {
  ctaUrl?: string
  ux?: { title?: string; body?: string; ctaLabel?: string; ctaUrl?: string }
}

function toSignIn(data: SignInResponse): SignInResult {
  return {
    title: data.ux?.title || 'You are signed in',
    body: data.ux?.body || 'Tap below to continue on the website.',
    ctaLabel: data.ux?.ctaLabel || 'Continue',
    ctaUrl: data.ux?.ctaUrl || data.ctaUrl || null,
  }
}

function standardConnector(bot: BotConfig): Connector {
  return {
    async catalog() {
      const res = await botFetch<{ sections?: CatalogSection[] }>(bot, '/catalog')
      return res.ok ? { ok: true, data: res.data.sections ?? [] } : res
    },
    async sendOtp(opts) {
      const res = await botFetch<{ isNewUser?: boolean }>(bot, '/send-otp', { method: 'POST', body: opts })
      return res.ok ? { ok: true, data: { isNewUser: Boolean(res.data.isNewUser) } } : res
    },
    async verifyOtp(opts) {
      const res = await botFetch<SignInResponse>(bot, '/verify-otp', { method: 'POST', body: opts })
      return res.ok ? { ok: true, data: toSignIn(res.data) } : res
    },
    async status(opts) {
      const res = await botFetch<{ status?: Partial<AccountStatus> }>(bot, '/status', { method: 'POST', body: opts })
      if (!res.ok) return res
      const st = res.data.status ?? {}
      return {
        ok: true,
        data: {
          found: Boolean(st.found),
          name: st.name ?? null,
          email: st.email ?? null,
          summary: Array.isArray(st.summary) ? st.summary.filter((l) => typeof l === 'string') : [],
          nextSteps: Array.isArray(st.nextSteps) ? st.nextSteps : [],
        },
      }
    },
  }
}

/** ob-research predates the standard contract: separate plans/portfolios endpoints. */
function optionBrainsConnector(bot: BotConfig): Connector {
  return {
    async catalog() {
      const [plans, portfolios] = await Promise.all([
        botFetch<{ items?: unknown[] }>(bot, '/catalog/plans'),
        botFetch<{ items?: unknown[] }>(bot, '/catalog/portfolios'),
      ])
      if (!plans.ok && !portfolios.ok) return plans
      const sections: CatalogSection[] = []
      if (plans.ok) sections.push(mapOptionBrainsPlans(plans.data.items ?? []))
      if (portfolios.ok) sections.push(mapOptionBrainsPortfolios(portfolios.data.items ?? []))
      return { ok: true, data: sections }
    },
    async sendOtp(opts) {
      const res = await botFetch<{ isNewUser?: boolean }>(bot, '/send-otp', { method: 'POST', body: opts })
      return res.ok ? { ok: true, data: { isNewUser: Boolean(res.data.isNewUser) } } : res
    },
    async verifyOtp(opts) {
      const res = await botFetch<SignInResponse>(bot, '/verify-otp', {
        method: 'POST',
        body: { ...opts, ...optionBrainsIntent(opts.next) },
      })
      return res.ok ? { ok: true, data: toSignIn(res.data) } : res
    },
    async status(opts) {
      const res = await botFetch<{ status?: Record<string, unknown> }>(bot, '/status', {
        method: 'POST',
        body: opts,
      })
      return res.ok ? { ok: true, data: mapOptionBrainsStatus(res.data.status ?? {}) } : res
    },
  }
}

export function connectorFor(site: Site): Connector | null {
  if (!site.bot) return null
  return site.bot.connector === 'optionbrains' ? optionBrainsConnector(site.bot) : standardConnector(site.bot)
}

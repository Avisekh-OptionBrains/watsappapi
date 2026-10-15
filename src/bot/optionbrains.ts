import type { AccountStatus, CatalogItem, CatalogSection } from './types'

type ObPlan = {
  name?: string
  slug?: string
  description?: string
  fromPrice?: string
  isTopTier?: boolean
  highlights?: string[]
  buyPath?: string
}

type ObPortfolio = {
  name?: string
  slug?: string
  tagline?: string
  riskProfile?: string | null
  rebalanceFrequency?: string | null
  cagr?: number | null
  totalReturn?: number | null
  includedInElite?: boolean
  monthlyPrice?: number | null
  quarterlyPrice?: number | null
  yearlyPrice?: number | null
  viewPath?: string
}

/** Relative site path only; absolute URLs from the API are ignored. */
function sitePath(path: string | undefined, fallback: string): string {
  return path && path.startsWith('/') && !path.startsWith('//') ? path : fallback
}

function inr(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null
  return `From ₹${Math.round(n).toLocaleString('en-IN')}`
}

export function mapOptionBrainsPlans(items: unknown[]): CatalogSection {
  const mapped: CatalogItem[] = (items as ObPlan[])
    .filter((p) => p?.slug && p?.name)
    .map((p) => ({
      id: p.slug!,
      title: p.name!,
      subtitle: p.fromPrice || p.description || 'Research subscription',
      body: p.description || undefined,
      priceLabel: p.fromPrice || undefined,
      highlights: [
        ...(p.highlights ?? []).slice(0, 8),
        ...(p.isTopTier ? ['All-Access includes eligible model portfolios.'] : []),
      ],
      action: { label: 'Continue to buy', path: sitePath(p.buyPath, `/buy/${p.slug}`), signIn: true },
    }))
  return { id: 'plans', title: 'Research plans', description: 'Cash, F&O, All-Access', items: mapped }
}

export function mapOptionBrainsPortfolios(items: unknown[]): CatalogSection {
  const mapped: CatalogItem[] = (items as ObPortfolio[])
    .filter((p) => p?.slug && p?.name)
    .map((p) => {
      const price =
        (inr(p.monthlyPrice) && `${inr(p.monthlyPrice)} / mo`) ||
        (inr(p.quarterlyPrice) && `${inr(p.quarterlyPrice)} / qtr`) ||
        (inr(p.yearlyPrice) && `${inr(p.yearlyPrice)} / yr`) ||
        undefined
      const perf = [
        typeof p.cagr === 'number' ? `CAGR: ${p.cagr.toFixed(1)}%` : null,
        typeof p.totalReturn === 'number' ? `Total return: ${p.totalReturn.toFixed(1)}%` : null,
      ].filter(Boolean)
      const body = [
        p.tagline || null,
        p.riskProfile ? `Risk: ${p.riskProfile}` : null,
        p.rebalanceFrequency ? `Rebalance: ${p.rebalanceFrequency}` : null,
        perf.length ? perf.join(' · ') : null,
        p.includedInElite ? 'Included with All-Access research.' : null,
      ]
        .filter(Boolean)
        .join('\n')
      return {
        id: p.slug!,
        title: p.name!,
        subtitle: p.tagline || p.riskProfile || 'Model portfolio',
        body: body || undefined,
        priceLabel: price,
        action: { label: 'View details', path: sitePath(p.viewPath, `/model-portfolios/${p.slug}`), signIn: true },
      }
    })
  return { id: 'portfolios', title: 'Model portfolios', description: 'Strategies you can follow', items: mapped }
}

const NEXT_STEP_PATHS: Record<string, string> = {
  next_kyc: '/kyc',
  next_subscription: '/dashboard/subscription',
}

function kycPlain(status: unknown, ready: unknown): string {
  if (ready) return 'Verification complete'
  switch (String(status ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'Verification on file - an update may be needed before purchase'
    case 'PENDING':
    case 'IN_REVIEW':
      return 'Verification in progress'
    case 'REJECTED':
      return 'Verification needs attention'
    case '':
    case 'NOT_STARTED':
      return 'Verification not started'
    default:
      return 'Verification status unavailable'
  }
}

export function mapOptionBrainsStatus(st: Record<string, unknown>): AccountStatus {
  const found = Boolean(st.found)
  if (!found) return { found: false, summary: [], nextSteps: [] }

  const summary: string[] = []
  const kycLabel = typeof st.kycLabel === 'string' && st.kycLabel ? st.kycLabel : kycPlain(st.kycStatus, st.kycReady)
  summary.push(kycLabel)
  if (typeof st.kycMessage === 'string' && st.kycMessage && st.kycMessage !== kycLabel) summary.push(st.kycMessage)

  const subs = Array.isArray(st.subscriptions) ? (st.subscriptions as Array<Record<string, unknown>>) : []
  if (!subs.length) {
    summary.push('No active subscription')
  } else {
    summary.push('Active:')
    for (const s of subs.slice(0, 5)) {
      const name = String(s.planName || s.productName || 'Subscription')
      const until = typeof s.expiresAt === 'string' ? ` until ${s.expiresAt.slice(0, 10)}` : ''
      summary.push(`• ${name}${until}`)
    }
  }

  const rawSteps = Array.isArray(st.nextSteps) ? (st.nextSteps as Array<Record<string, unknown>>) : []
  const nextSteps = rawSteps
    .filter((s) => typeof s.id === 'string' && typeof s.title === 'string')
    .slice(0, 2)
    .map((s) => ({
      id: String(s.id),
      title: String(s.title),
      path: NEXT_STEP_PATHS[String(s.id)] ?? (typeof s.path === 'string' ? s.path : undefined),
    }))
  const hint = rawSteps.find((s) => typeof s.description === 'string')?.description
  if (typeof hint === 'string' && hint) summary.push(`Next: ${hint}`)

  return {
    found: true,
    name: typeof st.name === 'string' ? st.name : null,
    email: typeof st.email === 'string' ? st.email : null,
    summary,
    nextSteps,
  }
}

/** ob-research verify-otp expects an intent + product slug derived from the destination. */
export function optionBrainsIntent(next: string | undefined): { intent?: string; productSlug?: string } {
  if (!next) return {}
  if (next.startsWith('/kyc')) return { intent: 'kyc' }
  if (next.startsWith('/dashboard/subscription')) return { intent: 'subscription' }
  if (next.startsWith('/buy/')) return { intent: 'buy', productSlug: next.split('/')[2] }
  return { intent: 'dashboard' }
}

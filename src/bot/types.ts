export type Result<T> = { ok: true; data: T } | { ok: false; message: string; status?: number }

export type CatalogAction = {
  label: string
  /** Path on the site, e.g. `/buy/cash-research`. */
  path: string
  /** Sign in by email code first, then open a one-time login link to `path`. */
  signIn?: boolean
}

export type CatalogItem = {
  id: string
  title: string
  subtitle?: string
  body?: string
  priceLabel?: string
  highlights?: string[]
  action?: CatalogAction
}

export type CatalogSection = {
  id: string
  title: string
  description?: string
  items: CatalogItem[]
}

export type AccountStatus = {
  found: boolean
  name?: string | null
  email?: string | null
  /** Short lines shown to the customer (plan, KYC, desk status...). */
  summary: string[]
  nextSteps: Array<{ id: string; title: string; path?: string }>
}

export type SignInResult = {
  title: string
  body: string
  ctaLabel: string
  ctaUrl: string | null
}

/**
 * What a website must expose for the WhatsApp bot. The standard contract is documented
 * in README "Website connector contract".
 */
export type Connector = {
  catalog(): Promise<Result<CatalogSection[]>>
  sendOtp(opts: { email: string; phone: string }): Promise<Result<{ isNewUser: boolean }>>
  verifyOtp(opts: { email: string; phone: string; otp: string; next?: string }): Promise<Result<SignInResult>>
  status(opts: { phone: string; email?: string }): Promise<Result<AccountStatus>>
}

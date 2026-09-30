import {
  researchCatalogPlans,
  researchCatalogPortfolios,
  researchCatalogPortfolio,
  researchSendOtp,
  researchStatus,
  researchVerifyOtp,
  whatsappToNationalPhone,
  type ResearchPlanItem,
  type ResearchPortfolioItem,
} from '../clients/research-api'
import {
  sendMetaCtaUrl,
  sendMetaInteractiveList,
  sendMetaReplyButtons,
  sendMetaText,
} from '../clients/meta-cloud'
import { getRedis } from './redis'

export type ProductFlowState =
  | { step: 'idle' }
  | { step: 'await_email'; nextPath?: string }
  | { step: 'await_otp'; email: string; nextPath?: string }
  | { step: 'plans'; items: ResearchPlanItem[] }
  | { step: 'plan_detail'; item: ResearchPlanItem }
  | { step: 'portfolios'; items: ResearchPortfolioItem[] }
  | { step: 'portfolio_detail'; item: ResearchPortfolioItem }

const KEY = (phone: string) => `wa:product:${phone}`
const TTL_SEC = 60 * 45

const START_RE = /^(hi+|hello+|hey+|hii+|start|menu)\b/i
const HELP_RE = /^(help|support|faq)\b/i
const EXIT_RE = /^(#(exit|quit|stop)|exit|quit)\b/i
const NAV_IDS = new Set([
  'menu_home',
  'menu_main',
  'menu_plans',
  'menu_portfolios',
  'menu_signin',
  'menu_account',
  'menu_help',
  'otp_resend',
  'otp_change_email',
])

function isEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim())
}

function publicSiteBase(): string {
  const raw =
    process.env.WHATSAPP_PUBLIC_SITE_URL?.trim() ||
    'https://optionbrains.com'
  return raw.replace(/\/$/, '')
}

function isUnsafeCustomerUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const h = u.hostname.toLowerCase()
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h === 'host.docker.internal' ||
      h.endsWith('.internal') ||
      h.endsWith('.local') ||
      h.endsWith('.localhost')
    )
  } catch {
    return true
  }
}

function safeCustomerUrl(url: string | null | undefined, fallbackPath: string): string {
  if (url && !isUnsafeCustomerUrl(url) && !/[?&]token=/i.test(url) && !/\/auth\/whatsapp-handoff/i.test(url)) {
    return url
  }
  return `${publicSiteBase()}${fallbackPath.startsWith('/') ? fallbackPath : `/${fallbackPath}`}`
}

function formatInr(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null
  return `From ₹${Math.round(n).toLocaleString('en-IN')}`
}

function friendlyOtpError(message: string): string {
  const m = (message || '').toLowerCase()
  if (m.includes('expired')) return 'That code expired. Tap Resend code or reply Menu.'
  if (m.includes('rate') || m.includes('too many') || m.includes('wait')) {
    return 'Too many tries. Wait a few minutes, then try again.'
  }
  if (m.includes('invalid')) return 'That code did not match. Check the email and try again.'
  return 'That code did not work. Try again, or reply Menu to start over.'
}

async function getState(phone: string): Promise<ProductFlowState | null> {
  const raw = await getRedis().get(KEY(phone))
  if (!raw) return null
  try {
    return JSON.parse(raw) as ProductFlowState
  } catch {
    return null
  }
}

async function setState(phone: string, state: ProductFlowState): Promise<void> {
  await getRedis().set(KEY(phone), JSON.stringify(state), 'EX', TTL_SEC)
}

export async function clearProductFlow(phone: string): Promise<void> {
  await getRedis().del(KEY(phone))
}

async function say(phone: string, text: string) {
  await sendMetaText({ number: phone, text })
}

async function sendMainMenu(phone: string) {
  await setState(phone, { step: 'idle' })
  await sendMetaInteractiveList({
    number: phone,
    body: 'Welcome to OptionBrains. What would you like to do?',
    buttonLabel: 'Open menu',
    sectionTitle: 'Main menu',
    rows: [
      { id: 'menu_plans', title: 'Research plans', description: 'Cash, F&O, All-Access' },
      {
        id: 'menu_portfolios',
        title: 'Model portfolios',
        description: 'Strategies you can follow',
      },
      { id: 'menu_signin', title: 'Sign in', description: 'Email code, then open the site' },
      { id: 'menu_account', title: 'My account', description: 'KYC and subscriptions' },
      { id: 'menu_help', title: 'Help', description: 'Support and FAQs' },
    ],
    footer: 'Reply Menu anytime to go home',
  })
}

function kycPlain(status?: string | null, ready?: boolean): string {
  if (ready) return 'Verification complete'
  switch ((status ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'Verification on file - an update may be needed before purchase'
    case 'PENDING':
    case 'IN_REVIEW':
      return 'Verification in progress'
    case 'REJECTED':
      return 'Verification needs attention'
    case 'NOT_STARTED':
    case '':
    case null:
    case undefined:
      return 'Verification not started'
    default:
      return 'Verification status unavailable'
  }
}

async function showPlans(phone: string) {
  const res = await researchCatalogPlans()
  if (!res.ok) {
    await say(phone, 'We could not load plans right now. Please try again shortly.')
    await sendMainMenu(phone)
    return
  }
  const items = res.data.items
  if (!items.length) {
    await say(phone, 'No research plans are available at the moment.')
    await sendMainMenu(phone)
    return
  }
  await setState(phone, { step: 'plans', items })
  await sendMetaInteractiveList({
    number: phone,
    body:
      items.length >= 10
        ? 'Choose a research plan to learn more.\nShowing top 10. More on the website.'
        : 'Choose a research plan to learn more.',
    buttonLabel: 'View plans',
    sectionTitle: 'Plans',
    rows: items.map((p) => ({
      id: `plan:${p.slug}`,
      title: p.name.slice(0, 24),
      description: (p.fromPrice || p.description || 'Research subscription').slice(0, 72),
    })),
  })
}

async function showPlanDetail(phone: string, item: ResearchPlanItem) {
  await setState(phone, { step: 'plan_detail', item })
  const highlights = (item.highlights ?? []).slice(0, 3).map((h) => `• ${h}`)
  const lines = [
    item.name,
    item.fromPrice ? item.fromPrice : null,
    item.description || null,
    highlights.length ? '' : null,
    ...highlights,
    item.isTopTier ? 'All-Access includes eligible model portfolios.' : null,
  ].filter((x) => x !== null) as string[]

  await sendMetaReplyButtons({
    number: phone,
    body: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim(),
    buttons: [
      { id: `buy_plan:${item.slug}`, title: 'Continue to buy' },
      { id: 'menu_plans', title: 'All plans' },
      { id: 'menu_home', title: 'Main menu' },
    ],
  })
}

async function showPortfolios(phone: string) {
  const res = await researchCatalogPortfolios()
  if (!res.ok) {
    await say(phone, 'We could not load model portfolios right now. Please try again shortly.')
    await sendMainMenu(phone)
    return
  }
  const items = res.data.items
  if (!items.length) {
    await say(phone, 'No model portfolios are published yet.')
    await sendMainMenu(phone)
    return
  }
  await setState(phone, { step: 'portfolios', items })
  await sendMetaInteractiveList({
    number: phone,
    body:
      items.length >= 10
        ? 'Choose a model portfolio to see a short summary.\nShowing top 10. More on the website.'
        : 'Choose a model portfolio to see a short summary.',
    buttonLabel: 'Portfolios',
    sectionTitle: 'Model portfolios',
    rows: items.map((p) => ({
      id: `mp:${p.slug}`,
      title: p.name.slice(0, 24),
      description: (p.tagline || p.riskProfile || 'Model portfolio').slice(0, 72),
    })),
  })
}

async function showPortfolioDetail(phone: string, item: ResearchPortfolioItem) {
  let detail = item
  const fresh = await researchCatalogPortfolio(item.slug)
  if (fresh.ok) detail = fresh.data.item

  await setState(phone, { step: 'portfolio_detail', item: detail })
  const monthly = formatInr(detail.monthlyPrice)
  const quarterly = formatInr(detail.quarterlyPrice)
  const yearly = formatInr(detail.yearlyPrice)
  const priceLine = monthly
    ? `${monthly} / mo`
    : quarterly
      ? `${quarterly} / qtr`
      : yearly
        ? `${yearly} / yr`
        : null
  const perf: string[] = []
  if (typeof detail.cagr === 'number') perf.push(`CAGR: ${detail.cagr.toFixed(1)}%`)
  if (typeof detail.totalReturn === 'number') {
    perf.push(`Total return: ${detail.totalReturn.toFixed(1)}%`)
  }

  const bits = [
    detail.name,
    detail.tagline || null,
    detail.riskProfile ? `Risk: ${detail.riskProfile}` : null,
    detail.rebalanceFrequency ? `Rebalance: ${detail.rebalanceFrequency}` : null,
    perf.length ? perf.join(' · ') : null,
    priceLine,
    detail.includedInElite ? 'Included with All-Access research.' : null,
  ].filter(Boolean) as string[]

  await sendMetaReplyButtons({
    number: phone,
    body: bits.join('\n'),
    buttons: [
      {
        id: `view_mp:${detail.slug}`,
        title: detail.includedInElite ? 'View details' : 'View details',
      },
      { id: 'menu_portfolios', title: 'All portfolios' },
      { id: 'menu_home', title: 'Main menu' },
    ],
  })
}

async function beginSignIn(phone: string, nextPath?: string) {
  await setState(phone, { step: 'await_email', nextPath })
  await say(
    phone,
    'What is your email address?\n\nWe will email you a 6-digit sign-in code (same as the website).\n\nReply Menu anytime to cancel.',
  )
}

async function showAccount(phone: string) {
  const national = whatsappToNationalPhone(phone)
  const res = await researchStatus({ phone: national })
  if (!res.ok) {
    await say(phone, 'We could not load your account right now. Please try again shortly.')
    await sendMainMenu(phone)
    return
  }
  const st = res.data.status
  if (!st.found) {
    await sendMetaReplyButtons({
      number: phone,
      body: 'We do not see an OptionBrains account for this WhatsApp number yet.',
      buttons: [
        { id: 'menu_signin', title: 'Sign in' },
        { id: 'menu_plans', title: 'Research plans' },
        { id: 'menu_home', title: 'Main menu' },
      ],
    })
    return
  }

  const lines = [
    st.name ? `Hi ${st.name}` : null,
    st.email ? `Signed in as ${st.email}` : 'Account found',
    st.kycLabel || kycPlain(st.kycStatus, st.kycReady),
    st.kycMessage && st.kycMessage !== (st.kycLabel || '') ? st.kycMessage : null,
  ].filter(Boolean) as string[]

  const subs = st.subscriptions ?? []
  if (!subs.length) {
    lines.push('No active subscription')
  } else {
    lines.push('Active:')
    for (const s of subs.slice(0, 5)) {
      const name = s.planName || s.productName || 'Subscription'
      const until = s.expiresAt ? ` until ${s.expiresAt.slice(0, 10)}` : ''
      lines.push(`• ${name}${until}`)
    }
  }

  const nextHints = (st.nextSteps ?? [])
    .slice(0, 2)
    .map((s) => s.description)
    .filter(Boolean)
  if (nextHints.length) {
    lines.push(`Next: ${nextHints[0]}`)
  }

  const actionButtons = (st.nextSteps ?? []).slice(0, 2).map((s) => ({
    id: s.id,
    title: s.title.slice(0, 20),
  }))
  const buttons = [...actionButtons, { id: 'menu_home', title: 'Main menu' }].slice(0, 3)

  await sendMetaReplyButtons({
    number: phone,
    body: lines.join('\n'),
    buttons,
  })
}

async function showHelp(phone: string) {
  const url = safeCustomerUrl(null, '/support')
  await sendMetaCtaUrl({
    number: phone,
    body: 'Need help? Email support@optionbrains.com or open Support below.\n\nReply Menu anytime. Reply STOP to unsubscribe from marketing messages.',
    displayText: 'Support centre',
    url,
  })
}

async function dispatchId(phone: string, id: string) {
  if (id === 'menu_home' || id === 'menu_main') {
    await sendMainMenu(phone)
    return
  }
  if (id === 'menu_plans') {
    await showPlans(phone)
    return
  }
  if (id === 'menu_portfolios') {
    await showPortfolios(phone)
    return
  }
  if (id === 'menu_signin') {
    await beginSignIn(phone)
    return
  }
  if (id === 'menu_account') {
    await showAccount(phone)
    return
  }
  if (id === 'menu_help') {
    await showHelp(phone)
    return
  }
  if (id === 'next_kyc') {
    await beginSignIn(phone, '/kyc')
    return
  }
  if (id === 'next_subscription') {
    await beginSignIn(phone, '/dashboard/subscription')
    return
  }
  if (id.startsWith('plan:')) {
    const slug = id.slice(5)
    const state = await getState(phone)
    const fromList =
      state?.step === 'plans' ? state.items.find((p) => p.slug === slug) : undefined
    if (fromList) {
      await showPlanDetail(phone, fromList)
      return
    }
    const plans = await researchCatalogPlans()
    const item = plans.ok ? plans.data.items.find((p) => p.slug === slug) : undefined
    if (item) await showPlanDetail(phone, item)
    else {
      await say(phone, 'That plan is no longer available.')
      await sendMainMenu(phone)
    }
    return
  }
  if (id.startsWith('buy_plan:')) {
    const slug = id.slice(9)
    await beginSignIn(phone, `/buy/${slug}`)
    return
  }
  if (id.startsWith('mp:')) {
    const slug = id.slice(3)
    const state = await getState(phone)
    const fromList =
      state?.step === 'portfolios' ? state.items.find((p) => p.slug === slug) : undefined
    if (fromList) {
      await showPortfolioDetail(phone, fromList)
      return
    }
    const one = await researchCatalogPortfolio(slug)
    if (one.ok) await showPortfolioDetail(phone, one.data.item)
    else {
      await say(phone, 'That portfolio is no longer available.')
      await sendMainMenu(phone)
    }
    return
  }
  if (id.startsWith('view_mp:')) {
    const slug = id.slice(8)
    await beginSignIn(phone, `/model-portfolios/${slug}`)
    return
  }

  // Numeric fallbacks only when last state was a list (interactive failed over to numbers)
  if (/^\d+$/.test(id)) {
    const n = Number(id)
    const state = await getState(phone)
    if (state?.step === 'plans' && n >= 1 && n <= state.items.length) {
      await showPlanDetail(phone, state.items[n - 1])
      return
    }
    if (state?.step === 'portfolios' && n >= 1 && n <= state.items.length) {
      await showPortfolioDetail(phone, state.items[n - 1])
      return
    }
    if (state?.step === 'idle') {
      const map = ['menu_plans', 'menu_portfolios', 'menu_signin', 'menu_account', 'menu_help']
      if (n >= 1 && n <= map.length) {
        await dispatchId(phone, map[n - 1])
        return
      }
    }
  }

  await sendMainMenu(phone)
}

async function handleAwaitEmail(phone: string, text: string, nextPath?: string) {
  if (!isEmail(text)) {
    await say(phone, 'Please reply with a valid email address (for example: you@example.com).')
    return
  }
  const email = text.trim().toLowerCase()
  const national = whatsappToNationalPhone(phone)
  const sent = await researchSendOtp({ email, phone: national })
  if (!sent.ok) {
    await say(
      phone,
      `We could not send the code right now. Please check the email and try again, or reply Menu.`,
    )
    return
  }
  await setState(phone, { step: 'await_otp', email, nextPath })
  const newbie =
    'isNewUser' in sent.data && sent.data.isNewUser
      ? '\n\nIf you are new, this also creates your OptionBrains login.'
      : ''
  await sendMetaReplyButtons({
    number: phone,
    body: `We emailed a 6-digit code to ${email}.${newbie}\n\nReply with that code.`,
    buttons: [
      { id: 'otp_resend', title: 'Resend code' },
      { id: 'otp_change_email', title: 'Change email' },
      { id: 'menu_home', title: 'Main menu' },
    ],
  })
}

async function handleAwaitOtp(
  phone: string,
  text: string,
  email: string,
  nextPath?: string,
) {
  const otp = text.replace(/\D/g, '')
  if (otp.length < 6) {
    await say(phone, 'Please reply with the 6-digit code from your email.')
    return
  }
  const national = whatsappToNationalPhone(phone)
  const intent =
    nextPath?.startsWith('/kyc')
      ? 'kyc'
      : nextPath?.startsWith('/dashboard/subscription')
        ? 'subscription'
        : nextPath?.startsWith('/buy')
          ? 'buy'
          : nextPath
            ? 'dashboard'
            : undefined
  const productSlug = nextPath?.startsWith('/buy/') ? nextPath.split('/')[2] : undefined

  const verified = await researchVerifyOtp({
    email,
    phone: national,
    otp,
    intent,
    productSlug,
    next: nextPath,
  })

  if (!verified.ok) {
    await setState(phone, { step: 'await_otp', email, nextPath })
    await sendMetaReplyButtons({
      number: phone,
      body: friendlyOtpError(verified.message),
      buttons: [
        { id: 'otp_resend', title: 'Resend code' },
        { id: 'otp_change_email', title: 'Change email' },
        { id: 'menu_home', title: 'Main menu' },
      ],
    })
    return
  }

  await clearProductFlow(phone)
  const ux = verified.data.ux
  const ctaUrl = safeCustomerUrl(
    ux?.ctaUrl || verified.data.ctaUrl,
    '/signin',
  )
  await sendMetaCtaUrl({
    number: phone,
    body: `${ux?.title ?? 'You are signed in'}\n\n${ux?.body ?? 'Tap below to continue on the website.'}`,
    displayText: ux?.ctaLabel ?? 'Continue on website',
    url: ctaUrl,
  })
}

/**
 * Product WhatsApp bot - interactive menus + research APIs.
 * Returns true when the message was handled.
 */
export async function handleProductBotMessage(
  phone: string,
  text: string,
  interactiveId?: string | null,
): Promise<boolean> {
  const trimmed = text.trim()
  const id = (interactiveId || '').trim()

  if (EXIT_RE.test(trimmed)) {
    await clearProductFlow(phone)
    await say(phone, 'Chat ended. Send Hi anytime to open the menu again.')
    return true
  }

  if (HELP_RE.test(trimmed) && !START_RE.test(trimmed)) {
    await clearProductFlow(phone)
    await showHelp(phone)
    return true
  }

  if (START_RE.test(trimmed) || /^menu$/i.test(trimmed)) {
    await clearProductFlow(phone)
    await sendMainMenu(phone)
    return true
  }

  const state = await getState(phone)

  // Nav buttons must work even during email/OTP steps
  if (id && (NAV_IDS.has(id) || id.startsWith('menu_'))) {
    if (id === 'otp_resend' && state?.step === 'await_otp') {
      const national = whatsappToNationalPhone(phone)
      const sent = await researchSendOtp({ email: state.email, phone: national })
      if (!sent.ok) {
        await say(phone, 'Could not resend the code right now. Try again in a minute.')
        return true
      }
      await say(phone, `We sent a new code to ${state.email}. Reply with the 6-digit code.`)
      return true
    }
    if (id === 'otp_change_email') {
      await beginSignIn(phone, state?.step === 'await_otp' || state?.step === 'await_email' ? state.nextPath : undefined)
      return true
    }
    await clearProductFlow(phone)
    await dispatchId(phone, id)
    return true
  }

  if (state?.step === 'await_email') {
    await handleAwaitEmail(phone, trimmed, state.nextPath)
    return true
  }
  if (state?.step === 'await_otp') {
    await handleAwaitOtp(phone, trimmed, state.email, state.nextPath)
    return true
  }

  if (id) {
    await dispatchId(phone, id)
    return true
  }

  const lower = trimmed.toLowerCase()
  if (/plan|pricing|cash|fno|all.?access/.test(lower)) {
    await showPlans(phone)
    return true
  }
  if (/portfolio|model/.test(lower)) {
    await showPortfolios(phone)
    return true
  }
  if (/sign\s*in|login|log\s*in/.test(lower)) {
    await beginSignIn(phone)
    return true
  }
  if (/account|status|subscription|kyc/.test(lower)) {
    await showAccount(phone)
    return true
  }
  if (/help|support|faq/.test(lower)) {
    await showHelp(phone)
    return true
  }
  if (/^\d{1,2}$/.test(trimmed)) {
    await dispatchId(phone, trimmed)
    return true
  }

  await sendMainMenu(phone)
  return true
}

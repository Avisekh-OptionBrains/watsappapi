import type { Env } from '../env'
import { getCatalog } from '../lib/catalog'
import { emitSiteEvent } from '../lib/events'
import { effectiveMode, getConversation, setConversationMode } from '../lib/conversations'
import { underLimit } from '../lib/limits'
import type { ListRow } from '../lib/meta'
import { toNationalDigits } from '../lib/phone'
import { alertNewRequest, openSupportRequest, resolveSupportRequests } from '../lib/support'
import { botSites, defaultSite, getSite, siteUrl, type Site } from '../sites'
import { aiAnswer, aiAvailable } from './ai'
import { connectorFor } from './connector'
import { createReplier, type Replier } from './reply'
import {
  clearSession,
  getPhoneSite,
  loadSession,
  resolveNumericReply,
  saveSession,
  setPhoneSite,
  type BotSession,
} from './state'
import { LIST_ROWS, bestHit, pageForIndex, pageOf, searchCatalog, type CatalogHit } from './browse'
import type { CatalogItem, CatalogSection } from './types'

type SiteHit = CatalogHit & { site: Site }

const BROWSE_RE = /^(catalog(ue)?|all products|products|everything|browse|show all|all plans and portfolios)$/i
const GREETING_RE = /^(hi+|hello+|hey+|hii+|start|menu|home|main menu)\b/i
const EXIT_RE = /^(#?(exit|quit|end)|bye)$/i
const HELP_RE = /^(help|support|faq|contact)\b/i
const SIGNIN_RE = /\b(sign ?in|log ?in)\b/i
const ACCOUNT_RE = /\b(my account|account|status|kyc|subscription|my plan)\b/i
const PERSON_RE = /\b(agent|human|person|executive|call me|talk to)\b/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS
/** Websites trust the gateway's service key, so sign-in abuse limits live here. */
async function mayRequestCode(env: Env, phone: string, email: string): Promise<boolean> {
  return (
    (await underLimit(env, `code:phone:${phone}`, 3, 15 * MINUTE_MS)) &&
    (await underLimit(env, `code:phone-day:${phone}`, 10, DAY_MS)) &&
    (await underLimit(env, `code:email:${email}`, 3, 15 * MINUTE_MS))
  )
}

type Ctx = {
  env: Env
  site: Site
  phone: string
  reply: Replier
  text: string
}

export type InboundForBot = {
  /** Digits-only WhatsApp id, e.g. 919876543210. */
  phone: string
  text: string
  /** Button / list reply id when the customer tapped an interactive option. */
  interactiveId?: string | null
}

/** Picks the site a customer is talking to on the shared number (null = ask). */
export async function resolveConversationSite(env: Env, phone: string): Promise<Site | null> {
  const stored = await loadSession(env, phone)
  const fromSession = stored?.session.step === 'brands' ? null : getSite(env, stored?.siteId)
  if (fromSession) return fromSession
  const fromPhone = getSite(env, await getPhoneSite(env, phone))
  if (fromPhone) return fromPhone
  const sites = botSites(env)
  return sites.length === 1 ? sites[0] : null
}

export async function handleBotMessage(env: Env, msg: InboundForBot): Promise<void> {
  const sites = botSites(env)
  if (!sites.length) return

  const text = msg.text.trim()
  const conv = await getConversation(env, msg.phone)
  const mode = effectiveMode(conv)
  // Staff are replying in the dashboard: the bot must not talk over them.
  if (mode === 'agent') return
  if (mode === 'needs_help') {
    if (!msg.interactiveId && !GREETING_RE.test(text)) return
    await setConversationMode(env, { phone: msg.phone, siteId: conv!.site_id, mode: 'bot' })
    await resolveSupportRequests(env, msg.phone)
  }

  const stored = await loadSession(env, msg.phone)
  const session = stored?.session ?? null
  const id = msg.interactiveId?.trim() || resolveNumericReply(text, session?.options) || ''

  let site = await resolveConversationSite(env, msg.phone)
  if (site && !site.bot?.enabled) site = sites.length === 1 ? sites[0] : null

  if (id.startsWith('site:')) {
    const chosen = sites.find((s) => s.id === id.slice(5))
    if (chosen) {
      await setPhoneSite(env, msg.phone, chosen.id)
      return showMenu(ctxFor(env, chosen, msg.phone, text))
    }
  }

  if (!id) {
    const named = matchSiteByName(sites, text)
    if (named) {
      await setPhoneSite(env, msg.phone, named.id)
      return showMenu(ctxFor(env, named, msg.phone, text))
    }
  }

  if (id === 'switch_site' || (!site && sites.length > 1)) {
    return showBrands(env, msg.phone, sites)
  }
  if (!site) return

  const ctx = ctxFor(env, site, msg.phone, text)

  if (!id && EXIT_RE.test(text)) {
    await clearSession(env, msg.phone)
    await ctx.reply.text('Chat ended. Send Hi anytime to open the menu again.')
    return
  }
  if (!id && GREETING_RE.test(text)) return showMenu(ctx)
  if (id) return dispatch(ctx, id)

  if (session?.step === 'await_email') return handleEmail(ctx, session.next)
  if (session?.step === 'await_otp') return handleOtp(ctx, session.email, session.next)

  if (HELP_RE.test(text)) return showHelp(ctx)
  if (PERSON_RE.test(text)) return startHandoff(ctx)
  if (SIGNIN_RE.test(text)) return askEmail(ctx)
  if (ACCOUNT_RE.test(text)) return showAccount(ctx)

  const sections = (await getCatalog(env, site))?.sections ?? []
  if (BROWSE_RE.test(text)) return showCatalog(ctx, sections, 0)

  const useAi = aiAvailable(env, site) && text.length >= 3
  // "F&O plan" opens the product; "what is the price of F&O?" deserves a written answer.
  const tried = !looksLikeQuestion(text) || !useAi
  if (tried && (await showCatalogMatch(ctx, sections, text, !useAi))) return
  if (useAi) return answerWithAi(ctx, async () => {
    if (tried || !(await showCatalogMatch(ctx, sections, text, true))) await showMenu(ctx)
  })
  return showMenu(ctx)
}

/**
 * Product by name, then a whole category, then a list of matches (also from the other brands).
 * `loose` also lists products matching only some of the words (when no AI can answer instead).
 */
async function showCatalogMatch(ctx: Ctx, sections: CatalogSection[], text: string, loose: boolean): Promise<boolean> {
  const hits = searchCatalog(sections, text).filter((h) => loose || h.all || h.exact)
  const best = bestHit(hits)
  if (best) {
    await showItem(ctx, best.section.id, best.item.id)
    return true
  }
  const section = matchSection(sections, text)
  if (section) {
    await showSection(ctx, section.id)
    return true
  }
  if (hits.length) {
    await showResults(ctx, text, hits.map((h) => ({ ...h, site: ctx.site })))
    return true
  }
  const elsewhere = await searchOtherSites(ctx, text)
  if (elsewhere.length) {
    await showResults(ctx, text, elsewhere)
    return true
  }
  return false
}

async function searchOtherSites(ctx: Ctx, text: string): Promise<SiteHit[]> {
  const others = botSites(ctx.env).filter((s) => s.id !== ctx.site.id)
  const found = await Promise.all(
    others.map(async (site) => {
      const catalog = await getCatalog(ctx.env, site).catch(() => null)
      return searchCatalog(catalog?.sections ?? [], text)
        .filter((h) => h.all || h.exact)
        .map((h) => ({ ...h, site }))
    }),
  )
  return found
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, LIST_ROWS - 1)
}

/** "what is the price of F&O plan?" deserves an answer, "plans" just the list. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim()
  return t.includes('?') || t.split(/\s+/).length >= 5 || /^(what|how|why|when|which|can|do|does|is|are|kya|kaise|kab)\b/i.test(t)
}

async function answerWithAi(ctx: Ctx, fallback: () => Promise<void>): Promise<void> {
  const answer = await aiAnswer(ctx.env, ctx.site, ctx.phone)
  if (!answer || answer.action === 'menu') return fallback()
  if (answer.action === 'handoff') return startHandoff(ctx)
  const ai = createReplier(ctx.env, ctx.site, ctx.phone, 'AI')
  const options = await ai.buttons(answer.reply, [
    { id: 'home', title: 'Main menu' },
    { id: 'handoff', title: 'Talk to our team' },
  ])
  await save(ctx, { step: 'menu', options })
}

function ctxFor(env: Env, site: Site, phone: string, text: string): Ctx {
  return { env, site, phone, text, reply: createReplier(env, site, phone) }
}

function save(ctx: Ctx, session: BotSession, ttlSec?: number) {
  return saveSession(ctx.env, ctx.phone, ctx.site.id, session, ttlSec)
}

export function matchSiteByName(sites: Site[], text: string): Site | null {
  const t = text.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '')
  if (!t || t.length > 40) return null
  return sites.find((s) => t === s.id || t === s.name.toLowerCase().replace(/[^a-z0-9 ]/g, '')) ?? null
}

export function matchSection(sections: CatalogSection[], text: string): CatalogSection | null {
  const t = text.toLowerCase()
  if (!t) return null
  for (const section of sections) {
    if (!section.items.length) continue
    const words = [section.id, ...section.title.toLowerCase().split(/\W+/)].filter((w) => w.length > 3)
    if (words.some((w) => t.includes(w.replace(/s$/, '')))) return section
  }
  if (/\b(plan|plans|price|pricing|buy|catalog|products?)\b/.test(t)) {
    return sections.find((s) => s.items.length) ?? null
  }
  return null
}

async function dispatch(ctx: Ctx, id: string): Promise<void> {
  if (id === 'home') return showMenu(ctx)
  if (id === 'signin') return askEmail(ctx)
  if (id === 'account') return showAccount(ctx)
  if (id === 'help') return showHelp(ctx)
  if (id === 'handoff') return startHandoff(ctx)
  if (id === 'otp_resend' || id === 'otp_change_email') {
    const s = (await loadSession(ctx.env, ctx.phone))?.session
    const pending = s?.step === 'await_otp' ? s : null
    if (id === 'otp_resend' && pending) return sendCode(ctx, pending.email, pending.next)
    return askEmail(ctx, { next: pending?.next })
  }
  if (id.startsWith('next:')) return askEmail(ctx, { next: id.slice(5) })
  if (id === 'catalog' || id.startsWith('cat:')) {
    const sections = (await getCatalog(ctx.env, ctx.site))?.sections ?? []
    return showCatalog(ctx, sections, Number(id.slice(4)) || 0)
  }
  if (id.startsWith('sec:')) {
    const m = /^sec:(.+?)(?::(\d+))?$/.exec(id)
    return m ? showSection(ctx, m[1], Number(m[2] ?? 0)) : showMenu(ctx)
  }
  if (id.startsWith('item:') || id.startsWith('act:')) {
    const [kind, sectionId, ...rest] = id.split(':')
    return kind === 'item' ? showItem(ctx, sectionId, rest.join(':')) : runAction(ctx, sectionId, rest.join(':'))
  }
  if (id.startsWith('xs:')) {
    const [, siteId, sectionId, ...rest] = id.split(':')
    const other = botSites(ctx.env).find((s) => s.id === siteId)
    if (!other) return showMenu(ctx)
    await setPhoneSite(ctx.env, ctx.phone, other.id)
    return showItem(ctxFor(ctx.env, other, ctx.phone, ctx.text), sectionId, rest.join(':'))
  }
  return showMenu(ctx)
}

async function showBrands(env: Env, phone: string, sites: Site[]): Promise<void> {
  const host = defaultSite(env)
  const reply = createReplier(env, host, phone)
  const options = await reply.list({
    body: 'Hi! Which service can we help you with today?',
    button: 'Choose',
    sectionTitle: 'Our services',
    rows: sites.map((s) => ({ id: `site:${s.id}`, title: s.name, description: s.tagline || undefined })),
    footer: 'You can switch anytime from the menu',
  })
  await saveSession(env, phone, host.id, { step: 'brands', options })
}

function sectionRow(s: CatalogSection): ListRow {
  return { id: `sec:${s.id}`, title: s.title, description: s.description || `${s.items.length} options` }
}

/** Every category fits: if there are too many for the menu, the last slot opens the full list. */
export function menuSectionRows(sections: CatalogSection[], room: number): ListRow[] {
  const listed = sections.filter((s) => s.items.length)
  if (listed.length <= room) return listed.map(sectionRow)
  const items = listed.reduce((n, s) => n + s.items.length, 0)
  return [
    ...listed.slice(0, room - 1).map(sectionRow),
    { id: 'catalog', title: 'All products', description: `${listed.length} categories, ${items} options` },
  ]
}

/** One page of a long list, with "Previous" / "Next" rows that reopen the same list. */
export function pagedRows<T>(all: T[], page: number, toRow: (t: T) => ListRow, pageId: (p: number) => string) {
  const pg = pageOf(all, page)
  const rows: ListRow[] = pg.items.map(toRow)
  if (pg.hasPrev) rows.push({ id: pageId(pg.page - 1), title: '◀ Previous', description: 'Go back a page' })
  if (pg.hasNext) {
    const left = all.length - pg.start - pg.items.length
    rows.push({ id: pageId(pg.page + 1), title: 'Next page ▶', description: `${left} more` })
  }
  const range = all.length > LIST_ROWS ? `Showing ${pg.start + 1}-${pg.start + pg.items.length} of ${all.length}.` : ''
  return { rows, page: pg.page, range }
}

async function showMenu(ctx: Ctx): Promise<void> {
  const catalog = await getCatalog(ctx.env, ctx.site)
  const fixed: ListRow[] = [
    { id: 'signin', title: 'Sign in', description: 'Get an email code, then open the website' },
    { id: 'account', title: 'My account', description: 'Your status and subscriptions' },
    { id: 'help', title: 'Help', description: 'Support or talk to our team' },
  ]
  const others = botSites(ctx.env).filter((s) => s.id !== ctx.site.id)
  if (others.length) {
    fixed.push({ id: 'switch_site', title: 'Other services', description: others.map((s) => s.name).join(', ') })
  }
  const rows = [...menuSectionRows(catalog?.sections ?? [], LIST_ROWS - fixed.length), ...fixed]

  const options = await ctx.reply.list({
    body: `Welcome to ${ctx.site.name}${ctx.site.tagline ? ` - ${ctx.site.tagline}` : ''}.\n\nWhat would you like to do? You can also type a product name.`,
    button: 'Open menu',
    sectionTitle: 'Main menu',
    rows,
    footer: 'Reply Menu anytime to come back here',
  })
  await save(ctx, { step: 'menu', options })
}

/** Every category of the site (when the main menu has no room for all of them). */
async function showCatalog(ctx: Ctx, sections: CatalogSection[], page: number): Promise<void> {
  const listed = sections.filter((s) => s.items.length)
  if (!listed.length) {
    await ctx.reply.text('Nothing is listed right now. Please check the website or try again later.')
    return showMenu(ctx)
  }
  if (listed.length === 1) return showSection(ctx, listed[0].id)
  const { rows, range } = pagedRows(listed, page, sectionRow, (p) => `cat:${p}`)
  const options = await ctx.reply.list({
    body: `Everything at ${ctx.site.name}.\n\nPick a category.${range ? `\n\n${range}` : ''}`,
    button: 'Categories',
    sectionTitle: 'Categories',
    rows,
    footer: 'Reply Menu for the main menu',
  })
  await save(ctx, { step: 'menu', options })
}

async function findSection(ctx: Ctx, sectionId: string): Promise<CatalogSection | null> {
  const catalog = await getCatalog(ctx.env, ctx.site)
  return catalog?.sections.find((s) => s.id === sectionId) ?? null
}

async function showSection(ctx: Ctx, sectionId: string, page = 0): Promise<void> {
  const section = await findSection(ctx, sectionId)
  if (!section || !section.items.length) {
    await ctx.reply.text('Nothing is listed here right now. Please check the website or try again later.')
    return showMenu(ctx)
  }
  const shown = pagedRows(
    section.items,
    page,
    (item) => ({ id: `item:${section.id}:${item.id}`, title: item.title, description: item.subtitle || item.priceLabel }),
    (p) => `sec:${section.id}:${p}`,
  )
  const options = await ctx.reply.list({
    body: `${section.title}${section.description ? `\n${section.description}` : ''}\n\nPick one to see details.${shown.range ? `\n\n${shown.range}` : ''}`,
    button: 'View options',
    sectionTitle: section.title,
    rows: shown.rows,
    footer: 'Reply Menu for the main menu',
  })
  await save(ctx, { step: 'section', sectionId: section.id, page: shown.page, options })
}

/** Products matching what the customer typed; rows from another brand switch to it. */
async function showResults(ctx: Ctx, text: string, hits: SiteHit[]): Promise<void> {
  const elsewhere = hits.some((h) => h.site.id !== ctx.site.id)
  const rows: ListRow[] = hits.slice(0, LIST_ROWS - 1).map((h) => ({
    id: h.site.id === ctx.site.id ? `item:${h.section.id}:${h.item.id}` : `xs:${h.site.id}:${h.section.id}:${h.item.id}`,
    title: h.item.title,
    description: [h.site.id === ctx.site.id ? h.section.title : h.site.name, h.item.priceLabel].filter(Boolean).join(' · '),
  }))
  rows.push({ id: 'home', title: 'Main menu' })
  const quoted = text.trim().slice(0, 40)
  const options = await ctx.reply.list({
    body: elsewhere
      ? `We found "${quoted}" at our other services. Pick one to see details.`
      : `Here is what matches "${quoted}". Pick one to see details.`,
    button: 'View matches',
    sectionTitle: 'Matches',
    rows,
  })
  await save(ctx, { step: 'menu', options })
}

const DETAIL_MAX = 1000

/** Title, price, highlights and as much of the description as fits one WhatsApp message. */
export function itemDetailText(item: CatalogItem): string {
  const highlights = item.highlights?.length ? `\n${item.highlights.slice(0, 8).map((h) => `• ${h}`).join('\n')}` : null
  const build = (body: string | null) =>
    [item.title, item.priceLabel || null, body ? `\n${body}` : null, highlights].filter(Boolean).join('\n')
  const full = build(item.body?.trim() || null)
  if (full.length <= DETAIL_MAX || !item.body) return full.slice(0, DETAIL_MAX)
  const room = DETAIL_MAX - build(null).length - 3
  const body = room >= 40 ? `${item.body.trim().slice(0, room - 1).trimEnd()}…` : null
  return build(body).slice(0, DETAIL_MAX)
}

async function showItem(ctx: Ctx, sectionId: string, itemId: string): Promise<void> {
  const section = await findSection(ctx, sectionId)
  const index = section?.items.findIndex((i) => i.id === itemId) ?? -1
  const item = index >= 0 ? section!.items[index] : null
  if (!section || !item) return showMenu(ctx)

  const page = pageForIndex(section.items.length, index)
  const buttons = [
    ...(item.action ? [{ id: `act:${section.id}:${item.id}`, title: item.action.label }] : []),
    { id: page ? `sec:${section.id}:${page}` : `sec:${section.id}`, title: 'Back' },
    { id: 'home', title: 'Main menu' },
  ]
  const options = await ctx.reply.buttons(itemDetailText(item), buttons)
  await save(ctx, { step: 'item', sectionId: section.id, itemId: item.id, options })
}

async function runAction(ctx: Ctx, sectionId: string, itemId: string): Promise<void> {
  const section = await findSection(ctx, sectionId)
  const action = section?.items.find((i) => i.id === itemId)?.action
  if (!action) return showMenu(ctx)
  if (action.signIn && connectorFor(ctx.site)) return askEmail(ctx, { next: action.path })
  await ctx.reply.cta({
    body: 'Continue on the website.',
    label: action.label,
    url: siteUrl(ctx.site, action.path),
  })
}

async function askEmail(ctx: Ctx, opts?: { next?: string }): Promise<void> {
  if (!connectorFor(ctx.site)) return showHelp(ctx)
  await save(ctx, { step: 'await_email', next: opts?.next })
  await ctx.reply.text(
    `What is your email address?\n\nWe will email you a 6-digit sign-in code from ${ctx.site.name}.\n\nReply Menu anytime to cancel.`,
  )
}

async function handleEmail(ctx: Ctx, next: string | undefined): Promise<void> {
  const email = ctx.text.toLowerCase()
  if (!EMAIL_RE.test(email) || email.length > 254) {
    await ctx.reply.text('That does not look like an email address. Please send it again, e.g. name@example.com')
    return
  }
  return sendCode(ctx, email, next)
}

async function sendCode(ctx: Ctx, email: string, next: string | undefined): Promise<void> {
  const connector = connectorFor(ctx.site)
  if (!connector) return showHelp(ctx)
  if (!(await mayRequestCode(ctx.env, ctx.phone, email))) {
    await ctx.reply.text('Too many code requests. Please wait 15 minutes and try again, or reply Menu.')
    await save(ctx, { step: 'await_email', next })
    return
  }
  const sent = await connector.sendOtp({ email, phone: toNationalDigits(ctx.phone) })
  if (!sent.ok) {
    await ctx.reply.text(
      sent.status === 429
        ? 'Too many code requests. Please wait a few minutes and try again.'
        : `We could not send a code: ${sent.message}\n\nCheck the email and send it again, or reply Menu.`,
    )
    await save(ctx, { step: 'await_email', next })
    return
  }
  const welcome = sent.data.isNewUser ? '\n\nWe will create your account when you confirm the code.' : ''
  const options = await ctx.reply.buttons(`We emailed a 6-digit code to ${email}.${welcome}\n\nReply here with the code.`, [
    { id: 'otp_resend', title: 'Resend code' },
    { id: 'otp_change_email', title: 'Change email' },
    { id: 'home', title: 'Main menu' },
  ])
  await save(ctx, { step: 'await_otp', email, next, options })
}

export function friendlyOtpError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('expired')) return 'That code has expired. Tap Resend code for a new one.'
  if (m.includes('invalid') || m.includes('incorrect') || m.includes('wrong')) {
    return 'That code is not correct. Check the latest email and try again.'
  }
  if (m.includes('too many') || m.includes('rate')) return 'Too many attempts. Please wait a few minutes.'
  return 'We could not verify that code. Please try again or tap Resend code.'
}

/** Only https links on the site's own domain (or a subdomain) are sent to customers. */
export function safeSiteLink(site: Site, url: string | null, fallbackPath: string): string {
  const fallback = siteUrl(site, fallbackPath)
  if (!url) return fallback
  try {
    const target = new URL(url)
    const home = new URL(site.publicUrl).hostname.replace(/^www\./, '')
    const host = target.hostname
    const sameSite = host === home || host.endsWith(`.${home}`)
    return target.protocol === 'https:' && sameSite ? target.toString() : fallback
  } catch {
    return fallback
  }
}

async function handleOtp(ctx: Ctx, email: string, next: string | undefined): Promise<void> {
  const otp = ctx.text.replace(/\D/g, '')
  if (otp.length < 6 || otp.length > 8) {
    await ctx.reply.text('Please reply with the 6-digit code from your email.')
    return
  }
  const connector = connectorFor(ctx.site)
  if (!connector) return showHelp(ctx)
  if (!(await underLimit(ctx.env, `verify:phone:${ctx.phone}`, 8, 15 * MINUTE_MS))) {
    await ctx.reply.text('Too many wrong codes. Please wait 15 minutes, then tap Resend code.')
    return
  }
  const verified = await connector.verifyOtp({ email, phone: toNationalDigits(ctx.phone), otp, next })
  if (!verified.ok) {
    const options = await ctx.reply.buttons(friendlyOtpError(verified.message), [
      { id: 'otp_resend', title: 'Resend code' },
      { id: 'otp_change_email', title: 'Change email' },
      { id: 'home', title: 'Main menu' },
    ])
    await save(ctx, { step: 'await_otp', email, next, options })
    return
  }
  await clearSession(ctx.env, ctx.phone)
  await setPhoneSite(ctx.env, ctx.phone, ctx.site.id)
  const ux = verified.data
  await ctx.reply.cta({
    body: `${ux.title}\n\n${ux.body}`,
    label: ux.ctaLabel,
    url: safeSiteLink(ctx.site, ux.ctaUrl, next || '/'),
    sensitive: true,
  })
}

async function showAccount(ctx: Ctx): Promise<void> {
  const connector = connectorFor(ctx.site)
  if (!connector) return showHelp(ctx)
  const res = await connector.status({ phone: toNationalDigits(ctx.phone) })
  if (!res.ok) {
    await ctx.reply.text('We could not load your account right now. Please try again in a minute.')
    return
  }
  const st = res.data
  if (!st.found) {
    const options = await ctx.reply.buttons(
      `We could not find a ${ctx.site.name} account linked to this WhatsApp number.\n\nSign in with your email to continue.`,
      [
        { id: 'signin', title: 'Sign in' },
        { id: 'home', title: 'Main menu' },
      ],
    )
    await save(ctx, { step: 'menu', options })
    return
  }
  const body = [
    st.name ? `Hi ${st.name}` : 'Your account',
    st.email ? `Email: ${st.email}` : null,
    '',
    ...st.summary,
  ]
    .filter((l) => l !== null)
    .join('\n')
  const options = await ctx.reply.buttons(body, [
    ...st.nextSteps.slice(0, 2).map((step) => ({ id: step.path ? `next:${step.path}` : 'signin', title: step.title })),
    { id: 'home', title: 'Main menu' },
  ])
  await save(ctx, { step: 'menu', options })
}

async function showHelp(ctx: Ctx): Promise<void> {
  const support = ctx.site.supportUrl || siteUrl(ctx.site, '/support')
  const lines = [
    `Need help with ${ctx.site.name}?`,
    '',
    ctx.site.supportEmail ? `Email: ${ctx.site.supportEmail}` : null,
    `Help centre: ${support}`,
    '',
    'Tap "Talk to our team" and a person will reply here.',
    '',
    'Reply STOP to stop promotional messages.',
  ].filter((l) => l !== null)
  const options = await ctx.reply.buttons(lines.join('\n'), [
    { id: 'handoff', title: 'Talk to our team' },
    { id: 'home', title: 'Main menu' },
  ])
  await save(ctx, { step: 'menu', options })
}

async function startHandoff(ctx: Ctx): Promise<void> {
  const now = Date.now()
  const message = ctx.text.slice(0, 500) || null
  await ctx.env.DB.prepare(
    `INSERT INTO handoffs (site_id, phone, status, message, assigned_to, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, NULL, ?, ?)
     ON CONFLICT (site_id, phone) DO UPDATE SET
       status = 'pending', message = excluded.message, updated_at = excluded.updated_at`,
  )
    .bind(ctx.site.id, ctx.phone, message, now, now)
    .run()
  await emitSiteEvent(ctx.site, 'whatsapp.support_handoff', {
    phone: ctx.phone,
    message,
    createdAt: new Date(now).toISOString(),
  })
  await clearSession(ctx.env, ctx.phone)
  await setConversationMode(ctx.env, { phone: ctx.phone, siteId: ctx.site.id, mode: 'needs_help' })
  await openSupportRequest(ctx.env, { phone: ctx.phone, siteId: ctx.site.id, message })
  await ctx.reply.text(
    'Thanks - a member of our team will reply here shortly.\n\nType your question now. Reply Menu to go back to the bot.',
  )
  const conv = await getConversation(ctx.env, ctx.phone)
  await alertNewRequest(ctx.env, { phone: ctx.phone, siteId: ctx.site.id, name: conv?.name ?? null, message })
}

/** Opens the menu for a customer (used by POST /v1/bot/start). */
export async function startBotFor(env: Env, site: Site, phone: string): Promise<void> {
  await setPhoneSite(env, phone, site.id)
  await clearSession(env, phone)
  await showMenu(ctxFor(env, site, phone, ''))
}

/** Staff finished with a chat: let the bot answer again. */
export async function handBackToBot(env: Env, phone: string, siteId: string): Promise<void> {
  await clearSession(env, phone)
  await setConversationMode(env, { phone, siteId, mode: 'bot' })
  await resolveSupportRequests(env, phone)
  await env.DB.prepare(
    `UPDATE handoffs SET status = 'resolved', updated_at = ? WHERE phone = ? AND status != 'resolved'`,
  )
    .bind(Date.now(), phone)
    .run()
}

/** Staff take a chat: the bot stays silent until handed back (or a quiet day passes). */
export async function takeOverChat(env: Env, phone: string, siteId: string, agent: string): Promise<void> {
  await clearSession(env, phone)
  await setConversationMode(env, { phone, siteId, mode: 'agent', assignedTo: agent })
  await env.DB.prepare(
    `UPDATE handoffs SET status = 'assigned', assigned_to = ?, updated_at = ? WHERE phone = ? AND status = 'pending'`,
  )
    .bind(agent, Date.now(), phone)
    .run()
}

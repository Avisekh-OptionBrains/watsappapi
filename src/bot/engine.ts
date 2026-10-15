import type { Env } from '../env'
import { getCatalog } from '../lib/catalog'
import { emitSiteEvent } from '../lib/events'
import { effectiveMode, getConversation, setConversationMode } from '../lib/conversations'
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
import type { CatalogItem, CatalogSection } from './types'

const GREETING_RE = /^(hi+|hello+|hey+|hii+|start|menu|home|main menu)\b/i
const EXIT_RE = /^(#?(exit|quit|end)|bye)$/i
const HELP_RE = /^(help|support|faq|contact)\b/i
const SIGNIN_RE = /\b(sign ?in|log ?in)\b/i
const ACCOUNT_RE = /\b(my account|account|status|kyc|subscription|my plan)\b/i
const PERSON_RE = /\b(agent|human|person|executive|call me|talk to)\b/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

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

  const catalog = await getCatalog(env, site)
  const section = matchSection(catalog?.sections ?? [], text)
  if (section && !looksLikeQuestion(text)) return showSection(ctx, section.id)

  if (aiAvailable(env, site) && text.length >= 3) return answerWithAi(ctx, section?.id)
  if (section) return showSection(ctx, section.id)
  return showMenu(ctx)
}

/** "what is the price of F&O plan?" deserves an answer, "plans" just the list. */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim()
  return t.includes('?') || t.split(/\s+/).length >= 5 || /^(what|how|why|when|which|can|do|does|is|are|kya|kaise|kab)\b/i.test(t)
}

async function answerWithAi(ctx: Ctx, fallbackSection?: string): Promise<void> {
  const answer = await aiAnswer(ctx.env, ctx.site, ctx.phone)
  if (!answer || answer.action === 'menu') {
    return fallbackSection ? showSection(ctx, fallbackSection) : showMenu(ctx)
  }
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
  if (id.startsWith('sec:')) return showSection(ctx, id.slice(4))
  if (id.startsWith('item:')) {
    const [, sectionId, itemId] = id.split(':')
    return showItem(ctx, sectionId, itemId)
  }
  if (id.startsWith('act:')) {
    const [, sectionId, itemId] = id.split(':')
    return runAction(ctx, sectionId, itemId)
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

async function showMenu(ctx: Ctx): Promise<void> {
  const catalog = await getCatalog(ctx.env, ctx.site)
  const rows: Array<{ id: string; title: string; description?: string }> = []
  for (const s of catalog?.sections ?? []) {
    if (s.items.length) rows.push({ id: `sec:${s.id}`, title: s.title, description: s.description })
  }
  rows.push({ id: 'signin', title: 'Sign in', description: 'Get an email code, then open the website' })
  rows.push({ id: 'account', title: 'My account', description: 'Your status and subscriptions' })
  rows.push({ id: 'help', title: 'Help', description: 'Support or talk to our team' })
  const others = botSites(ctx.env).filter((s) => s.id !== ctx.site.id)
  if (others.length) {
    rows.push({ id: 'switch_site', title: 'Other services', description: others.map((s) => s.name).join(', ') })
  }

  const options = await ctx.reply.list({
    body: `Welcome to ${ctx.site.name}${ctx.site.tagline ? ` - ${ctx.site.tagline}` : ''}.\n\nWhat would you like to do?`,
    button: 'Open menu',
    sectionTitle: 'Main menu',
    rows: rows.slice(0, 10),
    footer: 'Reply Menu anytime to come back here',
  })
  await save(ctx, { step: 'menu', options })
}

async function findSection(ctx: Ctx, sectionId: string): Promise<CatalogSection | null> {
  const catalog = await getCatalog(ctx.env, ctx.site)
  return catalog?.sections.find((s) => s.id === sectionId) ?? null
}

async function showSection(ctx: Ctx, sectionId: string): Promise<void> {
  const section = await findSection(ctx, sectionId)
  if (!section || !section.items.length) {
    await ctx.reply.text('Nothing is listed here right now. Please check the website or try again later.')
    return showMenu(ctx)
  }
  const more = section.items.length > 10 ? `\n\nShowing 10 of ${section.items.length}. See all at ${siteUrl(ctx.site, '/')}` : ''
  const options = await ctx.reply.list({
    body: `${section.title}${section.description ? `\n${section.description}` : ''}\n\nPick one to see details.${more}`,
    button: 'View options',
    sectionTitle: section.title,
    rows: section.items.slice(0, 10).map((item) => ({
      id: `item:${section.id}:${item.id}`,
      title: item.title,
      description: item.subtitle || item.priceLabel,
    })),
  })
  await save(ctx, { step: 'section', sectionId: section.id, options })
}

export function itemDetailText(item: CatalogItem): string {
  return [
    item.title,
    item.priceLabel || null,
    item.body ? `\n${item.body}` : null,
    item.highlights?.length ? `\n${item.highlights.slice(0, 4).map((h) => `• ${h}`).join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

async function showItem(ctx: Ctx, sectionId: string, itemId: string): Promise<void> {
  const section = await findSection(ctx, sectionId)
  const item = section?.items.find((i) => i.id === itemId)
  if (!section || !item) return showMenu(ctx)

  const buttons = [
    ...(item.action ? [{ id: `act:${section.id}:${item.id}`, title: item.action.label }] : []),
    { id: `sec:${section.id}`, title: 'Back' },
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

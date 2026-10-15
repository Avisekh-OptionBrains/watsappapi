import { describe, expect, it } from 'vitest'
import { friendlyOtpError, itemDetailText, matchSection, matchSiteByName, safeSiteLink } from '../src/bot/engine'
import {
  mapOptionBrainsPlans,
  mapOptionBrainsPortfolios,
  mapOptionBrainsStatus,
  optionBrainsIntent,
} from '../src/bot/optionbrains'
import { resolveNumericReply } from '../src/bot/state'
import { parseSites } from '../src/sites'

const [ob, tradepod] = parseSites(
  JSON.stringify([
    { id: 'optionbrains', name: 'OptionBrains', apiKey: 'a'.repeat(32), publicUrl: 'https://www.optionbrains.com' },
    { id: 'tradepod', name: 'TradePod', apiKey: 'b'.repeat(32), publicUrl: 'https://tradepod.in' },
  ]),
)

describe('numeric replies', () => {
  it('maps numbers to the last options shown', () => {
    expect(resolveNumericReply('2', ['sec:plans', 'signin'])).toBe('signin')
    expect(resolveNumericReply('3', ['sec:plans', 'signin'])).toBeNull()
    expect(resolveNumericReply('123456', ['a'])).toBeNull()
    expect(resolveNumericReply('1', undefined)).toBeNull()
  })
})

describe('site / section matching', () => {
  it('matches a brand by name', () => {
    expect(matchSiteByName([ob, tradepod], 'TradePod')?.id).toBe('tradepod')
    expect(matchSiteByName([ob, tradepod], 'optionbrains')?.id).toBe('optionbrains')
    expect(matchSiteByName([ob, tradepod], 'hello')).toBeNull()
  })

  const sections = [
    { id: 'plans', title: 'Research plans', items: [{ id: 'cash', title: 'Cash' }] },
    { id: 'portfolios', title: 'Model portfolios', items: [{ id: 'alpha', title: 'Alpha' }] },
  ]

  it('matches sections by keyword', () => {
    expect(matchSection(sections, 'show me portfolio')?.id).toBe('portfolios')
    expect(matchSection(sections, 'research')?.id).toBe('plans')
    expect(matchSection(sections, 'pricing?')?.id).toBe('plans')
    expect(matchSection(sections, 'random')).toBeNull()
  })
})

describe('links', () => {
  it('only allows https links on the site domain', () => {
    expect(safeSiteLink(ob, 'https://www.optionbrains.com/auth?token=x', '/')).toBe(
      'https://www.optionbrains.com/auth?token=x',
    )
    expect(safeSiteLink(ob, 'https://app.optionbrains.com/x', '/')).toBe('https://app.optionbrains.com/x')
    expect(safeSiteLink(ob, 'https://evil.com/optionbrains.com', '/kyc')).toBe('https://www.optionbrains.com/kyc')
    expect(safeSiteLink(ob, 'http://www.optionbrains.com/x', '/')).toBe('https://www.optionbrains.com/')
    expect(safeSiteLink(ob, 'http://localhost:3000/x', '/')).toBe('https://www.optionbrains.com/')
    expect(safeSiteLink(tradepod, null, '/app')).toBe('https://tradepod.in/app')
  })
})

describe('messages', () => {
  it('maps OTP errors to friendly text', () => {
    expect(friendlyOtpError('Token has expired')).toMatch(/expired/)
    expect(friendlyOtpError('Invalid OTP')).toMatch(/not correct/)
    expect(friendlyOtpError('boom')).toMatch(/could not verify/)
  })

  it('formats item details', () => {
    const text = itemDetailText({ id: 'x', title: 'Cash', priceLabel: 'From ₹999', body: 'Daily ideas', highlights: ['A', 'B'] })
    expect(text).toBe('Cash\nFrom ₹999\n\nDaily ideas\n\n• A\n• B')
  })
})

describe('OptionBrains connector mapping', () => {
  it('maps plans and portfolios into sections', () => {
    const plans = mapOptionBrainsPlans([
      { name: 'All-Access', slug: 'elite', fromPrice: 'From ₹4,999', isTopTier: true, highlights: ['Everything'] },
      { name: 'broken' },
    ])
    expect(plans.items).toHaveLength(1)
    expect(plans.items[0]).toMatchObject({
      id: 'elite',
      subtitle: 'From ₹4,999',
      action: { path: '/buy/elite', signIn: true },
    })
    expect(plans.items[0].highlights).toContain('All-Access includes eligible model portfolios.')

    const portfolios = mapOptionBrainsPortfolios([
      { name: 'Alpha', slug: 'alpha', riskProfile: 'High', cagr: 21.345, monthlyPrice: 1499 },
    ])
    expect(portfolios.items[0].priceLabel).toBe('From ₹1,499 / mo')
    expect(portfolios.items[0].body).toContain('CAGR: 21.3%')
    expect(portfolios.items[0].action?.path).toBe('/model-portfolios/alpha')
  })

  it('maps account status', () => {
    expect(mapOptionBrainsStatus({ found: false })).toEqual({ found: false, summary: [], nextSteps: [] })
    const st = mapOptionBrainsStatus({
      found: true,
      name: 'Asha',
      kycStatus: 'PENDING',
      subscriptions: [{ planName: 'Cash', expiresAt: '2026-12-31T00:00:00Z' }],
      nextSteps: [{ id: 'next_kyc', title: 'Finish KYC', description: 'Complete verification' }],
    })
    expect(st.summary).toEqual(['Verification in progress', 'Active:', '• Cash until 2026-12-31', 'Next: Complete verification'])
    expect(st.nextSteps).toEqual([{ id: 'next_kyc', title: 'Finish KYC', path: '/kyc' }])
  })

  it('derives verify intent from the destination', () => {
    expect(optionBrainsIntent('/buy/elite')).toEqual({ intent: 'buy', productSlug: 'elite' })
    expect(optionBrainsIntent('/kyc')).toEqual({ intent: 'kyc' })
    expect(optionBrainsIntent('/model-portfolios/a')).toEqual({ intent: 'dashboard' })
    expect(optionBrainsIntent(undefined)).toEqual({})
  })
})

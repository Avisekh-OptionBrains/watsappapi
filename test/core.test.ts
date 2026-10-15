import { describe, expect, it } from 'vitest'
import { hmacSha256Hex, safeEqual, verifyMetaSignature } from '../src/lib/crypto'
import { classifyCrmKind, extractInbound, extractStatuses } from '../src/lib/inbound'
import { isValidIndianMobile, toNationalDigits, toWhatsAppRecipient } from '../src/lib/phone'
import { parseSites, siteUrl } from '../src/sites'

const site = (over: Record<string, unknown> = {}) => ({
  id: 'optionbrains',
  name: 'OptionBrains',
  apiKey: 'k'.repeat(32),
  publicUrl: 'https://optionbrains.com',
  ...over,
})

describe('phone', () => {
  it('normalises Indian numbers', () => {
    expect(toNationalDigits('+91 98765 43210')).toBe('9876543210')
    expect(toNationalDigits('919876543210')).toBe('9876543210')
    expect(toWhatsAppRecipient('09876543210')).toBe('919876543210')
    expect(toWhatsAppRecipient('5876543210')).toBeNull()
    expect(isValidIndianMobile('6000000000')).toBe(true)
  })
})

describe('crypto', () => {
  it('compares in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })

  it('verifies Meta signatures', async () => {
    const body = new TextEncoder().encode('{"entry":[]}').buffer as ArrayBuffer
    const sig = await hmacSha256Hex('app-secret', body)
    expect(await verifyMetaSignature('app-secret', body, `sha256=${sig}`)).toBe(true)
    expect(await verifyMetaSignature('other', body, `sha256=${sig}`)).toBe(false)
    expect(await verifyMetaSignature('app-secret', body, undefined)).toBe(false)
    expect(await verifyMetaSignature('first, app-secret', body, `sha256=${sig}`)).toBe(true)
    expect(await verifyMetaSignature('first,second', body, `sha256=${sig}`)).toBe(false)
  })
})

describe('sites', () => {
  it('parses with defaults', () => {
    const [s] = parseSites(JSON.stringify([site()]))
    expect(s.otp).toEqual({ template: 'otp_code', language: 'en_US', copyButton: true })
    expect(siteUrl(s, 'buy/x')).toBe('https://optionbrains.com/buy/x')
  })

  it('rejects duplicates and bad ids', () => {
    expect(() => parseSites(JSON.stringify([site(), site({ apiKey: 'z'.repeat(32) })]))).toThrow(/duplicate id/)
    expect(() => parseSites(JSON.stringify([site(), site({ id: 'tradepod' })]))).toThrow(/duplicate apiKey/)
    expect(() => parseSites(JSON.stringify([site({ id: 'Bad Id' })]))).toThrow(/invalid/)
    expect(() => parseSites('not json')).toThrow(/not valid JSON/)
  })

  it('defaults the bot connector to standard', () => {
    const [s] = parseSites(JSON.stringify([site({ bot: { apiUrl: 'https://x.com/api/wa', apiKey: 'b'.repeat(20) } })]))
    expect(s.bot).toMatchObject({ enabled: true, connector: 'standard' })
  })

  it('uses the site apiKey for the bot and webhook unless overridden', () => {
    const [s] = parseSites(
      JSON.stringify([site({ bot: { apiUrl: 'https://x.com/api/wa' }, webhook: { url: 'https://x.com/api/gw' } })]),
    )
    expect(s.bot?.apiKey).toBe('k'.repeat(32))
    expect(s.webhook?.secret).toBe('k'.repeat(32))
  })
})

describe('inbound', () => {
  it('classifies STOP / START', () => {
    expect(classifyCrmKind('STOP')).toBe('opt_out')
    expect(classifyCrmKind('unsubscribe please')).toBe('opt_out')
    expect(classifyCrmKind('START')).toBe('opt_in')
    expect(classifyCrmKind('subscribe')).toBe('message')
    expect(classifyCrmKind('how do I subscribe?')).toBe('message')
  })

  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }],
              messages: [
                { from: '919876543210', id: 'wamid.1', type: 'text', text: { body: ' hi ' } },
                {
                  from: '919876543210',
                  id: 'wamid.2',
                  type: 'interactive',
                  interactive: { list_reply: { id: 'sec:plans', title: 'Research plans' } },
                },
                { from: '919876543210', id: 'wamid.3', type: 'image', image: { id: 'm1' } },
              ],
              statuses: [
                { id: 'wamid.out', status: 'delivered', recipient_id: '919876543210' },
                { id: 'wamid.out2', status: 'played' },
                { id: 'wamid.out3', status: 'deleted' },
              ],
            },
          },
        ],
      },
    ],
  }

  it('extracts messages', () => {
    const msgs = extractInbound(payload)
    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toMatchObject({ text: 'hi', interactiveId: null, profileName: 'Asha' })
    expect(msgs[1]).toMatchObject({ text: 'Research plans', interactiveId: 'sec:plans' })
    expect(msgs[2]).toMatchObject({ text: '[image]', type: 'image' })
  })

  it('extracts statuses and drops unknown ones', () => {
    expect(extractStatuses(payload).map((s) => s.status)).toEqual(['delivered', 'read'])
    expect(extractStatuses(null)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { scrubLinks } from '../src/bot/ai'
import { looksLikeQuestion } from '../src/bot/engine'
import { normalizeTag, parseTags } from '../src/lib/conversations'
import { extractInbound } from '../src/lib/inbound'
import { mediaKindFor } from '../src/lib/meta'
import { buildTemplateMessage, toTemplateInfo } from '../src/lib/templates'
import { parseSites } from '../src/sites'

const [site] = parseSites(
  JSON.stringify([{ id: 'optionbrains', name: 'OptionBrains', apiKey: 'a'.repeat(32), publicUrl: 'https://www.optionbrains.com' }]),
)

const offer = toTemplateInfo({
  name: 'festive_offer',
  language: 'en_US',
  category: 'MARKETING',
  status: 'APPROVED',
  components: [
    { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
    { type: 'BODY', text: 'Get {{1}} off with code {{2}}. Valid till {{3}}.' },
    { type: 'FOOTER', text: 'Reply STOP to opt out' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'URL', text: 'Open offer', url: 'https://optionbrains.com/offer/{{1}}' },
        { type: 'COPY_CODE', text: 'Copy code' },
        { type: 'QUICK_REPLY', text: 'Not interested' },
      ],
    },
  ],
})

describe('templates', () => {
  it('lists the blanks staff must fill', () => {
    expect(offer.header).toEqual({ format: 'TEXT', text: 'Hi {{1}}', vars: ['1'] })
    expect(offer.bodyVars).toEqual(['1', '2', '3'])
    expect(offer.buttons.map((b) => b.needsValue)).toEqual([true, true, false])
  })

  it('builds Meta components and a readable preview', () => {
    const { components, preview } = buildTemplateMessage(offer, {
      'header.1': 'Asha',
      'body.1': '20%',
      'body.2': 'DIWALI',
      'body.3': '5 Nov',
      'button.0': 'diwali',
      'button.1': 'DIWALI',
    })
    expect(components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: 'Asha' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: '20%' },
          { type: 'text', text: 'DIWALI' },
          { type: 'text', text: '5 Nov' },
        ],
      },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'diwali' }] },
      { type: 'button', sub_type: 'copy_code', index: '1', parameters: [{ type: 'coupon_code', coupon_code: 'DIWALI' }] },
    ])
    expect(preview).toContain('Get 20% off with code DIWALI. Valid till 5 Nov.')
    expect(preview).toContain('[Button: Not interested]')
  })

  it('refuses to send with a blank missing', () => {
    expect(() => buildTemplateMessage(offer, { 'header.1': 'Asha' })).toThrow(/Fill in/)
  })

  it('supports named parameters and media headers', () => {
    const t = toTemplateInfo({
      name: 'kyc_update',
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
      parameter_format: 'NAMED',
      components: [
        { type: 'HEADER', format: 'DOCUMENT' },
        { type: 'BODY', text: 'Hi {{customer_name}}, your KYC is {{status}}.' },
      ],
    })
    expect(() => buildTemplateMessage(t, { 'body.customer_name': 'A', 'body.status': 'done', headerMedia: 'http://x' })).toThrow(/https/)
    const { components } = buildTemplateMessage(t, {
      'body.customer_name': 'Asha',
      'body.status': 'approved',
      headerMedia: 'https://optionbrains.com/kyc.pdf',
    })
    expect(components[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'document', document: { link: 'https://optionbrains.com/kyc.pdf' } }],
    })
    expect(components[1]).toEqual({
      type: 'body',
      parameters: [
        { type: 'text', parameter_name: 'customer_name', text: 'Asha' },
        { type: 'text', parameter_name: 'status', text: 'approved' },
      ],
    })
  })
})

describe('media', () => {
  it('reads photos with captions and documents from webhooks', () => {
    const msgs = extractInbound({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '919811100001', profile: { name: 'Asha' } }],
                messages: [
                  { from: '919811100001', id: 'm1', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'my PAN card' } },
                  { from: '919811100001', id: 'm2', type: 'document', document: { id: 'media-2', mime_type: 'application/pdf', filename: 'kyc.pdf' } },
                  { from: '919811100001', id: 'm3', type: 'audio', audio: { id: 'media-3', mime_type: 'audio/ogg' } },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(msgs.map((m) => [m.text, m.media])).toEqual([
      ['my PAN card', { id: 'media-1', mime: 'image/jpeg', name: null }],
      ['[document]', { id: 'media-2', mime: 'application/pdf', name: 'kyc.pdf' }],
      ['[audio]', { id: 'media-3', mime: 'audio/ogg', name: null }],
    ])
  })

  it('picks the WhatsApp type for uploads', () => {
    expect(mediaKindFor('image/png')).toBe('image')
    expect(mediaKindFor('image/gif')).toBe('document')
    expect(mediaKindFor('video/mp4')).toBe('video')
    expect(mediaKindFor('audio/mpeg')).toBe('audio')
    expect(mediaKindFor('application/pdf')).toBe('document')
  })
})

describe('tags', () => {
  it('normalises and parses tags', () => {
    expect(normalizeTag('  VIP Customer! ')).toBe('vip-customer')
    expect(parseTags('["vip","kyc"]')).toEqual(['vip', 'kyc'])
    expect(parseTags('not json')).toEqual([])
  })
})

describe('AI guard rails', () => {
  it('only keeps links on the site domain', () => {
    expect(scrubLinks(site, 'See https://optionbrains.com/plans and https://evil.example/x')).toBe(
      'See https://optionbrains.com/plans and https://www.optionbrains.com',
    )
    expect(scrubLinks(site, 'http://optionbrains.com/plans')).toBe('https://www.optionbrains.com')
  })

  it('treats real questions differently from menu words', () => {
    expect(looksLikeQuestion('plans')).toBe(false)
    expect(looksLikeQuestion('what is the price of F&O plan?')).toBe(true)
    expect(looksLikeQuestion('kya refund milega')).toBe(true)
  })
})

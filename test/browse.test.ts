import { describe, expect, it } from 'vitest'
import { bestHit, normalizeText, pageForIndex, pageOf, searchCatalog } from '../src/bot/browse'
import { itemDetailText, menuSectionRows, pagedRows } from '../src/bot/engine'
import type { CatalogSection } from '../src/bot/types'

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('paging', () => {
  it('keeps short lists on one page', () => {
    expect(pageOf(range(10), 0)).toMatchObject({ items: range(10), hasPrev: false, hasNext: false })
  })

  it('splits long lists so every item is reachable', () => {
    for (const total of [11, 18, 19, 25, 40, 61]) {
      const seen: number[] = []
      for (let p = 0; ; p++) {
        const pg = pageOf(range(total), p)
        expect(pg.items.length + Number(pg.hasPrev) + Number(pg.hasNext)).toBeLessThanOrEqual(10)
        seen.push(...pg.items)
        for (const i of pg.items) expect(pageForIndex(total, i)).toBe(p)
        if (!pg.hasNext) break
      }
      expect(seen).toEqual(range(total))
    }
  })

  it('clamps pages past the end', () => {
    expect(pageOf(range(25), 99)).toMatchObject({ page: 2, items: [17, 18, 19, 20, 21, 22, 23, 24], hasNext: false })
    expect(pageOf(range(25), -1).page).toBe(0)
  })

  it('adds previous / next rows', () => {
    const { rows, range: label } = pagedRows(range(25), 1, (i) => ({ id: `i${i}`, title: `#${i}` }), (p) => `p:${p}`)
    expect(rows.map((r) => r.id)).toEqual(['i9', 'i10', 'i11', 'i12', 'i13', 'i14', 'i15', 'i16', 'p:0', 'p:2'])
    expect(label).toBe('Showing 10-17 of 25.')
  })
})

describe('main menu', () => {
  const section = (id: string, n = 2): CatalogSection => ({
    id,
    title: id,
    items: range(n).map((i) => ({ id: `${id}${i}`, title: `${id} ${i}` })),
  })

  it('lists every category when there is room', () => {
    expect(menuSectionRows([section('a'), section('b'), section('empty', 0)], 6).map((r) => r.id)).toEqual(['sec:a', 'sec:b'])
  })

  it('turns the last slot into "All products" when categories do not fit', () => {
    const rows = menuSectionRows(range(8).map((i) => section(`s${i}`)), 6)
    expect(rows).toHaveLength(6)
    expect(rows[5]).toMatchObject({ id: 'catalog', description: '8 categories, 16 options' })
  })
})

describe('catalog search', () => {
  const sections: CatalogSection[] = [
    {
      id: 'plans',
      title: 'Research plans',
      items: [
        { id: 'cash-research', title: 'Cash Research', priceLabel: 'From ₹999' },
        { id: 'fno-research', title: 'F&O Research' },
        { id: 'elite', title: 'All-Access', subtitle: 'Everything included' },
      ],
    },
    {
      id: 'portfolios',
      title: 'Model portfolios',
      items: [
        { id: 'alpha-momentum', title: 'Alpha Momentum' },
        { id: 'alpha-value', title: 'Alpha Value' },
      ],
    },
  ]

  it('normalises F&O spellings', () => {
    expect(normalizeText('F&O plan')).toBe('fno plan')
    expect(normalizeText('f and o')).toBe('fno')
    expect(normalizeText('F & O!')).toBe('fno')
  })

  it('opens a product named in the message', () => {
    expect(bestHit(searchCatalog(sections, 'F&O plan price'))?.item.id).toBe('fno-research')
    expect(bestHit(searchCatalog(sections, 'fno'))?.item.id).toBe('fno-research')
    expect(bestHit(searchCatalog(sections, 'tell me about alpha momentum returns'))?.item.id).toBe('alpha-momentum')
    expect(bestHit(searchCatalog(sections, 'elite'))?.item.id).toBe('elite')
  })

  it('lists several matches instead of guessing', () => {
    const hits = searchCatalog(sections, 'alpha')
    expect(hits.map((h) => h.item.id).sort()).toEqual(['alpha-momentum', 'alpha-value'])
    expect(bestHit(hits)).toBeNull()
  })

  it('ignores filler words and unrelated text', () => {
    expect(searchCatalog(sections, 'show me the price please')).toEqual([])
    expect(searchCatalog(sections, 'my payment failed')).toEqual([])
  })
})

describe('product detail', () => {
  it('fits long descriptions into one message and keeps the highlights', () => {
    const text = itemDetailText({
      id: 'x',
      title: 'Cash',
      priceLabel: 'From ₹999',
      body: 'word '.repeat(400),
      highlights: range(10).map((i) => `Point ${i}`),
    })
    expect(text.length).toBeLessThanOrEqual(1000)
    expect(text).toContain('…')
    expect(text).toContain('• Point 7')
    expect(text).not.toContain('• Point 8')
  })
})

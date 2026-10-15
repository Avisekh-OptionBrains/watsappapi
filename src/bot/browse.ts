import type { CatalogItem, CatalogSection } from './types'

/** WhatsApp lists hold 10 rows; longer lists get "Previous" / "Next" rows instead of being cut off. */
export const LIST_ROWS = 10

export type Page<T> = { items: T[]; page: number; start: number; hasPrev: boolean; hasNext: boolean }

function layout(total: number, page: number, start: number) {
  const hasPrev = page > 0
  const room = LIST_ROWS - (hasPrev ? 1 : 0)
  const hasNext = total - start > room
  return { hasPrev, hasNext, count: hasNext ? room - 1 : room }
}

export function pageOf<T>(all: T[], page: number): Page<T> {
  const want = Math.max(0, Math.floor(page) || 0)
  let start = 0
  for (let p = 0; ; p++) {
    const { hasPrev, hasNext, count } = layout(all.length, p, start)
    if (p >= want || !hasNext) return { items: all.slice(start, start + count), page: p, start, hasPrev, hasNext }
    start += count
  }
}

/** Page that shows the item at `index` (for "Back" from a product). */
export function pageForIndex(total: number, index: number): number {
  let start = 0
  for (let p = 0; ; p++) {
    const { hasNext, count } = layout(total, p, start)
    if (index < start + count || !hasNext) return p
    start += count
  }
}

/** Lowercase words only; "F&O" / "f and o" become "fno" so they match each other. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b([a-z])\s*(?:&|\band\b)\s*([a-z])\b/g, '$1n$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const STOP_WORDS = new Set(
  `a an the and or of for to in on at by with from about me my i we you your our is are was be do does
   can could would want need show tell give get see send know details detail info information price prices
   pricing cost plan plans buy please pls kya hai ka ki ke mujhe chahiye batao`.split(/\s+/),
)

export type CatalogHit = {
  section: CatalogSection
  item: CatalogItem
  score: number
  /** Every searched word was found. */
  all: boolean
  /** The message names the product (all words of its title). */
  exact: boolean
}

function wordMatch(word: string, hay: string[]): boolean {
  return hay.some(
    (h) => h === word || (word.length >= 4 && h.length >= 4 && (h.startsWith(word) || word.startsWith(h))),
  )
}

/** Products whose name / id / subtitle match the customer's words, best first. */
export function searchCatalog(sections: CatalogSection[], text: string, limit = LIST_ROWS): CatalogHit[] {
  const query = normalizeText(text)
  const queryWords = query.split(' ').filter(Boolean)
  const words = [...new Set(queryWords.filter((w) => w.length >= 2 && !STOP_WORDS.has(w)))]
  if (!words.length || words.length > 8) return []

  const hits: CatalogHit[] = []
  for (const section of sections) {
    for (const item of section.items) {
      const title = normalizeText(item.title)
      const hay = [title, normalizeText(item.id), normalizeText(item.subtitle ?? '')].join(' ').split(' ').filter(Boolean)
      const matched = words.filter((w) => wordMatch(w, hay)).length
      if (!matched || matched / words.length < 0.5) continue
      const titleWords = title.split(' ').filter((w) => w && !STOP_WORDS.has(w))
      const exact = title === query || (titleWords.length > 0 && titleWords.every((w) => wordMatch(w, queryWords)))
      const all = matched === words.length
      hits.push({ section, item, all, exact, score: matched * 10 + (all ? 20 : 0) + (exact ? 40 : 0) })
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** One clear winner: open it directly instead of asking. */
export function bestHit(hits: CatalogHit[]): CatalogHit | null {
  const [top, next] = hits
  if (!top || !(top.exact || top.all)) return null
  return !next || top.score > next.score ? top : null
}

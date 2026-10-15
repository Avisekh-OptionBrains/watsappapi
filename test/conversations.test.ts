import { describe, expect, it } from 'vitest'
import { canReplyFreely, effectiveMode } from '../src/lib/conversations'

const HOUR = 60 * 60 * 1000
const now = 1_800_000_000_000

describe('conversation mode', () => {
  it('keeps staff modes for a day, then returns to the bot', () => {
    expect(effectiveMode(null, now)).toBe('bot')
    expect(effectiveMode({ mode: 'agent', mode_at: now - 2 * HOUR }, now)).toBe('agent')
    expect(effectiveMode({ mode: 'needs_help', mode_at: now - 23 * HOUR }, now)).toBe('needs_help')
    expect(effectiveMode({ mode: 'agent', mode_at: now - 25 * HOUR }, now)).toBe('bot')
    expect(effectiveMode({ mode: 'weird', mode_at: now }, now)).toBe('bot')
  })

  it('allows free-form replies only within 24 h of the last customer message', () => {
    expect(canReplyFreely(null, now)).toBe(false)
    expect(canReplyFreely({ last_inbound_at: null }, now)).toBe(false)
    expect(canReplyFreely({ last_inbound_at: now - 23 * HOUR }, now)).toBe(true)
    expect(canReplyFreely({ last_inbound_at: now - 25 * HOUR }, now)).toBe(false)
  })
})

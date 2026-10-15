import type { Env } from '../env'
import { canReplyFreely, effectiveMode, getConversation, parseTags, type ConversationRow } from '../lib/conversations'
import { recipientOr400 } from './util'

export const DAY_MS = 24 * 60 * 60 * 1000

export function toChat(row: ConversationRow) {
  const mode = effectiveMode(row)
  return {
    phone: row.phone,
    site: row.site_id,
    name: row.name,
    mode,
    assignedTo: mode === 'bot' ? null : row.assigned_to,
    lastText: row.last_text,
    lastAuthor: row.last_author,
    lastMessageAt: row.last_message_at,
    lastInboundAt: row.last_inbound_at,
    unread: row.unread,
    tags: parseTags(row.tags),
    canReply: canReplyFreely(row),
  }
}

export function siteFilter(site: string | undefined, column = 'site_id'): { sql: string; args: string[] } {
  return site ? { sql: ` AND ${column} = ?`, args: [site] } : { sql: '', args: [] }
}

export async function chatFor(env: Env, raw: string) {
  const phone = recipientOr400(raw)
  return { phone, conv: await getConversation(env, phone) }
}

export type MessageRow = {
  id: string
  site_id: string
  direction: string
  author: string
  agent: string | null
  type: string
  text: string | null
  status: string | null
  error: string | null
  media_id: string | null
  media_mime: string | null
  media_name: string | null
  created_at: number
}

export function toMessage(m: MessageRow) {
  return {
    id: m.id,
    site: m.site_id,
    direction: m.direction,
    author: m.author,
    agent: m.agent,
    type: m.type,
    text: m.text,
    status: m.status,
    error: m.error,
    media: m.media_id ? { id: m.media_id, mime: m.media_mime, name: m.media_name } : null,
    at: m.created_at,
  }
}

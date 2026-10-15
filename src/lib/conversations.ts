import type { Env } from '../env'

export type ConversationMode = 'bot' | 'needs_help' | 'agent'
export type Author = 'customer' | 'bot' | 'agent' | 'system' | 'campaign'

const DAY_MS = 24 * 60 * 60 * 1000

export type ConversationRow = {
  phone: string
  site_id: string
  name: string | null
  mode: string
  mode_at: number
  assigned_to: string | null
  last_text: string | null
  last_author: string | null
  last_message_at: number
  last_inbound_at: number | null
  unread: number
  tags: string
  created_at: number
}

export type ChatMedia = { id: string; mime: string | null; name: string | null }

export function parseTags(raw: string | null | undefined): string[] {
  try {
    const tags = JSON.parse(raw || '[]')
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** Lowercase, short, no duplicates: "VIP " -> "vip". */
export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 24)
}

/** Staff modes fall back to the bot after a quiet day so no customer is left unanswered. */
export function effectiveMode(conv: Pick<ConversationRow, 'mode' | 'mode_at'> | null, now = Date.now()): ConversationMode {
  if (!conv) return 'bot'
  if (conv.mode !== 'bot' && now - conv.mode_at > DAY_MS) return 'bot'
  return conv.mode === 'needs_help' || conv.mode === 'agent' ? conv.mode : 'bot'
}

/** Meta only delivers free-form text within 24 h of the customer's last message. */
export function canReplyFreely(conv: Pick<ConversationRow, 'last_inbound_at'> | null, now = Date.now()): boolean {
  return Boolean(conv?.last_inbound_at && now - conv.last_inbound_at < DAY_MS)
}

export async function getConversation(env: Env, phone: string): Promise<ConversationRow | null> {
  return env.DB.prepare('SELECT * FROM conversations WHERE phone = ?').bind(phone).first<ConversationRow>()
}

export async function recordInboundChat(
  env: Env,
  msg: {
    id: string
    phone: string
    siteId: string
    type: string
    text: string
    name: string | null
    media?: ChatMedia | null
  },
): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO chat_messages
         (id, phone, site_id, direction, author, type, text, media_id, media_mime, media_name, created_at)
       VALUES (?, ?, ?, 'in', 'customer', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      msg.id,
      msg.phone,
      msg.siteId,
      msg.type,
      msg.text.slice(0, 4096),
      msg.media?.id ?? null,
      msg.media?.mime ?? null,
      msg.media?.name ?? null,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO conversations
         (phone, site_id, name, mode, mode_at, last_text, last_author, last_message_at, last_inbound_at, unread, created_at)
       VALUES (?, ?, ?, 'bot', ?, ?, 'customer', ?, ?, 1, ?)
       ON CONFLICT (phone) DO UPDATE SET
         site_id = excluded.site_id,
         name = COALESCE(excluded.name, conversations.name),
         last_text = excluded.last_text,
         last_author = 'customer',
         last_message_at = excluded.last_message_at,
         last_inbound_at = excluded.last_inbound_at,
         unread = conversations.unread + 1`,
    ).bind(msg.phone, msg.siteId, msg.name, now, msg.text.slice(0, 200), now, now, now),
  ])
}

/**
 * Adds an outbound message to the transcript. Bot and staff replies open a conversation;
 * OTPs, website messages and campaigns only show up in chats that already exist.
 */
export async function recordOutboundChat(
  env: Env,
  msg: {
    id: string
    phone: string
    siteId: string
    author: Author
    agent?: string | null
    type: string
    text: string
    media?: ChatMedia | null
  },
): Promise<void> {
  const now = Date.now()
  const opens = msg.author === 'bot' || msg.author === 'agent'
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO chat_messages
         (id, phone, site_id, direction, author, agent, type, text, status, media_id, media_mime, media_name, created_at)
       VALUES (?, ?, ?, 'out', ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
    ).bind(
      msg.id,
      msg.phone,
      msg.siteId,
      msg.author,
      msg.agent ?? null,
      msg.type,
      msg.text.slice(0, 4096),
      msg.media?.id ?? null,
      msg.media?.mime ?? null,
      msg.media?.name ?? null,
      now,
    ),
    opens
      ? env.DB.prepare(
          `INSERT INTO conversations
             (phone, site_id, mode, mode_at, last_text, last_author, last_message_at, unread, created_at)
           VALUES (?, ?, 'bot', ?, ?, ?, ?, 0, ?)
           ON CONFLICT (phone) DO UPDATE SET
             last_text = excluded.last_text, last_author = excluded.last_author,
             last_message_at = excluded.last_message_at`,
        ).bind(msg.phone, msg.siteId, now, msg.text.slice(0, 200), msg.author, now, now)
      : env.DB.prepare(
          `UPDATE conversations SET last_text = ?, last_author = ?, last_message_at = ? WHERE phone = ?`,
        ).bind(msg.text.slice(0, 200), msg.author, now, msg.phone),
  ])
}

export async function setConversationMode(
  env: Env,
  opts: { phone: string; siteId: string; mode: ConversationMode; assignedTo?: string | null },
): Promise<void> {
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO conversations (phone, site_id, mode, mode_at, assigned_to, last_message_at, unread, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (phone) DO UPDATE SET
       mode = excluded.mode, mode_at = excluded.mode_at, assigned_to = excluded.assigned_to`,
  )
    .bind(opts.phone, opts.siteId, opts.mode, now, opts.mode === 'bot' ? null : (opts.assignedTo ?? null), now, now)
    .run()
}

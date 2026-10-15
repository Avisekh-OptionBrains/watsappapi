import type { Env } from '../env'
import { sendButtons, sendCtaUrl, sendList, sendText, type ListRow, type ReplyButton, type SendResult } from '../lib/meta'
import { recordOutbound } from '../lib/outbound'
import type { Site } from '../sites'

export type Replier = ReturnType<typeof createReplier>

function withOptions(body: string, options: Array<{ title: string }>): string {
  return options.length ? `${body}\n\n${options.map((o, i) => `${i + 1}. ${o.title}`).join('\n')}` : body
}

/**
 * Sends bot replies to one customer and records them against the conversation's site.
 * `label` marks the sender in the transcript (e.g. "AI").
 */
export function createReplier(env: Env, site: Site, phone: string, label?: string) {
  async function track(sent: SendResult, text: string) {
    if (!sent.ok) {
      console.warn('[bot] send failed', site.id, sent.status, sent.message)
      return
    }
    await recordOutbound(env, site, { messageId: sent.messageId, phone, kind: 'text', text, author: 'bot', agent: label })
  }

  return {
    async text(body: string) {
      await track(await sendText(env, phone, body), body)
    },
    /** Returns the row ids so numeric replies can be mapped back. */
    async list(opts: { body: string; button: string; sectionTitle: string; rows: ListRow[]; footer?: string }) {
      const rows = opts.rows.slice(0, 10)
      await track(await sendList(env, phone, { ...opts, rows }), withOptions(opts.body, rows))
      return rows.map((r) => r.id)
    },
    async buttons(body: string, buttons: ReplyButton[]) {
      const shown = buttons.slice(0, 3)
      await track(await sendButtons(env, phone, { body, buttons: shown }), withOptions(body, shown))
      return shown.map((b) => b.id)
    },
    async cta(opts: { body: string; label: string; url: string; sensitive?: boolean }) {
      // Sign-in links are one-time credentials; keep them out of the transcript.
      await track(await sendCtaUrl(env, phone, opts), `${opts.body}\n\n[Button: ${opts.label}]`)
    },
  }
}

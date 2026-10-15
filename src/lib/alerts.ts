import type { Env } from '../env'

export type StaffAlert = { title: string; text: string; phone?: string }

function dashboardLink(env: Env, phone?: string): string | null {
  const base = env.DASHBOARD_URL?.replace(/\/$/, '')
  if (!base) return null
  return phone ? `${base}/admin/#/inbox/${phone}` : `${base}/admin/`
}

export function alertsConfigured(env: Env): boolean {
  return Boolean(
    (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) ||
      env.ALERT_WEBHOOK_URL ||
      (env.RESEND_API_KEY && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO),
  )
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** Telegram, chat webhook and email — whichever are configured. Never throws. */
export async function notifyStaff(env: Env, alert: StaffAlert): Promise<void> {
  const link = dashboardLink(env, alert.phone)
  const message = [alert.title, alert.text, link].filter(Boolean).join('\n\n')
  const jobs: Array<[string, Promise<void>]> = []

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push([
      'telegram',
      post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    ])
  }
  if (env.ALERT_WEBHOOK_URL) {
    // `text` for Slack / Google Chat, `content` for Discord.
    jobs.push(['webhook', post(env.ALERT_WEBHOOK_URL, { text: message, content: message.slice(0, 2000) })])
  }
  if (env.RESEND_API_KEY && env.ALERT_EMAIL_FROM && env.ALERT_EMAIL_TO) {
    jobs.push([
      'email',
      post(
        'https://api.resend.com/emails',
        {
          from: env.ALERT_EMAIL_FROM,
          to: env.ALERT_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
          subject: alert.title,
          text: message,
        },
        { Authorization: `Bearer ${env.RESEND_API_KEY}` },
      ),
    ])
  }

  const results = await Promise.allSettled(jobs.map(([, job]) => job))
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn('[alerts]', jobs[i][0], 'failed', String(r.reason))
  })
}

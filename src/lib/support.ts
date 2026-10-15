import type { Env } from '../env'
import { getSite } from '../sites'
import { notifyStaff } from './alerts'
import { newId } from './crypto'

/** Customer asked for a person. Closes any older open request first. */
export async function openSupportRequest(
  env: Env,
  opts: { phone: string; siteId: string; message: string | null },
): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('UPDATE support_requests SET resolved_at = ? WHERE phone = ? AND resolved_at IS NULL').bind(
      now,
      opts.phone,
    ),
    env.DB.prepare(
      `INSERT INTO support_requests (id, phone, site_id, message, requested_at) VALUES (?, ?, ?, ?, ?)`,
    ).bind(newId(), opts.phone, opts.siteId, opts.message, now),
  ])
}

/** First staff message on an open request (response-time reports). */
export async function markStaffReplied(env: Env, phone: string, staff: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE support_requests SET first_reply_at = ?, first_reply_by = ?
     WHERE phone = ? AND resolved_at IS NULL AND first_reply_at IS NULL`,
  )
    .bind(Date.now(), staff, phone)
    .run()
}

export async function resolveSupportRequests(env: Env, phone: string): Promise<void> {
  await env.DB.prepare('UPDATE support_requests SET resolved_at = ? WHERE phone = ? AND resolved_at IS NULL')
    .bind(Date.now(), phone)
    .run()
}

export async function alertNewRequest(
  env: Env,
  opts: { phone: string; siteId: string; name: string | null; message: string | null },
): Promise<void> {
  const site = getSite(env, opts.siteId)
  await notifyStaff(env, {
    title: `${site?.name ?? opts.siteId}: customer needs help`,
    text: `${opts.name ? `${opts.name} ` : ''}(+${opts.phone})${opts.message ? `\n“${opts.message.slice(0, 300)}”` : ''}`,
    phone: opts.phone,
  })
}

/** Cron: alert once more about customers still waiting without any staff reply. */
export async function escalateWaiting(env: Env): Promise<number> {
  const minutes = Number(env.ALERT_ESCALATE_MINUTES ?? 10)
  if (!(minutes > 0)) return 0
  const now = Date.now()
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.phone, r.site_id, r.message, r.requested_at, v.name
     FROM support_requests r LEFT JOIN conversations v ON v.phone = r.phone
     WHERE r.resolved_at IS NULL AND r.first_reply_at IS NULL AND r.escalated_at IS NULL
       AND r.requested_at < ? AND r.requested_at > ?
     ORDER BY r.requested_at LIMIT 20`,
  )
    .bind(now - minutes * 60_000, now - 24 * 60 * 60 * 1000)
    .all<{ id: string; phone: string; site_id: string; message: string | null; requested_at: number; name: string | null }>()
  for (const r of results) {
    const waited = Math.round((now - r.requested_at) / 60_000)
    await notifyStaff(env, {
      title: `Still waiting ${waited} min: ${getSite(env, r.site_id)?.name ?? r.site_id}`,
      text: `${r.name ? `${r.name} ` : ''}(+${r.phone}) has had no reply yet.${r.message ? `\n“${r.message.slice(0, 300)}”` : ''}`,
      phone: r.phone,
    })
    await env.DB.prepare('UPDATE support_requests SET escalated_at = ? WHERE id = ?').bind(now, r.id).run()
  }
  return results.length
}

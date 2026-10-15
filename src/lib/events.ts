import type { Site } from '../sites'

export type SiteEvent =
  | 'whatsapp.crm'
  | 'whatsapp.outbound'
  | 'whatsapp.status'
  | 'whatsapp.support_handoff'

/**
 * Posts a gateway event to the site's webhook. Body shape is `{ event, site, payload, ts }`,
 * authenticated with the `x-webhook-secret` header. Sites without a webhook are skipped.
 */
export async function emitSiteEvent(
  site: Site | null,
  event: SiteEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!site?.webhook) return
  try {
    const res = await fetch(site.webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': site.webhook.secret,
      },
      body: JSON.stringify({ event, site: site.id, payload, ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      console.warn('[events] site rejected event', site.id, event, res.status)
    }
  } catch (err) {
    console.warn('[events] site webhook unreachable', site.id, event, err instanceof Error ? err.message : err)
  }
}

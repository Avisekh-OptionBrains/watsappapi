import { config } from '../config'

/** Notify ob-research of a gateway event. Missing URL is a no-op. */
export async function forwardToObResearch(event: string, payload: unknown): Promise<void> {
  if (!config.obResearchWebhookUrl) return
  try {
    const res = await fetch(config.obResearchWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.obResearchWebhookSecret
          ? { 'x-webhook-secret': config.obResearchWebhookSecret }
          : {}),
      },
      body: JSON.stringify({ event, payload, ts: new Date().toISOString() }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('[research-webhook] ob-research rejected event', event, res.status, text.slice(0, 300))
    }
  } catch (err) {
    console.error('[research-webhook] forward to ob-research failed', event, err)
  }
}

import type { Env } from '../env'
import type { BridgeEvent, WebhookSubscription } from '@shared/types'

// Cache subscriptions for 30s to avoid D1 reads on every event
let cachedSubscriptions: WebhookSubscription[] | null = null
let subscriptionsCachedAt = 0
const SUBSCRIPTION_CACHE_TTL = 30_000

async function getActiveSubscriptions(db: D1Database): Promise<WebhookSubscription[]> {
  const now = Date.now()
  if (cachedSubscriptions && now - subscriptionsCachedAt < SUBSCRIPTION_CACHE_TTL) {
    return cachedSubscriptions
  }
  const result = await db.prepare('SELECT * FROM webhook_subscriptions WHERE active = 1').all<WebhookSubscription>()
  cachedSubscriptions = result.results
  subscriptionsCachedAt = now
  return cachedSubscriptions
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return 'sha256=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function dispatchEvent(env: Env, event: BridgeEvent): Promise<{ dispatched: number; failed: number }> {
  const subscriptions = await getActiveSubscriptions(env.DB)

  // Filter to subscriptions that want this event type
  const matching = subscriptions.filter(sub => {
    const events: string[] = JSON.parse(sub.events)
    return events.includes(event.type) || events.includes('*')
  })

  if (matching.length === 0) return { dispatched: 0, failed: 0 }

  const body = JSON.stringify(event)
  let dispatched = 0
  let failed = 0

  for (const sub of matching) {
    try {
      const signature = await signPayload(sub.secret, body)

      const resp = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Signature': signature,
          'X-Bridge-Event': event.type,
          'X-Bridge-Delivery': event.id,
        },
        body,
      })

      const statusCode = resp.status
      const isSuccess = statusCode >= 200 && statusCode < 300

      // Update subscription status
      if (isSuccess) {
        await env.DB.prepare(
          "UPDATE webhook_subscriptions SET last_triggered_at = datetime('now'), last_status_code = ?, failure_count = 0 WHERE id = ?"
        ).bind(statusCode, sub.id).run()
        dispatched++
      } else {
        // R2 fix: Use SQL increment instead of stale cached failure_count
        const updateResult = await env.DB.prepare(
          `UPDATE webhook_subscriptions
           SET failure_count = failure_count + 1, last_triggered_at = datetime('now'), last_status_code = ?
           WHERE id = ?
           RETURNING failure_count`
        ).bind(statusCode, sub.id).first<{ failure_count: number }>()

        if (updateResult && updateResult.failure_count >= 10) {
          await env.DB.prepare('UPDATE webhook_subscriptions SET active = 0 WHERE id = ?').bind(sub.id).run()
          cachedSubscriptions = null
        }
        failed++
      }
    } catch (err) {
      console.error(`Webhook dispatch to ${sub.url} failed:`, err)
      // R2 fix: Use SQL increment instead of stale cached failure_count
      const updateResult = await env.DB.prepare(
        `UPDATE webhook_subscriptions
         SET failure_count = failure_count + 1, last_triggered_at = datetime('now'), last_status_code = 0
         WHERE id = ?
         RETURNING failure_count`
      ).bind(sub.id).first<{ failure_count: number }>()

      if (updateResult && updateResult.failure_count >= 10) {
        await env.DB.prepare('UPDATE webhook_subscriptions SET active = 0 WHERE id = ?').bind(sub.id).run()
        cachedSubscriptions = null
      }
      failed++
    }
  }

  return { dispatched, failed }
}

// Helper to generate event IDs
export function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

// Clear subscription cache (called after CRUD operations)
export function clearSubscriptionCache(): void {
  cachedSubscriptions = null
}

// Pre-warms the poster_meals_cache for every active booking.
// Invoked by the Cloudflare Cron Trigger (every minute) and by the
// POST /api/admin/warm-cache endpoint for manual testing.
//
// Strategy:
//   1. Query D1 for all bookings with a poster_client_id that are still
//      active or already synced (guests currently in-house or recently so).
//   2. For each (posterClientId, date) pair — today and yesterday — fetch
//      fresh meal data from Poster and upsert into poster_meals_cache.
//   3. Cap concurrency at 5 to respect Poster's rate limits.
//   4. Swallow individual errors so one bad guest doesn't abort the run.
//   5. Record a summary row in activity_log for dashboard visibility.

import type { Env } from '../env'
import { fetchMealsForClient } from './meals-cache'
import { PosterClient } from './poster'

const CONCURRENCY = 5

async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: string }> = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.allSettled(batch.map(fn))
    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push({ ok: true, value: r.value })
      } else {
        results.push({
          ok: false,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        })
      }
    }
  }
  return results
}

export async function warmMealsCache(env: Env): Promise<{
  warmed: number
  errors: number
  durationMs: number
}> {
  const start = Date.now()

  const today = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

  const bookings = await env.DB.prepare(
    `SELECT clock_booking_id, poster_client_id
     FROM bookings
     WHERE poster_client_id IS NOT NULL
       AND status IN ('active', 'synced')`,
  ).all<{ clock_booking_id: string; poster_client_id: number }>()

  const targets = bookings.results.flatMap((b) => [
    { posterClientId: b.poster_client_id, date: today },
    { posterClientId: b.poster_client_id, date: yesterday },
  ])

  const results = await processInBatches(targets, CONCURRENCY, async (target) => {
    const data = await fetchMealsForClient(env, target.posterClientId, target.date)
    await env.DB.prepare(
      "INSERT OR REPLACE INTO poster_meals_cache (cache_key, data, cached_at) VALUES (?, ?, datetime('now'))",
    )
      .bind(`${target.posterClientId}:${target.date}`, JSON.stringify(data))
      .run()
    return data.items.length
  })

  const warmed = results.filter((r) => r.ok).length
  const errors = results.filter((r) => !r.ok).length
  const durationMs = Date.now() - start

  // Only record anomalies in activity_log — successful fast warms would
  // otherwise generate 1440 rows/day and drown real events in noise.
  if (errors > 0 || durationMs > 5000) {
    await env.DB.prepare(
      'INSERT INTO activity_log (type, summary, payload) VALUES (?, ?, ?)',
    )
      .bind(
        'cache_warmed',
        `Pre-warmed cache: ${warmed} entries, ${errors} errors, ${durationMs}ms`,
        JSON.stringify({ warmed, errors, durationMs }),
      )
      .run()
  }

  return { warmed, errors, durationMs }
}

/**
 * Warm the KV `live_orders_snapshot` key with today's flattened order items.
 * Called by the cron trigger every 60s so SSE streams and the dashboard orders
 * endpoint can read from KV (~5ms) instead of hitting Poster directly (3 API
 * calls). This reduces Poster API usage from 90 calls/min per SSE client to
 * 3 calls/min total regardless of how many clients are connected.
 */
export async function warmOrdersSnapshot(env: Env): Promise<void> {
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const today = new Date().toISOString().split('T')[0]

  const [detailed, products, dashTxns] = await Promise.all([
    poster.getDetailedTransactions(today, today, 500),
    poster.getProducts(),
    poster.getTransactions(
      today.replace(/-/g, ''),
      today.replace(/-/g, ''),
    ),
  ])

  const productMap = new Map(
    products.map((p) => [
      String(p.product_id),
      (p.product_name || '').replace(/^food_/, ''),
    ]),
  )

  const clientNames = new Map<string, string>()
  const spotNames = new Map<string, string>()
  // transactions.getTransactions (detailed) returns client_id=0 for most
  // rows, so we can't use it to attribute punches to clients directly.
  // dash.getTransactions does carry the real client_id — build a
  // transaction_id → client_id map so each detailed row can be attributed.
  const clientIdByTxn = new Map<number, string>()
  const dashArr = Array.isArray(dashTxns) ? dashTxns : []

  // Poster mixes timestamp formats: dash.getTransactions uses unix-ms
  // strings ("1776400559048"); transactions.getTransactions uses
  // "YYYY-MM-DD HH:MM:SS". Normalize to ISO 8601 for comparison + display.
  function toIso(raw: string | undefined): string | null {
    if (!raw || raw === '0') return null
    const ms = Number(raw)
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString()
    if (raw.includes('-')) return raw.replace(' ', 'T')
    return null
  }

  for (const t of dashArr) {
    if (
      t.client_id &&
      t.client_id !== '0' &&
      (t.client_firstname || t.client_lastname)
    ) {
      clientNames.set(
        t.client_id,
        `${t.client_lastname || ''} ${t.client_firstname || ''}`.trim(),
      )
    }
    if (t.spot_id && t.name) {
      spotNames.set(String(t.spot_id), t.name.trim())
    }
    if (t.client_id && t.client_id !== '0' && t.transaction_id) {
      clientIdByTxn.set(Number(t.transaction_id), t.client_id)
    }
  }

  // Last punch per client (BAC-1149).
  //
  // For CLOSED transactions, `date_close` from the detailed feed is the real
  // close timestamp — static and correct.
  //
  // For OPEN transactions we need true per-item punch time. Poster's
  // `transactions.getTransactions.date_close` happens to move on punch events
  // but the name is misleading and the contract isn't documented. The
  // authoritative source is `dash.getTransactionHistory(txnId)` which returns
  // a per-event log (`additem`, `open`, `close`, `sign`, …) with unix-ms
  // timestamps. We take max(event.time) across all entries so any activity
  // counts as a punch.
  //
  // Cost: +1 Poster call per open transaction per cron tick (~30/min at
  // peak). Well under the API budget.
  const lastPunchByClient: Record<string, string> = {}

  for (const t of detailed) {
    const clientIdStr = clientIdByTxn.get(t.transaction_id)
    if (!clientIdStr) continue
    const iso = toIso(t.date_close)
    if (!iso) continue
    const prior = lastPunchByClient[clientIdStr]
    if (!prior || iso > prior) {
      lastPunchByClient[clientIdStr] = iso
    }
  }

  const openTxnsWithClients: Array<{ transactionId: number; clientId: string }> = []
  for (const t of dashArr) {
    if (t.status !== '1') continue
    if (!t.client_id || t.client_id === '0') continue
    if (!t.transaction_id) continue
    openTxnsWithClients.push({
      transactionId: Number(t.transaction_id),
      clientId: t.client_id,
    })
  }

  const HISTORY_CONCURRENCY = 5
  const historyResults = await processInBatches(
    openTxnsWithClients,
    HISTORY_CONCURRENCY,
    async ({ transactionId, clientId }) => {
      const history = await poster.getTransactionHistory(String(transactionId))
      let maxMs = 0
      for (const ev of history || []) {
        const ms = Number(ev.time)
        if (Number.isFinite(ms) && ms > maxMs) maxMs = ms
      }
      return { clientId, maxMs }
    },
  )
  for (const r of historyResults) {
    if (!r.ok) continue
    const { clientId, maxMs } = r.value
    if (!maxMs) continue
    const iso = new Date(maxMs).toISOString()
    const prior = lastPunchByClient[clientId]
    if (!prior || iso > prior) {
      lastPunchByClient[clientId] = iso
    }
  }

  const items: Array<{
    id: string
    time: string
    productId: number
    productName: string
    quantity: number
    price: number
    table: number
    location: string
    clientName: string | null
    clientId: number | null
    transactionId: number
  }> = []

  for (const t of detailed) {
    const location = spotNames.get(String(t.spot_id)) || 'Unknown'
    const clientName = clientNames.get(String(t.client_id)) || null

    for (let i = 0; i < (t.products || []).length; i++) {
      const p = t.products[i]
      const productIdStr = String(p.product_id)
      items.push({
        id: `${t.transaction_id}-${i}`,
        time: t.date_close,
        productId: p.product_id,
        productName:
          productMap.get(productIdStr) || `Product #${productIdStr}`,
        quantity: Number(p.num || 1),
        price: Number(p.product_sum || 0),
        table: t.table_id,
        location,
        clientName,
        clientId: t.client_id || null,
        transactionId: t.transaction_id,
      })
    }
  }

  items.sort((a, b) => a.time.localeCompare(b.time))

  await env.CONFIG.put(
    'live_orders_snapshot',
    JSON.stringify({
      date: today,
      items,
      updatedAt: new Date().toISOString(),
      openOrders: dashArr.filter((t) => t.status === '1').length,
      closedOrders: dashArr.filter((t) => t.status === '2').length,
      lastPunchByClient,
      // Keep the old key around for one deploy so the /users endpoint can
      // roll over without a blank "Last Punch" column during the transition.
      lastOrderByClient: lastPunchByClient,
    }),
  )
}

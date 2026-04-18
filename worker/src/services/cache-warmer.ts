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
import { buildOrdersSnapshot, writeSnapshotToKv } from './orders-feed'
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
 *
 * Thin wrapper around orders-feed — the build/write logic lives there so the
 * /api/dashboard/orders fallback and SSE fetchTodayItemsLive can share it.
 */
export async function warmOrdersSnapshot(env: Env): Promise<void> {
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const today = new Date().toISOString().split('T')[0]

  const snapshot = await buildOrdersSnapshot(poster, { today })
  await writeSnapshotToKv(env.CONFIG, snapshot)
}

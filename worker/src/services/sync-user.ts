// On-demand sync for a single FitKoh user (BAC-1065 step 3).
//
// Called by `POST /api/v1/sync/user` from the FitKoh backend when a user taps
// "Sync with Poster" on their profile. Complements the cron path in
// `auto-importer.ts`; both converge on the same `source_id` format so FitKoh's
// `addItemLog` dedup (ON CONFLICT DO NOTHING on source_id) makes repeated calls
// idempotent across cron + on-demand triggers.
//
// Flow:
//   1. Load item mapping (poster_product_id -> fitkohMenuItemId) from KV.
//   2. Fetch closed + open Poster bills for the date range.
//   3. Filter to bills where client_id == posterClientId.
//   4. For each bill, pull per-line products via dash.getTransactionProducts
//      and sort by time ASC (same discipline as the cron) so the positional
//      line index matches the cron's source_id exactly.
//   5. Dispatch each mapped line to FitKoh via collaborate.logItemForClient.
//      Unmapped products are collected into `unmappedProductIds` and skipped.
//   6. Return aggregated counters + errors.

import type { Env } from '../env'
import { PosterClient } from './poster'

export interface SyncUserInput {
  fitkohUserId: number
  posterClientId: number
  dateFrom?: string // YYYY-MM-DD; defaults to today - 30d
  dateTo?: string // YYYY-MM-DD; defaults to today
}

export interface SyncUserResult {
  imported: number
  skipped: number
  errors: number
  scanned: number
  unmappedProductIds: string[]
}

const DEFAULT_WINDOW_DAYS = 30

function ymd(d: Date): string {
  return d.toISOString().split('T')[0]
}

function toCompact(ymdStr: string): string {
  return ymdStr.replace(/-/g, '')
}

function punchInIsoOrFallback(
  punchInMs: string | undefined,
  dateCloseIct: string | undefined,
  fallbackDate: string,
): string {
  const ms = Number(punchInMs)
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString()
  const parts = (dateCloseIct || '').split(' ')
  const timeStr = parts[1] || '12:00:00'
  return `${parts[0] || fallbackDate}T${timeStr}+07:00`
}

async function logToFitkoh(
  env: Env,
  params: {
    fitkohUserId: number
    fitkohMenuItemId: number
    sourceId: string
    logTime: string
    quantity: number
  },
): Promise<void> {
  if (!env.FITKOH_API_URL || !env.FITKOH_API_KEY) {
    throw new Error('FITKOH_API_URL / FITKOH_API_KEY not configured')
  }
  const body = {
    json: {
      ownerId: params.fitkohUserId,
      menuItemId: params.fitkohMenuItemId,
      logDate: params.logTime.slice(0, 10),
      logTime: params.logTime,
      quantity: params.quantity || 1,
      itemType: 'food',
      sourceId: params.sourceId,
    },
  }
  const resp = await fetch(
    `${env.FITKOH_API_URL}/api/trpc/collaborate.logItemForClient`,
    {
      method: 'POST',
      headers: {
        'x-api-key': env.FITKOH_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(
      `FitKoh logItemForClient ${resp.status}: ${text.slice(0, 200)}`,
    )
  }
}

export async function syncUserFromPoster(
  env: Env,
  input: SyncUserInput,
): Promise<SyncUserResult> {
  const result: SyncUserResult = {
    imported: 0,
    skipped: 0,
    errors: 0,
    scanned: 0,
    unmappedProductIds: [],
  }

  // 1. Resolve date window (defaults: last 30 days ending today).
  const today = new Date()
  const dateTo = input.dateTo || ymd(today)
  const defaultFrom = new Date(today.getTime())
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - DEFAULT_WINDOW_DAYS)
  const dateFrom = input.dateFrom || ymd(defaultFrom)

  // 2. Load item mapping from KV.
  const itemRaw = await env.CONFIG.get('poster_to_fitkoh_items')
  const itemMapping: Record<string, number> = itemRaw ? JSON.parse(itemRaw) : {}

  // 3. Fetch Poster bills (closed + open) for the window.
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const clientIdStr = String(input.posterClientId)

  const [closedTxns, openTxns] = await Promise.all([
    poster.getDetailedTransactions(dateFrom, dateTo, 500),
    poster.getOpenTransactions(toCompact(dateFrom), toCompact(dateTo)),
  ])

  // 4. Filter to this user's bills (client_id comparison normalized to string).
  const closedForUser = closedTxns.filter(
    (t) => String(t.client_id) === clientIdStr,
  )
  const openForUser = openTxns.filter(
    (t) => String(t.client_id) === clientIdStr,
  )
  result.scanned = closedForUser.length + openForUser.length

  if (result.scanned === 0) return result

  // 5. Build sorted-line list per transaction (single source of truth for
  //    product_id + time + num + price — same as auto-importer).
  const linesByTx = new Map<
    number,
    Array<{ product_id: string; num: string; product_sum: string; time: string }>
  >()
  const dateCloseByTx = new Map<number, string | undefined>()

  for (const t of closedForUser) {
    dateCloseByTx.set(t.transaction_id, t.date_close)
  }

  const txIds = new Set<number>()
  for (const t of closedForUser) txIds.add(t.transaction_id)
  for (const t of openForUser) txIds.add(Number(t.transaction_id))

  for (const txId of txIds) {
    try {
      const raw = await poster.getTransactionProducts(txId)
      const sorted = [...raw].sort((a, b) => Number(a.time) - Number(b.time))
      linesByTx.set(txId, sorted)
    } catch (err) {
      console.error(`sync-user: failed to fetch products for tx ${txId}:`, err)
      result.errors++
    }
  }

  const unmappedSeen = new Set<string>()

  // 6. Dispatch each line.
  for (const txId of txIds) {
    const lines = linesByTx.get(txId)
    if (!lines) continue
    const dateCloseFallback = dateCloseByTx.get(txId)

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const productIdStr = String(l.product_id)
      const fitkohMenuItemId = itemMapping[productIdStr] ?? null

      if (fitkohMenuItemId == null) {
        if (!unmappedSeen.has(productIdStr)) {
          unmappedSeen.add(productIdStr)
          result.unmappedProductIds.push(productIdStr)
        }
        result.skipped++
        continue
      }

      // Same format as auto-importer: `poster:<clientId>:<txId>:<lineIndex>`.
      // FitKoh's addItemLog dedups atomically on source_id, so repeated syncs
      // (or a cron tick that already picked the same bill) are no-ops.
      const sourceId = `poster:${clientIdStr}:${txId}:${i}`
      const logTime = punchInIsoOrFallback(l.time, dateCloseFallback, dateTo)

      try {
        await logToFitkoh(env, {
          fitkohUserId: input.fitkohUserId,
          fitkohMenuItemId,
          sourceId,
          logTime,
          quantity: Number(l.num || 1),
        })
        result.imported++
      } catch (err) {
        console.error(`sync-user: dispatch failed for ${sourceId}:`, err)
        result.errors++
      }
    }
  }

  return result
}

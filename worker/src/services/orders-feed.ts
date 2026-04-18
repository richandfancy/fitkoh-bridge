// Orders-feed service — single source of truth for the "live orders snapshot"
// that the cron writes to KV and the dashboard/SSE read.
//
// Why this module exists:
//   The build-and-flatten logic previously lived inline inside
//   `warmOrdersSnapshot` (cron path) and was duplicated — with subtle drift —
//   in the `/api/dashboard/orders` HTTP fallback and again in the SSE
//   `fetchTodayItemsLive`. Any shape change had to land in three places.
//
// Consumers depend on the exact KV snapshot shape:
//   - client/src/pages/Orders.tsx reads `items[]` (via the HTTP endpoint)
//   - client/src/pages/Users.tsx sort relies on `lastPunchByClient`
//   - stream.ts reads `items[]` and dispatches per-item deltas
//
// Anything that changes the `OrdersSnapshot` shape below MUST be audited
// against those three callers before shipping.

import { captureMessage } from '@sentry/cloudflare'

import type { PosterClient } from './poster'

// Flattened live order item (one row per product line across all of today's
// transactions). Sorted oldest-first inside the snapshot; consumers may
// reverse for display.
export interface LiveOrderItem {
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
}

// Full KV snapshot shape. Wire-compatible with the payload written by the
// legacy inline implementation; any field change breaks the frontend.
export interface OrdersSnapshot {
  date: string
  items: LiveOrderItem[]
  updatedAt: string
  openOrders: number
  closedOrders: number
  // Per-client most-recent punch timestamp (ISO 8601). Drives the Guests tab
  // sort on UsersPage (BAC-1149). See buildOrdersSnapshot() for derivation.
  lastPunchByClient: Record<string, string>
  // Legacy alias kept for one deploy of back-compat during rollout. Readers
  // should prefer `lastPunchByClient`.
  lastOrderByClient: Record<string, string>
}

// KV key the cron writes to and every reader pulls from.
export const ORDERS_SNAPSHOT_KEY = 'live_orders_snapshot'

// Max age before a KV snapshot is considered stale. Matches the previous
// inline thresholds in api.ts and stream.ts (90s — the cron fires every 60s,
// so any value >60s absorbs a missed tick, <120s still feels "live").
export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 90_000

// Poster mixes timestamp formats: dash.getTransactions uses unix-ms strings
// ("1776400559048"); transactions.getTransactions uses "YYYY-MM-DD HH:MM:SS";
// dash.getTransactionHistory.time is also unix-ms. Normalize to ISO 8601 so
// callers can compare and display without branching per source.
//
// Exported for unit tests (BAC-1221). The Poster-date fallback uses a strict
// date-shape check (`YYYY-MM-DD`) — the older `raw.includes('-')` check was
// a silent foot-gun that accepted e.g. `"-1"` and returned it verbatim into
// the sort key. No in-production callers pass negative-number strings, so
// this is behavior-preserving for real data but closes a silent-bug shape
// the tests explicitly cover.
export function toIso(raw: string | undefined): string | null {
  if (!raw || raw === '0') return null
  const ms = Number(raw)
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString()
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.replace(' ', 'T')
  return null
}

// Internal helper: run an async fn across `items` with bounded concurrency.
// Mirrors the processInBatches() in cache-warmer.ts but returns settle results
// so one bad transaction doesn't abort the snapshot build.
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

const HISTORY_CONCURRENCY = 5

/**
 * Build a complete OrdersSnapshot for a single date (YYYY-MM-DD).
 *
 * Data sources:
 *   - `transactions.getTransactions` (detailed): per-line products with
 *     table/spot IDs but `client_id=0` on most rows.
 *   - `menu.getProducts`: product_id → human name.
 *   - `dash.getTransactions`: real client_id + client name + spot names.
 *   - `dash.getTransactionHistory` (per open txn): authoritative per-event
 *     punch log for computing `lastPunchByClient` on bills that haven't
 *     closed yet.
 *
 * Costs ~3 Poster calls + N extra history calls where N = open transactions
 * with a client attached (typically 0–30 at peak).
 *
 * TODO(BAC-1221): add tests covering
 *   - timestamp-format normalization via toIso()
 *   - client_id attribution via the dashArr → clientIdByTxn map
 *   - lastPunchByClient merging closed (date_close) + open (history) events
 *   - shop-POS transactions that share the cafe spot (see .ai/LEARNINGS.md)
 */
export async function buildOrdersSnapshot(
  poster: PosterClient,
  opts: { today: string },
): Promise<OrdersSnapshot> {
  const { today } = opts
  const compact = today.replace(/-/g, '')

  const [detailed, products, dashTxns] = await Promise.all([
    poster.getDetailedTransactions(today, today, 500),
    poster.getProducts(),
    poster.getTransactions(compact, compact),
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

  const items: LiveOrderItem[] = []

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

  return {
    date: today,
    items,
    updatedAt: new Date().toISOString(),
    openOrders: dashArr.filter((t) => t.status === '1').length,
    closedOrders: dashArr.filter((t) => t.status === '2').length,
    lastPunchByClient,
    // Keep the old key around for one deploy so the /users endpoint can
    // roll over without a blank "Last Punch" column during the transition.
    lastOrderByClient: lastPunchByClient,
  }
}

/**
 * Read the cached snapshot from KV, returning null if missing or stale.
 *
 * Staleness is checked against `updatedAt` (not the requested date) so a
 * yesterday-key lingering in KV won't be served as today.
 *
 * TODO(BAC-1221): add tests covering
 *   - missing key
 *   - stale snapshot (updatedAt > maxAgeMs)
 *   - date mismatch (today ≠ snapshot.date)
 *   - malformed JSON
 */
export async function readSnapshotFromKv(
  kv: KVNamespace,
  opts: { today: string; maxAgeMs?: number },
): Promise<OrdersSnapshot | null> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS
  try {
    const raw = await kv.get(ORDERS_SNAPSHOT_KEY)
    if (!raw) return null
    const snapshot = JSON.parse(raw) as OrdersSnapshot
    if (snapshot.date !== opts.today) return null
    const age = Date.now() - new Date(snapshot.updatedAt).getTime()
    if (!Number.isFinite(age) || age >= maxAgeMs) return null
    return snapshot
  } catch {
    return null
  }
}

// How long a prior non-empty snapshot remains "authoritative" for the purposes
// of suppressing an empty overwrite (BAC-1218). Longer than the 90s read
// staleness threshold because even a stale-for-reads snapshot is still better
// than nuking the whole feed on a single transient Poster blank response.
const EMPTY_OVERWRITE_PROTECTION_MS = 5 * 60 * 1000

function isSnapshotEmpty(snapshot: OrdersSnapshot): boolean {
  const hasItems = snapshot.items.length > 0
  const hasPunches = Object.keys(snapshot.lastPunchByClient ?? {}).length > 0
  return !hasItems && !hasPunches
}

/**
 * Persist a built snapshot to KV. Plain JSON, no TTL — the cron keeps it
 * fresh and readers treat `updatedAt` as the source of truth for staleness.
 *
 * BAC-1218 guard: if the incoming snapshot is fully empty (no items AND no
 * lastPunchByClient entries) we refuse to overwrite a recent non-empty
 * snapshot already in KV. Poster occasionally returns a blank payload for a
 * single tick (observed during auth blips and their own transient 5xx); the
 * cron would otherwise wipe the live feed and every SSE listener would see
 * an empty dashboard for up to 60s.
 *
 * The guard only kicks in when ALL of these hold:
 *   1. New snapshot is empty (items.length === 0 && no lastPunchByClient).
 *   2. A prior snapshot exists in KV.
 *   3. Prior snapshot is non-empty.
 *   4. Prior snapshot's updatedAt is within EMPTY_OVERWRITE_PROTECTION_MS.
 *
 * On skip we emit a `captureMessage('empty-poster-response', 'warning')` so
 * we can track frequency without paging anyone.
 */
export async function writeSnapshotToKv(
  kv: KVNamespace,
  snapshot: OrdersSnapshot,
): Promise<void> {
  if (isSnapshotEmpty(snapshot)) {
    const existingRaw = await kv.get(ORDERS_SNAPSHOT_KEY)
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as OrdersSnapshot
        const existingAge =
          Date.now() - new Date(existing.updatedAt).getTime()
        if (
          !isSnapshotEmpty(existing) &&
          Number.isFinite(existingAge) &&
          existingAge >= 0 &&
          existingAge < EMPTY_OVERWRITE_PROTECTION_MS
        ) {
          captureMessage('empty-poster-response', {
            level: 'warning',
            tags: {
              subsystem: 'cron',
              reason: 'skipped-empty-snapshot-overwrite',
            },
          })
          return
        }
      } catch {
        // Malformed KV contents: fall through and overwrite — a corrupt
        // snapshot is worse than an empty one.
      }
    }
  }
  await kv.put(ORDERS_SNAPSHOT_KEY, JSON.stringify(snapshot))
}

// Auto-detects new Poster orders and dispatches them as webhook events.
// Called by the Cloudflare Cron Trigger (after cache warming) and by
// POST /api/admin/auto-import for manual testing.
//
// Two entry points:
//   - autoImportNewMeals(env)       -- cron path, fetches transactions from Poster
//   - importItemsForUser(env, items) -- SSE path, uses already-detected LiveItems
//
// Flow:
//   1. Load user mapping (poster_client_id -> fitkohUserId) from KV
//   2. Load item mapping (poster_product_id -> fitkohMenuItemId) from KV
//   3. Fetch today's detailed transactions from Poster (cron) or use passed items (SSE)
//   4. Filter to mapped users, map products
//   5. Deduplicate against D1 (auto_imported_items table)
//   6. Dispatch webhook events to all registered subscribers
//   7. Record dispatched items in D1

import type { Env } from '../env'
import { PosterClient } from './poster'

interface UserMapping {
  fitkohUserId: number
  name: string
}

interface DispatchableItem {
  id: string
  posterClientId: number
  posterProductId: string
  productName: string
  quantity: number
  price: number
  fitkohMenuItemId: number | null
  fitkohUserId: number
  transactionId: number
  logTime: string
}

// ---------------------------------------------------------------------------
// Module-level KV cache -- avoids hammering KV every 2s from the SSE path
// ---------------------------------------------------------------------------

// Convert a Poster per-line punch-in timestamp (unix ms as string) to an ISO
// instant. If the line is missing a time, fall back to the bill close time
// (date_close is " YYYY-MM-DD HH:MM:SS " in ICT +07:00).
function punchInIsoOrFallback(
  punchInMs: string | undefined,
  dateCloseIct: string | undefined,
  today: string,
): string {
  const ms = Number(punchInMs)
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString()
  const parts = (dateCloseIct || '').split(' ')
  const timeStr = parts[1] || '12:00:00'
  return `${parts[0] || today}T${timeStr}+07:00`
}

let cachedUserMapping: Record<string, UserMapping> | null = null
let cachedItemMapping: Record<string, number> | null = null
let mappingsCachedAt = 0
const MAPPING_CACHE_TTL = 60_000 // 1 minute

async function getMappings(env: Env): Promise<{
  userMapping: Record<string, UserMapping> | null
  itemMapping: Record<string, number> | null
}> {
  const now = Date.now()
  if (
    cachedUserMapping &&
    cachedItemMapping &&
    now - mappingsCachedAt < MAPPING_CACHE_TTL
  ) {
    return { userMapping: cachedUserMapping, itemMapping: cachedItemMapping }
  }
  const [userRaw, itemRaw] = await Promise.all([
    env.CONFIG.get('poster_to_fitkoh_users'),
    env.CONFIG.get('poster_to_fitkoh_items'),
  ])
  cachedUserMapping = userRaw ? JSON.parse(userRaw) : null
  cachedItemMapping = itemRaw ? JSON.parse(itemRaw) : null
  mappingsCachedAt = now
  return { userMapping: cachedUserMapping, itemMapping: cachedItemMapping }
}

export async function autoImportNewMeals(env: Env): Promise<{
  checked: number
  dispatched: number
  skipped: number
  errors: number
}> {
  const EMPTY = { checked: 0, dispatched: 0, skipped: 0, errors: 0 }

  // 1. Load mappings from KV (cached)
  const { userMapping, itemMapping } = await getMappings(env)
  if (!userMapping || !itemMapping) return EMPTY

  const mappedClientIds = new Set(Object.keys(userMapping))

  // 2. Get today's date
  const today = new Date().toISOString().split('T')[0]

  // 3. Fetch today's transactions from Poster.
  // Closed bills come from transactions.getTransactions with inline products.
  // Open bills come from dash.getTransactions?status=1; we fetch per-line
  // products separately for the mapped ones so a mapped diner's meal is
  // dispatched the moment it's punched in, not when the bill closes.
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const todayCompact = today.replace(/-/g, '')
  const [closedTxns, openTxns, products] = await Promise.all([
    poster.getDetailedTransactions(today, today, 500),
    poster.getOpenTransactions(todayCompact, todayCompact),
    poster.getProducts(),
  ])

  const productMap = new Map(
    products.map((p) => [
      String(p.product_id),
      (p.product_name || '').replace(/^food_/, ''),
    ]),
  )

  // 4. Find new items for mapped users.
  //
  // We used to cross-reference two Poster endpoints (transactions.getTransactions
  // for products, dash.getTransactionProducts for times) by array index. That's
  // broken: the two endpoints return the same products in OPPOSITE orders, so
  // each line got the time of another line on the same bill.
  //
  // Fix: dash.getTransactionProducts is now the single source of truth for
  // product_id + time + num + price. Lines are sorted by time ascending before
  // assigning the positional index, which keeps dedup keys stable across ticks.
  const dispatchableItems: DispatchableItem[] = []
  const productLinesByTx = new Map<number, Array<{ product_id: string; num: string; product_sum: string; time: string }>>()

  async function getSortedLines(transactionId: number) {
    let lines = productLinesByTx.get(transactionId)
    if (!lines) {
      const raw = await poster.getTransactionProducts(transactionId)
      lines = [...raw].sort((a, b) => Number(a.time) - Number(b.time))
      productLinesByTx.set(transactionId, lines)
    }
    return lines
  }

  const itemMap = itemMapping // narrow the ?null to a stable local ref for the inner fn
  const userMap = userMapping
  function buildItemsForBill(clientIdStr: string, txId: number, lines: Array<{ product_id: string; num: string; product_sum: string; time: string }>, dateCloseFallback: string | undefined) {
    const fitkohUserId = userMap[clientIdStr]?.fitkohUserId
    if (!fitkohUserId) return // defensive: mappedClientIds was derived from userMap; this should never trigger
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const productIdStr = String(l.product_id)
      const fitkohMenuItemId = itemMap[productIdStr] ?? null
      const productName = productMap.get(productIdStr) || `Product #${productIdStr}`

      dispatchableItems.push({
        id: `${clientIdStr}:${txId}:${i}`,
        posterClientId: Number(clientIdStr),
        posterProductId: productIdStr,
        productName,
        quantity: Number(l.num || 1),
        price: Number(l.product_sum || 0),
        fitkohMenuItemId,
        fitkohUserId,
        transactionId: txId,
        logTime: punchInIsoOrFallback(l.time, dateCloseFallback, today),
      })
    }
  }

  // 4a. Closed bills.
  for (const t of closedTxns) {
    const clientIdStr = String(t.client_id)
    if (!mappedClientIds.has(clientIdStr)) continue

    const lines = await getSortedLines(t.transaction_id)
    buildItemsForBill(clientIdStr, t.transaction_id, lines, t.date_close)
  }

  // 4b. Open bills — same path, dedup guarantees no redispatch when the bill
  // later appears as closed (same transactionId, same product-index assignment
  // because lines are deterministically sorted by time).
  for (const t of openTxns) {
    const clientIdStr = String(t.client_id)
    if (!mappedClientIds.has(clientIdStr)) continue

    const txId = Number(t.transaction_id)
    const lines = await getSortedLines(txId)
    buildItemsForBill(clientIdStr, txId, lines, undefined)
  }

  const totalChecked = closedTxns.length + openTxns.length
  if (dispatchableItems.length === 0) {
    return { checked: totalChecked, dispatched: 0, skipped: 0, errors: 0 }
  }

  const { dispatched, errors } = await deduplicateAndDispatch(env, dispatchableItems)

  return {
    checked: totalChecked,
    dispatched,
    skipped: dispatchableItems.length - dispatched - errors,
    errors,
  }
}

// ---------------------------------------------------------------------------
// SSE entry point -- uses already-detected LiveItems from the stream
// ---------------------------------------------------------------------------

export async function importItemsForUser(
  env: Env,
  newItems: Array<{
    id: string
    productId: number
    productName: string
    quantity: number
    price: number
    time: string
    transactionId: number
    clientId?: number | null
  }>,
): Promise<number> {
  if (newItems.length === 0) return 0

  const { userMapping, itemMapping } = await getMappings(env)
  if (!userMapping || !itemMapping) return 0

  const today = new Date().toISOString().split('T')[0]
  const mappedClientIds = new Set(Object.keys(userMapping))
  const dispatchableItems: DispatchableItem[] = []

  // The SSE stream's payload is positionally unreliable (its productIndex was
  // built from transactions.getTransactions order, which is the reverse of
  // dash.getTransactionProducts). We ignore it and rebuild the full set of
  // lines for each affected transaction from dash.getTransactionProducts,
  // sorted by time so dedup indices match the cron path's indices.
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const linesByTx = new Map<number, Array<{ product_id: string; num: string; product_sum: string; time: string }>>()
  const txsToFetch = new Set<number>()

  for (const item of newItems) {
    const clientIdStr = item.clientId != null ? String(item.clientId) : null
    if (clientIdStr && mappedClientIds.has(clientIdStr)) {
      txsToFetch.add(item.transactionId)
    }
  }

  const mappedClientByTx = new Map<number, string>()
  for (const item of newItems) {
    const clientIdStr = item.clientId != null ? String(item.clientId) : null
    if (clientIdStr && mappedClientIds.has(clientIdStr)) {
      mappedClientByTx.set(item.transactionId, clientIdStr)
    }
  }

  for (const txId of txsToFetch) {
    const raw = await poster.getTransactionProducts(txId)
    const lines = [...raw].sort((a, b) => Number(a.time) - Number(b.time))
    linesByTx.set(txId, lines)

    const clientIdStr = mappedClientByTx.get(txId)!
    const fitkohUserId = userMapping[clientIdStr]?.fitkohUserId
    if (!fitkohUserId) continue
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      const productIdStr = String(l.product_id)
      const fitkohMenuItemId = itemMapping[productIdStr] ?? null

      dispatchableItems.push({
        id: `${clientIdStr}:${txId}:${i}`,
        posterClientId: Number(clientIdStr),
        posterProductId: productIdStr,
        productName: `Product #${productIdStr}`,
        quantity: Number(l.num || 1),
        price: Number(l.product_sum || 0),
        fitkohMenuItemId,
        fitkohUserId,
        transactionId: txId,
        logTime: punchInIsoOrFallback(l.time, undefined, today),
      })
    }
  }

  if (dispatchableItems.length === 0) return 0

  const { dispatched } = await deduplicateAndDispatch(env, dispatchableItems)
  return dispatched
}

// ---------------------------------------------------------------------------
// Shared: dedup against D1 -> log to FitKoh trainer endpoint -> record in D1
//
// BAC-1068: The bridge authenticates to FitKoh as a trainer user (via
// X-API-Key on tRPC), and calls collaborate.logItemForClient directly.
// Replaces the previous webhook dispatcher: one auth model, one permissions
// model (shared_access), one audit trail per FitKoh's user table.
// ---------------------------------------------------------------------------

async function logToFitkoh(
  env: Env,
  item: DispatchableItem,
): Promise<void> {
  if (!env.FITKOH_API_URL || !env.FITKOH_API_KEY) {
    throw new Error('FITKOH_API_URL / FITKOH_API_KEY not configured')
  }
  if (item.fitkohMenuItemId == null) {
    // No menu mapping — nothing to log. Treated as success so the dedup
    // row stays claimed and we don't re-try every tick for unmapped items.
    return
  }
  const logDate = item.logTime.slice(0, 10)
  const body = {
    json: {
      ownerId: item.fitkohUserId,
      menuItemId: item.fitkohMenuItemId,
      logDate,
      logTime: item.logTime,
      quantity: item.quantity || 1,
      itemType: 'food',
      // BAC-1071: idempotency key, identical to this row's bridge D1 id
      // (`clientId:txId:lineIndex`). Retries after a lost response resolve
      // to the same FitKoh row via ON CONFLICT DO NOTHING on source_id.
      sourceId: `poster:${item.id}`,
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
    throw new Error(`FitKoh logItemForClient ${resp.status}: ${text.slice(0, 200)}`)
  }
}

async function deduplicateAndDispatch(
  env: Env,
  items: DispatchableItem[],
): Promise<{ dispatched: number; errors: number }> {
  // R1 fix: Use atomic INSERT OR IGNORE to prevent race conditions where
  // cron + SSE paths could both SELECT "not exists" and double-dispatch.
  // INSERT first, then dispatch only if the insert actually wrote a new row.
  let dispatched = 0
  let errors = 0

  for (const item of items) {
    try {
      // Attempt to claim this item atomically
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO auto_imported_items (id, poster_client_id, fitkoh_user_id, fitkoh_menu_item_id, poster_product_name) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        item.id,
        item.posterClientId,
        0, // no longer FitKoh-specific, keep column for compat
        item.fitkohMenuItemId ?? 0,
        item.productName,
      ).run()

      if (result.meta.changes === 0) continue // Already dispatched by another path

      // This is genuinely new — log directly to FitKoh as the bridge trainer.
      await logToFitkoh(env, item)
      dispatched++
    } catch (err) {
      // If dispatch fails after the INSERT OR IGNORE claimed the item,
      // delete the D1 row so it can be retried on the next cron/SSE tick.
      await env.DB.prepare('DELETE FROM auto_imported_items WHERE id = ?')
        .bind(item.id)
        .run()
        .catch((deleteErr) => {
          console.error(`Failed to unclaim item ${item.id}:`, deleteErr)
        })
      console.error(`Dispatch error for item ${item.id}:`, err)
      errors++
    }
  }

  return { dispatched, errors }
}

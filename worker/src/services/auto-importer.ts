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
import type { MealOrderedData } from '@shared/types'
import { PosterClient } from './poster'
import { dispatchEvent, generateEventId } from './webhook-dispatcher'

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

  // 3. Fetch today's detailed transactions from Poster
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const transactions = await poster.getDetailedTransactions(today, today, 500)

  // 4. Fetch product catalog ONCE (not per-item)
  const products = await poster.getProducts()
  const productMap = new Map(
    products.map((p) => [
      String(p.product_id),
      (p.product_name || '').replace(/^food_/, ''),
    ]),
  )

  // 5. Find new items for mapped users. Each mapped transaction triggers one
  // extra Poster call to fetch per-line punch-in times — cached per tick so a
  // bill with N mapped products still costs just one extra call, not N.
  const dispatchableItems: DispatchableItem[] = []
  const productTimesByTx = new Map<number, string[]>()

  for (const t of transactions) {
    const clientIdStr = String(t.client_id)
    if (!mappedClientIds.has(clientIdStr)) continue

    let productTimes = productTimesByTx.get(t.transaction_id)
    if (!productTimes) {
      const lines = await poster.getTransactionProducts(t.transaction_id)
      productTimes = lines.map((l) => l.time)
      productTimesByTx.set(t.transaction_id, productTimes)
    }

    for (let i = 0; i < (t.products || []).length; i++) {
      const p = t.products[i]
      const productIdStr = String(p.product_id)
      const fitkohMenuItemId = itemMapping[productIdStr] ?? null

      const itemId = `${clientIdStr}:${t.transaction_id}:${i}`
      const logTime = punchInIsoOrFallback(productTimes[i], t.date_close, today)

      const productName =
        productMap.get(productIdStr) || `Product #${productIdStr}`

      dispatchableItems.push({
        id: itemId,
        posterClientId: Number(clientIdStr),
        posterProductId: productIdStr,
        productName,
        quantity: Number(p.num || 1),
        price: Number(p.product_sum || 0),
        fitkohMenuItemId,
        transactionId: t.transaction_id,
        logTime,
      })
    }
  }

  if (dispatchableItems.length === 0) {
    return { checked: transactions.length, dispatched: 0, skipped: 0, errors: 0 }
  }

  const { dispatched, errors } = await deduplicateAndDispatch(env, dispatchableItems)

  return {
    checked: transactions.length,
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

  // The SSE stream carries bill-close time in `item.time`, not the punch-in
  // time we want. Fetch per-line times for each transaction this call touches,
  // cached so a bill with multiple mapped lines only costs one extra call.
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const productTimesByTx = new Map<number, string[]>()

  for (const item of newItems) {
    const clientIdStr = item.clientId != null ? String(item.clientId) : null
    if (!clientIdStr || !mappedClientIds.has(clientIdStr)) continue

    const productIdStr = String(item.productId)
    const fitkohMenuItemId = itemMapping[productIdStr] ?? null

    // Reconstruct the same dedup ID format used by the cron path:
    // clientId:transactionId:productIndex
    // The SSE item id is "transactionId-productIndex", so extract the index
    const dashIdx = item.id.lastIndexOf('-')
    const productIndexStr = dashIdx >= 0 ? item.id.substring(dashIdx + 1) : '0'
    const productIndex = Number(productIndexStr)
    const dedupId = `${clientIdStr}:${item.transactionId}:${productIndexStr}`

    let productTimes = productTimesByTx.get(item.transactionId)
    if (!productTimes) {
      const lines = await poster.getTransactionProducts(item.transactionId)
      productTimes = lines.map((l) => l.time)
      productTimesByTx.set(item.transactionId, productTimes)
    }

    const logTime = punchInIsoOrFallback(productTimes[productIndex], item.time, today)

    dispatchableItems.push({
      id: dedupId,
      posterClientId: Number(clientIdStr),
      posterProductId: productIdStr,
      productName: item.productName,
      quantity: item.quantity,
      price: item.price,
      fitkohMenuItemId,
      transactionId: item.transactionId,
      logTime,
    })
  }

  if (dispatchableItems.length === 0) return 0

  const { dispatched } = await deduplicateAndDispatch(env, dispatchableItems)
  return dispatched
}

// ---------------------------------------------------------------------------
// Shared: dedup against D1 -> dispatch webhook events -> record in D1
// ---------------------------------------------------------------------------

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

      // This is genuinely new -- dispatch webhook
      const eventData: MealOrderedData = {
        posterClientId: item.posterClientId,
        posterProductId: item.posterProductId,
        productName: item.productName,
        quantity: item.quantity,
        price: item.price,
        fitkohMenuItemId: item.fitkohMenuItemId,
        transactionId: item.transactionId,
        time: item.logTime,
      }

      await dispatchEvent(env, {
        id: generateEventId(),
        type: 'meal.ordered',
        timestamp: new Date().toISOString(),
        data: eventData,
      })

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

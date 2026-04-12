// Auto-imports new Poster orders into FitKoh for users with linked accounts.
// Called by the Cloudflare Cron Trigger (after cache warming) and by
// POST /api/admin/auto-import for manual testing.
//
// Two entry points:
//   - autoImportNewMeals(env)       — cron path, fetches transactions from Poster
//   - importItemsForUser(env, items) — SSE path, uses already-detected LiveItems
//
// Flow:
//   1. Load user mapping (poster_client_id → fitkohUserId) from KV
//   2. Load item mapping (poster_product_id → fitkohMenuItemId) from KV
//   3. Fetch today's detailed transactions from Poster (cron) or use passed items (SSE)
//   4. Filter to mapped users, map products to FitKoh menu items
//   5. Deduplicate against D1 (auto_imported_items table)
//   6. POST new items to FitKoh's import endpoint
//   7. Record imported items in D1

import type { Env } from '../env'
import { PosterClient } from './poster'

interface UserMapping {
  fitkohUserId: number
  name: string
}

interface ImportableItem {
  id: string
  posterClientId: number
  fitkohUserId: number
  fitkohMenuItemId: number
  productName: string
  logDate: string
  logTime: string
  timeSlot: 'breakfast' | 'lunch' | 'dinner'
}

// ---------------------------------------------------------------------------
// Module-level KV cache — avoids hammering KV every 2s from the SSE path
// ---------------------------------------------------------------------------

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

function determineTimeSlot(hour: number): 'breakfast' | 'lunch' | 'dinner' {
  if (hour < 11) return 'breakfast'
  if (hour < 15) return 'lunch'
  return 'dinner'
}

export async function autoImportNewMeals(env: Env): Promise<{
  checked: number
  imported: number
  skipped: number
  errors: number
}> {
  const EMPTY = { checked: 0, imported: 0, skipped: 0, errors: 0 }

  // 1. Check if auto-import is configured
  const fitkohUrl = env.FITKOH_API_URL
  const fitkohKey = env.FITKOH_API_KEY
  if (!fitkohUrl || !fitkohKey) return EMPTY

  // 2. Load mappings from KV (cached)
  const { userMapping, itemMapping } = await getMappings(env)
  if (!userMapping || !itemMapping) return EMPTY

  // 4. Get today's date
  const today = new Date().toISOString().split('T')[0]

  // 5. Fetch today's detailed transactions from Poster
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
  const transactions = await poster.getDetailedTransactions(today, today, 500)

  // 6. Fetch product catalog ONCE (not per-item)
  const products = await poster.getProducts()
  const productMap = new Map(
    products.map((p) => [
      String(p.product_id),
      (p.product_name || '').replace(/^food_/, ''),
    ]),
  )

  // 7. Find new items for mapped users
  const mappedClientIds = new Set(Object.keys(userMapping))
  const importableItems: ImportableItem[] = []

  for (const t of transactions) {
    const clientIdStr = String(t.client_id)
    if (!mappedClientIds.has(clientIdStr)) continue

    const user = userMapping[clientIdStr]
    for (let i = 0; i < (t.products || []).length; i++) {
      const p = t.products[i]
      const productIdStr = String(p.product_id)
      const fitkohMenuItemId = itemMapping[productIdStr]
      if (!fitkohMenuItemId) continue

      const itemId = `${clientIdStr}:${t.transaction_id}:${i}`

      // Determine time slot from date_close
      const closeDateParts = (t.date_close || '').split(' ')
      const timeStr = closeDateParts[1] || '12:00:00'
      const hour = parseInt(timeStr.split(':')[0] || '12')
      const timeSlot = determineTimeSlot(hour)

      // Build ISO timestamp (Poster date_close is in ICT, +07:00)
      const logTime = `${closeDateParts[0] || today}T${timeStr}+07:00`

      const productName =
        productMap.get(productIdStr) || `Product #${productIdStr}`

      importableItems.push({
        id: itemId,
        posterClientId: Number(clientIdStr),
        fitkohUserId: user.fitkohUserId,
        fitkohMenuItemId,
        productName,
        logDate: today,
        logTime,
        timeSlot,
      })
    }
  }

  if (importableItems.length === 0) {
    return { checked: transactions.length, imported: 0, skipped: 0, errors: 0 }
  }

  const { imported, errors } = await deduplicateAndImport(
    env,
    importableItems,
  )

  return {
    checked: transactions.length,
    imported,
    skipped: importableItems.length - imported - errors,
    errors,
  }
}

// ---------------------------------------------------------------------------
// SSE entry point — uses already-detected LiveItems from the stream
// ---------------------------------------------------------------------------

export async function importItemsForUser(
  env: Env,
  newItems: Array<{
    id: string
    productId: number
    time: string
    transactionId: number
    clientId?: number | null
  }>,
): Promise<number> {
  const fitkohUrl = env.FITKOH_API_URL
  const fitkohKey = env.FITKOH_API_KEY
  if (!fitkohUrl || !fitkohKey) return 0
  if (newItems.length === 0) return 0

  const { userMapping, itemMapping } = await getMappings(env)
  if (!userMapping || !itemMapping) return 0

  const today = new Date().toISOString().split('T')[0]
  const mappedClientIds = new Set(Object.keys(userMapping))
  const importableItems: ImportableItem[] = []

  for (const item of newItems) {
    const clientIdStr = item.clientId != null ? String(item.clientId) : null
    if (!clientIdStr || !mappedClientIds.has(clientIdStr)) continue

    const productIdStr = String(item.productId)
    const fitkohMenuItemId = itemMapping[productIdStr]
    if (!fitkohMenuItemId) continue

    const user = userMapping[clientIdStr]

    // Determine time slot from the item's time (Poster date_close format)
    const closeDateParts = (item.time || '').split(' ')
    const timeStr = closeDateParts[1] || '12:00:00'
    const hour = parseInt(timeStr.split(':')[0] || '12')
    const timeSlot = determineTimeSlot(hour)
    const logTime = `${closeDateParts[0] || today}T${timeStr}+07:00`

    // Reconstruct the same dedup ID format used by the cron path:
    // clientId:transactionId:productIndex
    // The SSE item id is "transactionId-productIndex", so extract the index
    const dashIdx = item.id.lastIndexOf('-')
    const productIndex = dashIdx >= 0 ? item.id.substring(dashIdx + 1) : '0'
    const dedupId = `${clientIdStr}:${item.transactionId}:${productIndex}`

    importableItems.push({
      id: dedupId,
      posterClientId: Number(clientIdStr),
      fitkohUserId: user.fitkohUserId,
      fitkohMenuItemId,
      productName: `Product #${productIdStr}`,
      logDate: today,
      logTime,
      timeSlot,
    })
  }

  if (importableItems.length === 0) return 0

  const { imported } = await deduplicateAndImport(env, importableItems)
  return imported
}

// ---------------------------------------------------------------------------
// Shared: dedup against D1 → POST to FitKoh → record in D1
// ---------------------------------------------------------------------------

async function deduplicateAndImport(
  env: Env,
  importableItems: ImportableItem[],
): Promise<{ imported: number; errors: number }> {
  const fitkohUrl = env.FITKOH_API_URL!
  const fitkohKey = env.FITKOH_API_KEY!

  // Check which items are already imported (batch check)
  const placeholders = importableItems.map(() => '?').join(',')
  const existing = await env.DB.prepare(
    `SELECT id FROM auto_imported_items WHERE id IN (${placeholders})`,
  )
    .bind(...importableItems.map((i) => i.id))
    .all<{ id: string }>()
  const existingIds = new Set(existing.results.map((r) => r.id))

  const newItems = importableItems.filter((i) => !existingIds.has(i.id))
  if (newItems.length === 0) return { imported: 0, errors: 0 }

  // Group by FitKoh user and import
  const byUser = new Map<number, ImportableItem[]>()
  for (const item of newItems) {
    const items = byUser.get(item.fitkohUserId) || []
    items.push(item)
    byUser.set(item.fitkohUserId, items)
  }

  let imported = 0
  let errors = 0

  for (const [userId, items] of byUser) {
    try {
      const importPayload = {
        userId,
        items: items.map((i) => ({
          menuItemId: i.fitkohMenuItemId,
          logDate: i.logDate,
          logTime: i.logTime,
          timeSlot: i.timeSlot,
          itemType: 'food',
          quantity: 1,
        })),
      }

      const resp = await fetch(`${fitkohUrl}/api/v1/items/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': fitkohKey,
        },
        body: JSON.stringify(importPayload),
      })

      if (!resp.ok) {
        const body = await resp.text()
        console.error(
          `FitKoh import failed for user ${userId}: ${resp.status} ${body}`,
        )
        errors += items.length
        continue
      }

      const result = (await resp.json()) as {
        imported: number
        skipped: number
      }
      imported += result.imported

      // Record imported items in D1
      const inserts = items.map((i) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO auto_imported_items (id, poster_client_id, fitkoh_user_id, fitkoh_menu_item_id, poster_product_name) VALUES (?, ?, ?, ?, ?)`,
        ).bind(
          i.id,
          i.posterClientId,
          i.fitkohUserId,
          i.fitkohMenuItemId,
          i.productName,
        ),
      )
      await env.DB.batch(inserts)
    } catch (err) {
      console.error(`Auto-import error for user ${userId}:`, err)
      errors += items.length
    }
  }

  return { imported, errors }
}

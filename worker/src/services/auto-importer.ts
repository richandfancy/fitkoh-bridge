// Auto-imports new Poster orders into FitKoh for users with linked accounts.
// Called by the Cloudflare Cron Trigger (after cache warming) and by
// POST /api/admin/auto-import for manual testing.
//
// Flow:
//   1. Load user mapping (poster_client_id → fitkohUserId) from KV
//   2. Load item mapping (poster_product_id → fitkohMenuItemId) from KV
//   3. Fetch today's detailed transactions from Poster
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

  // 2. Load user mapping from KV
  const userMappingRaw = await env.CONFIG.get('poster_to_fitkoh_users')
  if (!userMappingRaw) return EMPTY
  const userMapping: Record<string, UserMapping> = JSON.parse(userMappingRaw)

  // 3. Load item mapping from KV
  const itemMappingRaw = await env.CONFIG.get('poster_to_fitkoh_items')
  if (!itemMappingRaw) return EMPTY
  const itemMapping: Record<string, number> = JSON.parse(itemMappingRaw)

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

  // 8. Check which items are already imported (batch check)
  // Use parameterized query to avoid SQL injection
  const placeholders = importableItems.map(() => '?').join(',')
  const existing = await env.DB.prepare(
    `SELECT id FROM auto_imported_items WHERE id IN (${placeholders})`,
  )
    .bind(...importableItems.map((i) => i.id))
    .all<{ id: string }>()
  const existingIds = new Set(existing.results.map((r) => r.id))

  const newItems = importableItems.filter((i) => !existingIds.has(i.id))

  if (newItems.length === 0) {
    return {
      checked: transactions.length,
      imported: 0,
      skipped: importableItems.length,
      errors: 0,
    }
  }

  // 9. Group by FitKoh user and import
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

      // 10. Record imported items in D1
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

  return {
    checked: transactions.length,
    imported,
    skipped: importableItems.length - newItems.length,
    errors,
  }
}

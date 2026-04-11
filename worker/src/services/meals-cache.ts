// Meal cache helpers shared between the /api/v1/meals route and /mcp tools.
// Fetches meal items for a guest from Poster, caches them in D1 for 30s.

import type { Env } from '../env'
import { PosterClient } from './poster'

// Cache TTL in seconds — short enough for "real-time" feel,
// long enough to protect Poster API.
export const MEALS_CACHE_TTL_SECONDS = 30

export interface CachedMealItem {
  id: string
  time: string
  posterProductId: string
  productName: string
  quantity: number
  price: number
  fitkohMenuItemId: number | null
}

export interface CachedMeals {
  posterClientId: number
  date: string
  items: CachedMealItem[]
  total: number
  cachedAt: string
}

export async function fetchMealsForClient(
  env: Env,
  posterClientId: number,
  date: string,
): Promise<CachedMeals> {
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)

  const mappingRaw = await env.CONFIG.get('poster_to_fitkoh_items')
  const mapping: Record<string, number> = mappingRaw ? JSON.parse(mappingRaw) : {}

  const detailed = await poster.getDetailedTransactions(date, date, 500)

  const products = await poster.getProducts()
  const productMap = new Map(
    products.map((p) => [String(p.product_id), (p.product_name || '').replace(/^food_/, '')]),
  )

  const items: CachedMealItem[] = []
  for (const t of detailed) {
    if (t.client_id !== posterClientId) continue
    for (let i = 0; i < (t.products || []).length; i++) {
      const p = t.products[i]
      const productIdStr = String(p.product_id)
      const productName = productMap.get(productIdStr) || `Product #${productIdStr}`
      items.push({
        id: `${t.transaction_id}-${i}`,
        time: t.date_close,
        posterProductId: productIdStr,
        productName,
        quantity: Number(p.num || 1),
        price: Number(p.product_sum || 0),
        fitkohMenuItemId: mapping[productIdStr] || null,
      })
    }
  }

  items.sort((a, b) => a.time.localeCompare(b.time))

  return {
    posterClientId,
    date,
    items,
    total: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    cachedAt: new Date().toISOString(),
  }
}

export async function getCachedOrFetchMeals(
  env: Env,
  posterClientId: number,
  date: string,
): Promise<{ data: CachedMeals; fromCache: boolean }> {
  const cacheKey = `${posterClientId}:${date}`

  const cached = await env.DB.prepare(
    'SELECT data, cached_at FROM poster_meals_cache WHERE cache_key = ?',
  )
    .bind(cacheKey)
    .first<{ data: string; cached_at: string }>()

  if (cached) {
    const age = (Date.now() - new Date(cached.cached_at + 'Z').getTime()) / 1000
    if (age < MEALS_CACHE_TTL_SECONDS) {
      return { data: JSON.parse(cached.data) as CachedMeals, fromCache: true }
    }
  }

  const fresh = await fetchMealsForClient(env, posterClientId, date)

  await env.DB.prepare(
    "INSERT OR REPLACE INTO poster_meals_cache (cache_key, data, cached_at) VALUES (?, ?, datetime('now'))",
  )
    .bind(cacheKey, JSON.stringify(fresh))
    .run()

  return { data: fresh, fromCache: false }
}

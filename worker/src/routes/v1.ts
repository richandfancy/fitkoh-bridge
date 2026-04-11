// Public API v1 — for external systems (FitKoh app, Homebase, etc.)
// Authenticated via X-API-Key header

import { Hono } from 'hono'
import type { Env } from '../env'
import { apiKeyAuth, type V1Variables } from '../middleware/api-key'
import { PosterClient } from '../services/poster'

const app = new Hono<{ Bindings: Env; Variables: V1Variables }>()

// All v1 routes require API key
app.use('*', apiKeyAuth)

// Cache TTL in seconds — short enough for "real-time" feel, long enough to protect Poster API
const CACHE_TTL_SECONDS = 30

interface CachedMeals {
  posterClientId: number
  date: string
  items: Array<{
    id: string
    time: string
    posterProductId: string
    productName: string
    quantity: number
    price: number
    fitkohMenuItemId: number | null
  }>
  total: number
  cachedAt: string
}

async function fetchMealsForClient(
  env: Env,
  posterClientId: number,
  date: string,
): Promise<CachedMeals> {
  const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)

  // Get Poster→FitKoh mapping from KV (set via dashboard Settings)
  const mappingRaw = await env.CONFIG.get('poster_to_fitkoh_items')
  const mapping: Record<string, number> = mappingRaw ? JSON.parse(mappingRaw) : {}

  // Fetch detailed transactions with inline products
  const detailed = await poster.getDetailedTransactions(
    date,
    date,
    500,
  )

  // Fetch product names in parallel
  const products = await poster.getProducts()
  const productMap = new Map(
    products.map((p) => [String(p.product_id), (p.product_name || '').replace(/^food_/, '')]),
  )

  // Filter for this client and flatten to items
  const items: CachedMeals['items'] = []
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

  // Sort by time ascending (chronological order of the day)
  items.sort((a, b) => a.time.localeCompare(b.time))

  return {
    posterClientId,
    date,
    items,
    total: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    cachedAt: new Date().toISOString(),
  }
}

async function getCachedOrFetch(
  env: Env,
  posterClientId: number,
  date: string,
): Promise<{ data: CachedMeals; fromCache: boolean }> {
  const cacheKey = `${posterClientId}:${date}`

  // Check cache
  const cached = await env.DB.prepare(
    'SELECT data, cached_at FROM poster_meals_cache WHERE cache_key = ?',
  )
    .bind(cacheKey)
    .first<{ data: string; cached_at: string }>()

  if (cached) {
    const age = (Date.now() - new Date(cached.cached_at + 'Z').getTime()) / 1000
    if (age < CACHE_TTL_SECONDS) {
      return { data: JSON.parse(cached.data) as CachedMeals, fromCache: true }
    }
  }

  // Cache miss or stale — fetch fresh
  const fresh = await fetchMealsForClient(env, posterClientId, date)

  // Update cache (upsert)
  await env.DB.prepare(
    'INSERT OR REPLACE INTO poster_meals_cache (cache_key, data, cached_at) VALUES (?, ?, datetime(\'now\'))',
  )
    .bind(cacheKey, JSON.stringify(fresh))
    .run()

  return { data: fresh, fromCache: false }
}

/**
 * GET /api/v1/meals/:posterClientId
 * Returns meal items for a guest on a specific date.
 *
 * Query params:
 *   date  — YYYY-MM-DD, defaults to today
 *
 * Headers:
 *   X-API-Key: fbk_...
 */
app.get('/meals/:posterClientId', async (c) => {
  const posterClientId = Number(c.req.param('posterClientId'))
  if (!posterClientId || isNaN(posterClientId)) {
    return c.json({ error: 'Invalid posterClientId' }, 400)
  }

  const date = c.req.query('date') || new Date().toISOString().split('T')[0]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'Invalid date, use YYYY-MM-DD' }, 400)
  }

  try {
    const { data, fromCache } = await getCachedOrFetch(c.env, posterClientId, date)
    return c.json({
      ...data,
      fromCache,
    })
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Failed to fetch meals',
      },
      500,
    )
  }
})

/**
 * GET /api/v1/health
 * Public health check — useful for consumers to verify API key works
 */
app.get('/health', async (c) => {
  const apiKey = c.get('apiKey')
  return c.json({
    ok: true,
    apiKey: { id: apiKey.id, name: apiKey.name },
    version: 'v1',
  })
})

export default app

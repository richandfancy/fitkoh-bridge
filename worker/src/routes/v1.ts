// Public API v1 — for external systems (FitKoh app, Homebase, etc.)
// Authenticated via X-API-Key header or Bearer token
// OpenAPI spec exposed at /openapi.json (unauthenticated)

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Env } from '../env'
import { apiKeyAuth, type V1Variables } from '../middleware/api-key'
import { PosterClient } from '../services/poster'

const app = new OpenAPIHono<{ Bindings: Env; Variables: V1Variables }>()

// Register the API key security scheme
app.openAPIRegistry.registerComponent('securitySchemes', 'ApiKeyAuth', {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
  description: 'API key issued by the FitKoh Bridge admin. Prefix with "fbk_".',
})

// Expose OpenAPI JSON spec BEFORE auth middleware so it is publicly reachable.
app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'FitKoh Bridge API',
    version: '1.0.0',
    description:
      'Public API for FitKoh Bridge — cross-system data hub connecting Clock PMS, Poster POS, and consumer apps (FitKoh, Homebase).',
  },
  servers: [
    { url: 'https://bridge.fitkoh.app', description: 'Production' },
    { url: 'https://s.bridge.fitkoh.app', description: 'Staging' },
    { url: 'http://localhost:8787', description: 'Local dev' },
  ],
})

// All other v1 routes require an API key
app.use('*', apiKeyAuth)

// Cache TTL in seconds — short enough for "real-time" feel, long enough to protect Poster API
const CACHE_TTL_SECONDS = 30

// ---------------------------------------------------------------------------
// Zod schemas (with OpenAPI metadata)
// ---------------------------------------------------------------------------

const MealItemSchema = z
  .object({
    id: z
      .string()
      .openapi({
        example: '157441-0',
        description: 'Stable item id: `<posterTransactionId>-<index>`',
      }),
    time: z
      .string()
      .openapi({
        example: '2026-04-11 08:44:03',
        description: 'Transaction close time as reported by Poster (local time).',
      }),
    posterProductId: z
      .string()
      .openapi({ example: '314', description: 'Poster product id' }),
    productName: z
      .string()
      .openapi({ example: 'Greek Yogurt Bowl', description: 'Human-readable product name' }),
    quantity: z.number().openapi({ example: 1 }),
    price: z.number().openapi({ example: 220, description: 'Unit price in minor currency units' }),
    fitkohMenuItemId: z
      .number()
      .nullable()
      .openapi({
        example: 42,
        description: 'Mapped FitKoh menu item id, or `null` if the Poster product is unmapped.',
      }),
  })
  .openapi('MealItem')

const MealsResponseSchema = z
  .object({
    posterClientId: z.number().openapi({ example: 2512 }),
    date: z.string().openapi({ example: '2026-04-07' }),
    items: z.array(MealItemSchema),
    total: z
      .number()
      .openapi({ example: 760, description: 'Sum of price * quantity across all items' }),
    cachedAt: z
      .string()
      .openapi({
        example: '2026-04-07T09:12:33.123Z',
        description: 'ISO 8601 timestamp at which the data was cached in D1.',
      }),
    fromCache: z
      .boolean()
      .openapi({
        example: true,
        description: 'True when the response was served from the D1 cache (age < 30s).',
      }),
  })
  .openapi('MealsResponse')

const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    apiKey: z.object({
      id: z.number().openapi({ example: 1 }),
      name: z.string().openapi({ example: 'FitKoh production' }),
    }),
    version: z.literal('v1'),
  })
  .openapi('HealthResponse')

const ErrorResponseSchema = z
  .object({
    error: z.string().openapi({ example: 'Invalid or revoked API key' }),
  })
  .openapi('ErrorResponse')

const PosterClientIdParam = z.object({
  posterClientId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'posterClientId', in: 'path' },
      example: 2512,
      description: 'Poster POS client id for the guest.',
    }),
})

const MealsQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .openapi({
      param: { name: 'date', in: 'query' },
      example: '2026-04-07',
      description: 'Target day in `YYYY-MM-DD`. Defaults to today (UTC).',
    }),
})

// ---------------------------------------------------------------------------
// Meal fetch + cache logic (unchanged)
// ---------------------------------------------------------------------------

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
  const detailed = await poster.getDetailedTransactions(date, date, 500)

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
    "INSERT OR REPLACE INTO poster_meals_cache (cache_key, data, cached_at) VALUES (?, ?, datetime('now'))",
  )
    .bind(cacheKey, JSON.stringify(fresh))
    .run()

  return { data: fresh, fromCache: false }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const mealsRoute = createRoute({
  method: 'get',
  path: '/meals/{posterClientId}',
  tags: ['Meals'],
  summary: 'Get guest meals for a specific date',
  description:
    'Returns meal items (from Poster POS) consumed by a given guest on a specific day. Results are cached in D1 for up to 30 seconds to protect the upstream Poster API.',
  security: [{ ApiKeyAuth: [] }],
  request: {
    params: PosterClientIdParam,
    query: MealsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: MealsResponseSchema } },
      description: 'Meals for the requested guest and day',
    },
    400: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Invalid parameters',
    },
    401: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Missing or invalid API key',
    },
    500: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Upstream (Poster) or bridge error',
    },
  },
})

app.openapi(mealsRoute, async (c) => {
  const { posterClientId } = c.req.valid('param')
  const { date: queryDate } = c.req.valid('query')
  const date = queryDate || new Date().toISOString().split('T')[0]

  try {
    const { data, fromCache } = await getCachedOrFetch(c.env, posterClientId, date)
    return c.json(
      {
        ...data,
        fromCache,
      },
      200,
    )
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Failed to fetch meals',
      },
      500,
    )
  }
})

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Health'],
  summary: 'Verify that the API key is valid',
  description:
    "Lightweight public health check. Returns the caller's API key metadata — useful for consumers to verify their key is accepted.",
  security: [{ ApiKeyAuth: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: HealthResponseSchema } },
      description: 'API key is valid',
    },
    401: {
      content: { 'application/json': { schema: ErrorResponseSchema } },
      description: 'Missing or invalid API key',
    },
  },
})

app.openapi(healthRoute, async (c) => {
  const apiKey = c.get('apiKey')
  return c.json(
    {
      ok: true as const,
      apiKey: { id: apiKey.id, name: apiKey.name },
      version: 'v1' as const,
    },
    200,
  )
})

export default app

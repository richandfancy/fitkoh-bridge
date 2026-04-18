import { captureException } from '@sentry/cloudflare'
import { z } from 'zod'
import type {
  PosterClient as PosterClientType,
  PosterTransaction,
  PosterTransactionHistoryEntry,
} from '@shared/types'
import {
  PosterDetailedTransactionSchema,
  PosterTransactionSchema,
} from '@shared/poster-schemas'

// Parse a Poster response against a Zod schema and report drift to Sentry
// without blowing up the caller. Returns `[]` on failure so the bridge
// degrades gracefully — the dashboards render "no orders" instead of a 500.
//
// TODO(BAC-1221): cover the drift-alert branch with a unit test (feed an
// obviously-malformed array, assert captureException called with
// `subsystem: 'poster-schema'`).
function parsePosterArray<T>(
  schema: z.ZodType<T>,
  endpoint: string,
  result: unknown,
): T[] {
  const parsed = z.array(schema).safeParse(result)
  if (parsed.success) return parsed.data

  captureException(new Error('Poster schema drift'), {
    tags: { endpoint, subsystem: 'poster-schema' },
    extra: {
      issues: parsed.error.issues,
      // Log only a small sample of the payload so we don't leak PII into
      // Sentry but still have enough context to diagnose.
      sample: Array.isArray(result) ? result.slice(0, 1) : result,
    },
  })
  return []
}

// Module-level cache for products (P2 fix)
let cachedProducts: Array<{
  product_id: string
  product_name: string
  category_name: string
  price: Record<string, string> | string
}> | null = null
let productsCachedAt = 0
const PRODUCTS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Module-level cache for daily transactions (P3 fix)
let cachedTransactions: { date: string; data: PosterTransaction[] } | null = null
let transactionsCachedAt = 0
const TRANSACTIONS_CACHE_TTL = 30_000 // 30 seconds

export class PosterClient {
  private token: string
  private baseUrl = 'https://joinposter.com/api/'

  constructor(token: string) {
    this.token = token
  }

  private async request<T>(
    method: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${method}`)
    url.searchParams.set('token', this.token)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
    }
    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`Poster API error: ${resp.status}`)
    const data = (await resp.json()) as { response: T }
    return data.response
  }

  async getClients(params?: {
    phone?: string
    num?: number
  }): Promise<PosterClientType[]> {
    return this.request('clients.getClients', {
      ...(params?.phone && { phone: params.phone }),
      ...(params?.num && { num: String(params.num) }),
    })
  }

  async getClient(clientId: number): Promise<PosterClientType[]> {
    return this.request('clients.getClient', {
      client_id: String(clientId),
    })
  }

  async createClient(data: {
    client_name: string
    client_groups_id_client: number
    firstname?: string
    lastname?: string
    patronymic?: string
    phone?: string
    phone_number?: string
    email?: string
    birthday?: string
    card_number?: string
    client_sex?: number
    country?: string
    city?: string
    address?: string
    comment?: string
  }): Promise<number> {
    const url = new URL(`${this.baseUrl}clients.createClient`)
    url.searchParams.set('token', this.token)
    const formData = new URLSearchParams()
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) formData.set(k, String(v))
    }
    const resp = await fetch(url.toString(), {
      method: 'POST',
      body: formData,
    })
    if (!resp.ok) throw new Error(`Poster createClient error: ${resp.status}`)
    const result = (await resp.json()) as { response: number }
    return result.response
  }

  async getTransactions(
    dateFrom: string,
    dateTo: string,
    params?: Record<string, string>,
  ): Promise<PosterTransaction[]> {
    const result = await this.request<unknown>('dash.getTransactions', {
      dateFrom,
      dateTo,
      ...params,
    })
    // Schema validated at runtime; on drift we alert + return [] rather
    // than crashing the cron or /orders handler. PosterTransactionSchema
    // transforms `client_id` / `transaction_id` to strings so the parsed
    // shape satisfies the existing PosterTransaction type.
    return parsePosterArray(
      PosterTransactionSchema,
      'dash.getTransactions',
      result,
    ) as unknown as PosterTransaction[]
  }

  async getTransaction(
    transactionId: string,
    includeProducts = true,
  ): Promise<PosterTransaction[]> {
    return this.request('dash.getTransaction', {
      transaction_id: transactionId,
      ...(includeProducts && { include_products: 'true' }),
    })
  }

  async getTransactionHistory(
    transactionId: string,
  ): Promise<PosterTransactionHistoryEntry[]> {
    return this.request('dash.getTransactionHistory', {
      transaction_id: transactionId,
    })
  }

  async getProducts(): Promise<
    Array<{
      product_id: string
      product_name: string
      category_name: string
      price: Record<string, string> | string
    }>
  > {
    const now = Date.now()
    if (cachedProducts && now - productsCachedAt < PRODUCTS_CACHE_TTL) {
      return cachedProducts
    }
    const result = await this.request<
      Array<{
        product_id: string
        product_name: string
        category_name: string
        price: Record<string, string> | string
      }>
    >('menu.getProducts')
    cachedProducts = result
    productsCachedAt = now
    return result
  }

  // Open (in-progress) transactions for a date range. Returns bills where
  // date_close is "0" — used for per-user open-bill totals on the
  // Guests/UsersPage dashboard and to ship items to FitKoh the moment
  // they're punched in, without waiting for the check to close.
  //
  // Delegates to getTransactions so the same Zod validation + drift
  // alerting applies here.
  async getOpenTransactions(
    dateFrom: string,
    dateTo: string,
  ): Promise<PosterTransaction[]> {
    return this.getTransactions(dateFrom, dateTo, { status: '1' })
  }

  // Per-line products for a single transaction. The `time` field is the
  // unix-ms punch-in timestamp for each line (when the waiter tapped it in),
  // which is what FitKoh needs for macro bucketing — not the bill close time.
  async getTransactionProducts(
    transactionId: number,
  ): Promise<
    Array<{
      product_id: string
      num: string
      product_sum: string
      time: string
    }>
  > {
    const result = await this.request<
      Array<{
        product_id: string
        num: string
        product_sum: string
        time: string
      }>
    >('dash.getTransactionProducts', {
      transaction_id: String(transactionId),
    })
    return result || []
  }

  // Detailed transactions with inline products — used for live item feed.
  //
  // Runtime-validated with PosterDetailedTransactionSchema so a field
  // rename or type flip on Poster's side surfaces as a Sentry drift alert
  // instead of a NaN bill total or a silently-missing punch.
  async getDetailedTransactions(
    dateFrom: string,
    dateTo: string,
    perPage = 500,
  ): Promise<
    Array<{
      transaction_id: number
      date_close: string
      client_id: number
      table_id: number
      spot_id: number
      products: Array<{
        product_id: number
        num: number
        product_sum: string
      }>
    }>
  > {
    const raw = await this.request<unknown>('transactions.getTransactions', {
      date_from: dateFrom,
      date_to: dateTo,
      per_page: String(perPage),
    })
    // The detailed feed wraps its array under a `data` key; the rest of
    // the response (pagination, counts) is ignored.
    const data =
      raw && typeof raw === 'object' && 'data' in raw
        ? (raw as { data: unknown }).data
        : []

    return parsePosterArray(
      PosterDetailedTransactionSchema,
      'transactions.getTransactions',
      data,
    ) as Array<{
      transaction_id: number
      date_close: string
      client_id: number
      table_id: number
      spot_id: number
      products: Array<{
        product_id: number
        num: number
        product_sum: string
      }>
    }>
  }

  // For pre-invoice: get all transactions for a specific client in a date range.
  // The Poster API doesn't support client_id filtering, so we fetch all
  // transactions for the date range and filter locally. Results are cached
  // for 30s to avoid redundant full downloads (P3 fix).
  async getClientTransactions(
    clientId: number,
    dateFrom: string,
    dateTo: string,
  ): Promise<PosterTransaction[]> {
    const cacheKey = `${dateFrom}-${dateTo}`
    const now = Date.now()
    let allTxns: PosterTransaction[]

    if (
      cachedTransactions &&
      cachedTransactions.date === cacheKey &&
      now - transactionsCachedAt < TRANSACTIONS_CACHE_TTL
    ) {
      allTxns = cachedTransactions.data
    } else {
      allTxns = await this.getTransactions(dateFrom, dateTo)
      if (!allTxns || !Array.isArray(allTxns)) return []
      cachedTransactions = { date: cacheKey, data: allTxns }
      transactionsCachedAt = now
    }

    return allTxns.filter((t) => t.client_id === String(clientId))
  }
}

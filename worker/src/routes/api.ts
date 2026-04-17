import { Hono } from 'hono'
import type { Env } from '../env'
import {
  getStats,
  getActivityLog,
  getAllBookings,
  getBookingDetail,
  getBooking,
  getDeadLetters,
  retryDeadLetter,
  resolveDeadLetter,
} from '../db/queries'
import { MockClockClient } from '../services/clock-mock'
import { PosterClient } from '../services/poster'
import type {
  PreInvoiceResponse,
  PreInvoiceDay,
  PreInvoiceItem,
  PosterClientGroup,
} from '@shared/types'

// Helper for batched parallel calls (P4 fix — avoids N+1 sequential API calls)
async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

const app = new Hono<{ Bindings: Env }>()

// Dashboard stats
app.get('/stats', async (c) => {
  const stats = await getStats(c.env.DB)
  return c.json(stats)
})

// Live item feed from Poster — individual menu items as they're sold.
// For today's date, reads from the KV `live_orders_snapshot` (warmed by cron
// every 60s) to avoid hitting Poster on every dashboard load. Falls back to
// a live Poster fetch for historical dates or if KV is stale.
app.get('/orders', async (c) => {
  const date = c.req.query('date') // YYYY-MM-DD optional, defaults to today
  const today = new Date().toISOString().split('T')[0]
  const target = date || today

  // Try KV snapshot for today's data
  if (target === today) {
    try {
      const raw = await c.env.CONFIG.get('live_orders_snapshot')
      if (raw) {
        const snapshot = JSON.parse(raw) as {
          date: string
          items: Array<{
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
          }>
          updatedAt: string
          openOrders: number
          closedOrders: number
        }
        const age = Date.now() - new Date(snapshot.updatedAt).getTime()
        if (age < 90_000 && snapshot.date === today) {
          // Return from KV — items are oldest-first, reverse for dashboard
          const items = [...snapshot.items].reverse()
          return c.json({
            date: target,
            totalItems: items.length,
            openOrders: snapshot.openOrders,
            closedOrders: snapshot.closedOrders,
            items,
          })
        }
      }
    } catch {
      // KV read failed — fall through to live fetch
    }
  }

  // Fallback: live Poster fetch (historical dates or stale KV).
  // NOTE (Q1): This fetch-and-flatten logic mirrors warmOrdersSnapshot() in
  // cache-warmer.ts. The duplication is intentional — the cron warms KV for
  // today's data (the hot path above), while this fallback handles historical
  // dates and serves as a resilience path when KV is stale or unavailable.
  const poster = new PosterClient(c.env.POSTER_ACCESS_TOKEN)

  let transactions: Awaited<ReturnType<typeof poster.getDetailedTransactions>> = []
  let products: Awaited<ReturnType<typeof poster.getProducts>> = []
  let dashTxns: Awaited<ReturnType<typeof poster.getTransactions>> = []

  try {
    const [txnsResult, productsResult, dashResult] = await Promise.all([
      poster.getDetailedTransactions(target, target),
      poster.getProducts(),
      poster.getTransactions(target.replace(/-/g, ''), target.replace(/-/g, '')),
    ])
    transactions = txnsResult
    products = productsResult
    dashTxns = Array.isArray(dashResult) ? dashResult : []
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Failed to fetch items',
      },
      500,
    )
  }

  const productMap = new Map(
    products.map((p) => [
      String(p.product_id),
      (p.product_name || '').replace(/^food_/, ''),
    ]),
  )

  const clientNames = new Map<string, string>()
  const spotNames = new Map<string, string>()
  for (const t of dashTxns) {
    if (t.client_id && t.client_id !== '0' && (t.client_firstname || t.client_lastname)) {
      clientNames.set(
        t.client_id,
        `${t.client_lastname || ''} ${t.client_firstname || ''}`.trim(),
      )
    }
    if (t.spot_id && t.name) {
      spotNames.set(String(t.spot_id), t.name.trim())
    }
  }

  type LiveItem = {
    id: string
    time: string
    productId: number
    productName: string
    quantity: number
    price: number
    table: number
    location: string
    clientName: string | null
    transactionId: number
  }

  const items: LiveItem[] = []
  for (const t of transactions) {
    const location = spotNames.get(String(t.spot_id)) || 'Unknown'
    const clientName = clientNames.get(String(t.client_id)) || null

    for (let i = 0; i < (t.products || []).length; i++) {
      const p = t.products[i]
      const productIdStr = String(p.product_id)
      const name = productMap.get(productIdStr) || `Product #${productIdStr}`
      items.push({
        id: `${t.transaction_id}-${i}`,
        time: t.date_close,
        productId: p.product_id,
        productName: name,
        quantity: Number(p.num || 1),
        price: Number(p.product_sum || 0),
        table: t.table_id,
        location,
        clientName,
        transactionId: t.transaction_id,
      })
    }
  }

  items.sort((a, b) => b.time.localeCompare(a.time))

  const openOrders = dashTxns.filter((t) => t.status === '1').length

  return c.json({
    date: target,
    totalItems: items.length,
    openOrders,
    closedOrders: dashTxns.filter((t) => t.status === '2').length,
    items,
  })
})

// Poster client groups — derived from the client list. Used by CreateUserDrawer.
app.get('/poster/client-groups', async (c) => {
  const poster = new PosterClient(c.env.POSTER_ACCESS_TOKEN)
  const clients = await poster.getClients({ num: 10000 })

  const groupsById = new Map<number, string>()
  for (const c0 of clients) {
    const id = Number((c0 as unknown as { client_groups_id: string }).client_groups_id)
    const name = String((c0 as unknown as { client_groups_name: string }).client_groups_name || '').trim()
    if (!Number.isFinite(id) || id <= 0) continue
    if (!name) continue
    groupsById.set(id, name)
  }

  const groups: PosterClientGroup[] = Array.from(groupsById.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return c.json(groups)
})

// Create a Poster client from the CreateUserDrawer form.
app.post('/poster/clients', async (c) => {
  let body: {
    groupId?: number
    firstName?: string
    lastName?: string
    patronymic?: string
    phone?: string
    email?: string
    birthday?: string
    gender?: number
    cardNumber?: string
    comment?: string
    country?: string
    city?: string
    address?: string
  } = {}
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }

  const groupId = Number(body.groupId)
  if (!Number.isFinite(groupId) || groupId <= 0) {
    return c.json({ error: 'Group is required' }, 400)
  }

  const firstName = (body.firstName ?? '').trim()
  const lastName = (body.lastName ?? '').trim()
  const phone = (body.phone ?? '').trim()
  const email = (body.email ?? '').trim()

  if (!firstName && !lastName && !phone && !email) {
    return c.json({ error: 'Provide at least a name, phone, or email' }, 400)
  }

  const displayName = `${firstName} ${lastName}`.trim() || phone || email

  const poster = new PosterClient(c.env.POSTER_ACCESS_TOKEN)
  const posterClientId = await poster.createClient({
    client_name: displayName,
    client_groups_id_client: groupId,
    firstname: firstName || undefined,
    lastname: lastName || undefined,
    patronymic: (body.patronymic ?? '').trim() || undefined,
    phone: phone || undefined,
    email: email || undefined,
    birthday: (body.birthday ?? '').trim() || undefined,
    client_sex: Number.isFinite(Number(body.gender)) ? Number(body.gender) : undefined,
    card_number: (body.cardNumber ?? '').trim() || undefined,
    comment: (body.comment ?? '').trim() || undefined,
    country: (body.country ?? '').trim() || undefined,
    city: (body.city ?? '').trim() || undefined,
    address: (body.address ?? '').trim() || undefined,
  })

  return c.json({ posterClientId })
})

// Activity log (paginated, filterable)
app.get('/activity', async (c) => {
  const limit = Number(c.req.query('limit') || 50)
  const offset = Number(c.req.query('offset') || 0)
  const type = c.req.query('type') as
    | import('@shared/types').ActivityType
    | undefined
  const entries = await getActivityLog(c.env.DB, { limit, offset, type })
  return c.json(entries)
})

// Guests list (all bookings with charge counts + poster sync status)
app.get('/guests', async (c) => {
  const bookings = await getAllBookings(c.env.DB)
  return c.json(bookings)
})

// Guest detail
app.get('/guests/:id', async (c) => {
  const id = c.req.param('id')
  const detail = await getBookingDetail(c.env.DB, id)
  if (!detail) return c.json({ error: 'Guest not found' }, 404)
  return c.json(detail)
})

// Guest meals from Poster (proxied)
app.get('/guests/:id/meals', async (c) => {
  const id = c.req.param('id')
  const booking = await getBooking(c.env.DB, id)
  if (!booking || !booking.poster_client_id) {
    return c.json({ error: 'Guest not found or not synced to Poster' }, 404)
  }

  const poster = new PosterClient(c.env.POSTER_ACCESS_TOKEN)

  // Format dates for Poster API (YYYYMMDD)
  const dateFrom = (booking.check_in || '2026-01-01').replace(/-/g, '')
  const dateTo = (
    booking.check_out || new Date().toISOString().split('T')[0]
  ).replace(/-/g, '')

  const transactions = await poster.getClientTransactions(
    booking.poster_client_id,
    dateFrom,
    dateTo,
  )

  // Get products map for name resolution
  const products = await poster.getProducts()
  const productMap = new Map(
    products.map((p) => [p.product_id, p.product_name]),
  )

  // Fetch details for each transaction to get individual items with timestamps.
  // Batched in groups of 5 to avoid N+1 sequential API calls (P4 fix).
  const allItems: Array<{
    date: string
    time: string
    name: string
    price: number
    quantity: number
  }> = []

  const histories = await processInBatches(transactions, 5, async (txn) => {
    try {
      const history = await poster.getTransactionHistory(txn.transaction_id)
      return history
    } catch {
      return []
    }
  })

  for (const history of histories) {
    for (const entry of history) {
      if (entry.type_history !== 'additem') continue
      const ts = Number(entry.time)
      const dt = new Date(ts)
      const name = productMap.get(entry.value) || `Product #${entry.value}`
      // Parse price from value_text JSON
      let price = 0
      try {
        const vt = JSON.parse(entry.value_text)
        price = (vt.price || 0) / 100 // Poster prices in satang
      } catch {
        /* ignore */
      }

      allItems.push({
        date: dt.toISOString().split('T')[0],
        time: dt.toISOString(),
        name: name.replace(/^food_/, ''),
        price,
        quantity: 1,
      })
    }
  }

  // Group by date
  const byDate = new Map<string, typeof allItems>()
  for (const item of allItems) {
    const existing = byDate.get(item.date) || []
    existing.push(item)
    byDate.set(item.date, existing)
  }

  const days = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      date,
      items: items.sort((a, b) => a.time.localeCompare(b.time)),
      total: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    }))

  return c.json({
    guestName: booking.guest_name,
    posterClientId: booking.poster_client_id,
    checkIn: booking.check_in,
    checkOut: booking.check_out,
    days,
    grandTotal: days.reduce((sum, d) => sum + d.total, 0),
  })
})

// Dead letters
app.get('/dead-letters', async (c) => {
  const unresolvedOnly = c.req.query('unresolved') !== 'false'
  const letters = await getDeadLetters(c.env.DB, unresolvedOnly)
  return c.json(letters)
})

app.post('/dead-letters/:id/retry', async (c) => {
  const id = Number(c.req.param('id'))
  await retryDeadLetter(c.env.DB, id)
  return c.json({ ok: true })
})

app.post('/dead-letters/:id/resolve', async (c) => {
  const id = Number(c.req.param('id'))
  await resolveDeadLetter(c.env.DB, id)
  return c.json({ ok: true })
})

// Config: charge template mappings (KV)
app.get('/config/mappings', async (c) => {
  const raw = await c.env.CONFIG.get('charge_template_mappings')
  return c.json(raw ? JSON.parse(raw) : {})
})

app.put('/config/mappings', async (c) => {
  const body = await c.req.json()
  await c.env.CONFIG.put('charge_template_mappings', JSON.stringify(body))
  return c.json({ ok: true })
})

// Config: Clock charge templates (mocked)
app.get('/config/templates', async (c) => {
  const clock = new MockClockClient()
  const templates = await clock.getChargeTemplates()
  return c.json(templates)
})

// Pre-invoice
app.get('/pre-invoice/:posterClientId', async (c) => {
  const posterClientId = Number(c.req.param('posterClientId'))
  const dateFrom =
    c.req.query('dateFrom') || '2026-01-01'
  const dateTo =
    c.req.query('dateTo') || new Date().toISOString().split('T')[0]

  const poster = new PosterClient(c.env.POSTER_ACCESS_TOKEN)

  // Get client info
  let guestName = `Client #${posterClientId}`
  try {
    const clients = await poster.getClient(posterClientId)
    if (clients.length > 0) {
      guestName = `${clients[0].firstname} ${clients[0].lastname}`
    }
  } catch {
    /* use default */
  }

  // Get transactions
  const posterDateFrom = dateFrom.replace(/-/g, '')
  const posterDateTo = dateTo.replace(/-/g, '')
  const transactions = await poster.getClientTransactions(
    posterClientId,
    posterDateFrom,
    posterDateTo,
  )

  // Get product names
  const products = await poster.getProducts()
  const productMap = new Map(
    products.map((p) => [p.product_id, p.product_name]),
  )

  // Get all items with per-item timestamps from transaction history.
  // Batched in groups of 5 to avoid N+1 sequential API calls (P4 fix).
  const allItems: Array<{
    date: string
    name: string
    unitPrice: number
    quantity: number
  }> = []

  const details = await processInBatches(transactions, 5, async (txn) => {
    try {
      const [detail] = await poster.getTransaction(txn.transaction_id, true)
      return { detail, txn }
    } catch {
      return { detail: null, txn }
    }
  })

  for (const { detail, txn } of details) {
    if (!detail?.products) continue

    const txDate = txn.date_close_date?.split(' ')[0] || ''

    for (const product of detail.products) {
      const price = Number(product.product_price) / 100
      if (price <= 0) continue

      const name = (
        productMap.get(product.product_id) || `Product #${product.product_id}`
      ).replace(/^food_/, '')

      allItems.push({
        date: txDate,
        name,
        unitPrice: price,
        quantity: Number(product.num) || 1,
      })
    }
  }

  // Group by date and apply meal plan deduction
  const byDate = new Map<string, typeof allItems>()
  for (const item of allItems) {
    const existing = byDate.get(item.date) || []
    existing.push(item)
    byDate.set(item.date, existing)
  }

  const days: PreInvoiceDay[] = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => {
      // Sort by unit price descending to find top 3
      const sorted = [...items].sort(
        (a, b) => b.unitPrice * b.quantity - a.unitPrice * a.quantity,
      )
      const top3Indices = new Set(
        sorted.slice(0, 3).map((s) => items.indexOf(s)),
      )

      const invoiceItems: PreInvoiceItem[] = items.map((item, idx) => ({
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.unitPrice * item.quantity,
        mealPlanIncluded: top3Indices.has(idx),
      }))

      const subtotal = invoiceItems.reduce((sum, i) => sum + i.totalPrice, 0)
      const deduction = invoiceItems
        .filter((i) => i.mealPlanIncluded)
        .reduce((sum, i) => sum + i.totalPrice, 0)

      return { date, items: invoiceItems, subtotal, deduction, net: subtotal - deduction }
    })

  const totals = {
    gross: days.reduce((sum, d) => sum + d.subtotal, 0),
    totalDeductions: days.reduce((sum, d) => sum + d.deduction, 0),
    finalAmount: days.reduce((sum, d) => sum + d.net, 0),
  }

  const response: PreInvoiceResponse = {
    guestName,
    posterClientId,
    dateRange: { from: dateFrom, to: dateTo },
    days,
    totals,
  }

  return c.json(response)
})

export default app

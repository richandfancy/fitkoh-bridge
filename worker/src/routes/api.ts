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
} from '@shared/types'

const app = new Hono<{ Bindings: Env }>()

// Dashboard stats
app.get('/stats', async (c) => {
  const stats = await getStats(c.env.DB)
  return c.json(stats)
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

  // Fetch details for each transaction to get individual items with timestamps
  const allItems: Array<{
    date: string
    time: string
    name: string
    price: number
    quantity: number
  }> = []

  for (const txn of transactions) {
    try {
      const history = await poster.getTransactionHistory(txn.transaction_id)
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
    } catch {
      // Skip failed transaction lookups
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

  // Get all items with per-item timestamps from transaction history
  const allItems: Array<{
    date: string
    name: string
    unitPrice: number
    quantity: number
  }> = []

  for (const txn of transactions) {
    try {
      const [detail] = await poster.getTransaction(txn.transaction_id, true)
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
    } catch {
      // Skip failed lookups
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

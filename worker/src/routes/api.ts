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
import { getClockClient } from '../services/clock-factory'
import {
  buildOrdersSnapshot,
  readSnapshotFromKv,
} from '../services/orders-feed'
import { PosterClient } from '../services/poster'
import type {
  PreInvoiceResponse,
  PreInvoiceDay,
  PreInvoiceItem,
  PosterClientGroup,
  UserMatchRow,
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

function splitGuestName(guestName: string | null): {
  firstName: string | null
  lastName: string | null
} {
  if (!guestName) return { firstName: null, lastName: null }
  const parts = guestName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: null, lastName: null }
  if (parts.length === 1) return { firstName: parts[0], lastName: null }
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  }
}

function parseUserMapping(raw: string | null): Record<
  string,
  { fitkohUserId: number | null; rezervUserId: string | null }
> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const result: Record<
      string,
      { fitkohUserId: number | null; rezervUserId: string | null }
    > = {}

    for (const [posterId, value] of Object.entries(parsed)) {
      if (typeof value === 'number') {
        result[posterId] = { fitkohUserId: value, rezervUserId: null }
        continue
      }

      if (typeof value === 'object' && value !== null) {
        const maybeObj = value as {
          fitkohUserId?: unknown
          rezervUserId?: unknown
        }
        result[posterId] = {
          fitkohUserId: typeof maybeObj.fitkohUserId === 'number'
            ? maybeObj.fitkohUserId
            : null,
          rezervUserId: typeof maybeObj.rezervUserId === 'string'
            ? maybeObj.rezervUserId
            : null,
        }
      }
    }

    return result
  } catch {
    return {}
  }
}

// Dashboard stats
app.get('/stats', async (c) => {
  const stats = await getStats(c.env.DB)
  return c.json(stats)
})

// Live item feed from Poster — individual menu items as they're sold.
// For today's date, reads from the KV `live_orders_snapshot` (warmed by cron
// every 60s) to avoid hitting Poster on every dashboard load. Falls back to
// a live Poster fetch for historical dates or if KV is stale.
//
// Thin wrapper around orders-feed — `readSnapshotFromKv` for the hot path,
// `buildOrdersSnapshot` for historical dates / stale KV.
//
// TODO(BAC-1221): integration tests for the KV-hit / KV-miss / historical-date
// branches and the response-shape contract the frontend depends on.
app.get('/orders', async (c) => {
  const date = c.req.query('date') // YYYY-MM-DD optional, defaults to today
  const today = new Date().toISOString().split('T')[0]
  const target = date || today

  // Hot path: today's data served from KV.
  if (target === today) {
    const snapshot = await readSnapshotFromKv(c.env.CONFIG, { today })
    if (snapshot) {
      // Snapshot stores items oldest-first; dashboard wants newest-first.
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

  // Fallback: live Poster fetch (historical dates or stale KV).
  const poster = new PosterClient(c.env.POSTER_ACCESS_TOKEN)
  let snapshot
  try {
    snapshot = await buildOrdersSnapshot(poster, { today: target })
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Failed to fetch items',
      },
      500,
    )
  }

  const items = [...snapshot.items].reverse()
  return c.json({
    date: target,
    totalItems: items.length,
    openOrders: snapshot.openOrders,
    closedOrders: snapshot.closedOrders,
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

// Cross-system user matching list — populates the Guests tab dashboard with
// Poster clients, Clock booking names, mapped FitKoh/Rezerv user IDs, and
// open-bill totals per user.
app.get('/users', async (c) => {
  const bookingsResult = await c.env.DB.prepare(
    `SELECT clock_booking_id, guest_name, poster_client_id, created_at
     FROM bookings
     ORDER BY created_at DESC`,
  ).all<{
    clock_booking_id: string
    guest_name: string | null
    poster_client_id: number | null
    created_at: string
  }>()

  const bookings = bookingsResult.results

  const mappingRaw = await c.env.CONFIG.get('poster_to_fitkoh_users')
  const userMapping = parseUserMapping(mappingRaw)

  // Per-client last punch (BAC-1149), derived from the cron-warmed
  // live_orders_snapshot. Populated by buildOrdersSnapshot() — reads from
  // dash.getTransactionHistory for open transactions. Falls back to the
  // legacy `lastOrderByClient` key so older snapshots still sort correctly
  // during rollout. Staleness is tolerated here: we read via KV key directly
  // rather than readSnapshotFromKv() because even an old snapshot beats a
  // blank "Last Punch" column on the Guests tab.
  const lastPunchByClient = await (async (): Promise<Record<string, string>> => {
    try {
      const raw = await c.env.CONFIG.get('live_orders_snapshot')
      if (!raw) return {}
      const snapshot = JSON.parse(raw) as {
        lastPunchByClient?: Record<string, string>
        lastOrderByClient?: Record<string, string>
      }
      return snapshot.lastPunchByClient ?? snapshot.lastOrderByClient ?? {}
    } catch {
      return {}
    }
  })()

  const posterClientById = new Map<
    number,
    {
      firstName: string | null
      lastName: string | null
      createdAt: string | null
      closedBillsTotal: number
    }
  >()
  const poster = new PosterClient(c.env.POSTER_ACCESS_TOKEN)
  try {
    const posterClients = await poster.getClients({ num: 10000 })
    for (const client of posterClients) {
      const posterId = Number(client.client_id)
      if (!Number.isFinite(posterId)) continue
      posterClientById.set(posterId, {
        firstName: client.firstname || null,
        lastName: client.lastname || null,
        createdAt: (client as { date_activale?: string }).date_activale || null,
        closedBillsTotal: Number(client.total_payed_sum || 0) / 100,
      })
    }
  } catch {
    // Fall through — keep whatever we have.
  }

  const unpaidBillsByPosterId = new Map<number, { count: number; total: number }>()
  try {
    const todayCompact = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const unpaidBills = await poster.getOpenTransactions('20000101', todayCompact)
    for (const bill of unpaidBills) {
      const posterId = Number(bill.client_id)
      if (!Number.isFinite(posterId) || posterId <= 0) continue
      const sumSatang = Number(bill.sum)
      const amount = Number.isFinite(sumSatang) ? sumSatang / 100 : 0
      const prior = unpaidBillsByPosterId.get(posterId) ?? { count: 0, total: 0 }
      unpaidBillsByPosterId.set(posterId, {
        count: prior.count + 1,
        total: prior.total + amount,
      })
    }
  } catch {
    // Keep users table available even if current open bill fetch fails.
  }

  const rowsById = new Map<string, UserMatchRow>()

  for (const [posterId, posterName] of posterClientById.entries()) {
    const mapping = userMapping[String(posterId)]
    rowsById.set(`poster:${posterId}`, {
      id: `poster:${posterId}`,
      clockId: null,
      clockFirstName: null,
      clockLastName: null,
      posterId,
      posterCreatedAt: posterName.createdAt,
      posterOpenBillsCount: unpaidBillsByPosterId.get(posterId)?.count ?? 0,
      posterOpenBillsTotal: unpaidBillsByPosterId.get(posterId)?.total ?? 0,
      posterClosedBillsCount: 0,
      posterClosedBillsTotal: posterName.closedBillsTotal,
      posterFirstName: posterName.firstName,
      posterLastName: posterName.lastName,
      lastPunchAt: null,
      fitkohUserId: mapping?.fitkohUserId ?? null,
      rezervUserId: mapping?.rezervUserId ?? null,
      hasClock: false,
      hasPoster: true,
      hasFitkoh: (mapping?.fitkohUserId ?? null) !== null,
      hasRezerv: (mapping?.rezervUserId ?? null) !== null,
    })
  }

  for (const booking of bookings) {
    const clockName = splitGuestName(booking.guest_name)
    const posterId = booking.poster_client_id
    const mapping = posterId !== null ? userMapping[String(posterId)] : undefined
    const posterName = posterId !== null
      ? (posterClientById.get(posterId) ?? {
          firstName: null,
          lastName: null,
          createdAt: null,
          closedBillsTotal: 0,
        })
      : { firstName: null, lastName: null, createdAt: null, closedBillsTotal: 0 }

    const rowId = posterId !== null
      ? `poster:${posterId}`
      : `clock:${booking.clock_booking_id}`

    const existing = rowsById.get(rowId)
    if (existing) {
      if (!existing.clockId) existing.clockId = booking.clock_booking_id
      if (!existing.clockFirstName) existing.clockFirstName = clockName.firstName
      if (!existing.clockLastName) existing.clockLastName = clockName.lastName
      existing.hasClock = true
      if (!existing.posterFirstName) existing.posterFirstName = posterName.firstName
      if (!existing.posterLastName) existing.posterLastName = posterName.lastName
      if (!existing.posterCreatedAt) existing.posterCreatedAt = posterName.createdAt
      if (existing.posterOpenBillsTotal === 0) {
        existing.posterOpenBillsTotal = unpaidBillsByPosterId.get(posterId ?? -1)?.total ?? 0
      }
      if (existing.posterOpenBillsCount === 0) {
        existing.posterOpenBillsCount = unpaidBillsByPosterId.get(posterId ?? -1)?.count ?? 0
      }
      if (existing.posterClosedBillsTotal === 0) {
        existing.posterClosedBillsTotal = posterName.closedBillsTotal
      }
      continue
    }

    rowsById.set(rowId, {
      id: rowId,
      clockId: booking.clock_booking_id,
      clockFirstName: clockName.firstName,
      clockLastName: clockName.lastName,
      posterId,
      posterCreatedAt: posterName.createdAt,
      posterOpenBillsCount: posterId !== null ? (unpaidBillsByPosterId.get(posterId)?.count ?? 0) : 0,
      posterOpenBillsTotal: posterId !== null ? (unpaidBillsByPosterId.get(posterId)?.total ?? 0) : 0,
      posterClosedBillsCount: 0,
      posterClosedBillsTotal: posterName.closedBillsTotal,
      posterFirstName: posterName.firstName,
      posterLastName: posterName.lastName,
      lastPunchAt: null,
      fitkohUserId: mapping?.fitkohUserId ?? null,
      rezervUserId: mapping?.rezervUserId ?? null,
      hasClock: true,
      hasPoster: posterId !== null,
      hasFitkoh: (mapping?.fitkohUserId ?? null) !== null,
      hasRezerv: (mapping?.rezervUserId ?? null) !== null,
    })
  }

  for (const [posterIdStr, mapping] of Object.entries(userMapping)) {
    const posterId = Number(posterIdStr)
    if (!Number.isFinite(posterId)) continue
    const rowId = `poster:${posterId}`
    if (rowsById.has(rowId)) continue

    const posterName = posterClientById.get(posterId) ?? {
      firstName: null,
      lastName: null,
      createdAt: null,
      closedBillsTotal: 0,
    }

    rowsById.set(rowId, {
      id: rowId,
      clockId: null,
      clockFirstName: null,
      clockLastName: null,
      posterId,
      posterCreatedAt: posterName.createdAt,
      posterOpenBillsCount: unpaidBillsByPosterId.get(posterId)?.count ?? 0,
      posterOpenBillsTotal: unpaidBillsByPosterId.get(posterId)?.total ?? 0,
      posterClosedBillsCount: 0,
      posterClosedBillsTotal: posterName.closedBillsTotal,
      posterFirstName: posterName.firstName,
      posterLastName: posterName.lastName,
      lastPunchAt: null,
      fitkohUserId: mapping.fitkohUserId,
      rezervUserId: mapping.rezervUserId,
      hasClock: false,
      hasPoster: true,
      hasFitkoh: mapping.fitkohUserId !== null,
      hasRezerv: mapping.rezervUserId !== null,
    })
  }

  // Attach the most recent punch event so the Guests tab can put the
  // actively-ordering user at the top (BAC-1149). Rows without a Poster ID
  // or no tracked activity get null.
  for (const row of rowsById.values()) {
    row.lastPunchAt = row.posterId !== null
      ? (lastPunchByClient[String(row.posterId)] ?? null)
      : null
  }

  function parsePunchTs(raw: string | null): number {
    if (!raw) return Number.NaN
    const ts = new Date(raw.replace(' ', 'T')).getTime()
    return Number.isFinite(ts) ? ts : Number.NaN
  }

  const rows = Array.from(rowsById.values())
  rows.sort((a, b) => {
    // Primary: most recent punch first (nulls fall through).
    const aPunch = parsePunchTs(a.lastPunchAt)
    const bPunch = parsePunchTs(b.lastPunchAt)
    const aPunchValid = Number.isFinite(aPunch)
    const bPunchValid = Number.isFinite(bPunch)
    if (aPunchValid && bPunchValid && aPunch !== bPunch) return bPunch - aPunch
    if (aPunchValid && !bPunchValid) return -1
    if (!aPunchValid && bPunchValid) return 1

    // Secondary: Poster account creation, newest first.
    const aTs = parsePunchTs(a.posterCreatedAt)
    const bTs = parsePunchTs(b.posterCreatedAt)
    const aValid = Number.isFinite(aTs)
    const bValid = Number.isFinite(bTs)
    if (aValid && bValid) return bTs - aTs
    if (aValid) return -1
    if (bValid) return 1

    // Tertiary: alphabetical by name.
    const aName = `${a.clockLastName || a.posterLastName || ''} ${a.clockFirstName || a.posterFirstName || ''}`.trim()
    const bName = `${b.clockLastName || b.posterLastName || ''} ${b.clockFirstName || b.posterFirstName || ''}`.trim()
    return aName.localeCompare(bName)
  })

  return c.json(rows)
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
  const clock = getClockClient(c.env)
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

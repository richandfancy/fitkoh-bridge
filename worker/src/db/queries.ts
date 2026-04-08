import type {
  Booking,
  BookingWithCharges,
  ActivityLogEntry,
  ActivityType,
  DeadLetter,
  SyncedTransaction,
  DashboardStats,
} from '@shared/types'

// --- Bookings ---

export async function getBooking(
  db: D1Database,
  clockBookingId: string,
): Promise<Booking | null> {
  const result = await db
    .prepare('SELECT * FROM bookings WHERE clock_booking_id = ?')
    .bind(clockBookingId)
    .first<Booking>()
  return result ?? null
}

export async function getAllBookings(
  db: D1Database,
): Promise<BookingWithCharges[]> {
  const result = await db
    .prepare(
      `SELECT b.*,
        (SELECT COUNT(*) FROM synced_transactions st
         WHERE st.clock_booking_id = b.clock_booking_id) as charge_count
       FROM bookings b
       ORDER BY b.created_at DESC`,
    )
    .all<BookingWithCharges>()
  return result.results
}

export async function createBooking(
  db: D1Database,
  data: Omit<Booking, 'created_at' | 'status'>,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO bookings
       (clock_booking_id, poster_client_id, clock_folio_id, guest_name, room_number, check_in, check_out)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      data.clock_booking_id,
      data.poster_client_id,
      data.clock_folio_id,
      data.guest_name,
      data.room_number,
      data.check_in,
      data.check_out,
    )
    .run()
}

export async function updateBookingStatus(
  db: D1Database,
  clockBookingId: string,
  status: string,
): Promise<void> {
  await db
    .prepare('UPDATE bookings SET status = ? WHERE clock_booking_id = ?')
    .bind(status, clockBookingId)
    .run()
}

// --- Activity Log ---

export async function getActivityLog(
  db: D1Database,
  options: { limit: number; offset: number; type?: ActivityType },
): Promise<ActivityLogEntry[]> {
  if (options.type) {
    const result = await db
      .prepare(
        `SELECT * FROM activity_log
         WHERE type = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(options.type, options.limit, options.offset)
      .all<ActivityLogEntry>()
    return result.results
  }

  const result = await db
    .prepare(
      `SELECT * FROM activity_log
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(options.limit, options.offset)
    .all<ActivityLogEntry>()
  return result.results
}

export async function logActivity(
  db: D1Database,
  entry: {
    type: ActivityType
    booking_id?: string
    summary: string
    payload?: string
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activity_log (type, booking_id, summary, payload)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      entry.type,
      entry.booking_id ?? null,
      entry.summary,
      entry.payload ?? null,
    )
    .run()
}

// --- Synced Transactions ---

export async function getSyncedTransactions(
  db: D1Database,
  clockBookingId: string,
): Promise<SyncedTransaction[]> {
  const result = await db
    .prepare(
      'SELECT * FROM synced_transactions WHERE clock_booking_id = ? ORDER BY synced_at DESC',
    )
    .bind(clockBookingId)
    .all<SyncedTransaction>()
  return result.results
}

export async function getSyncedTransactionIds(
  db: D1Database,
  clockBookingId: string,
): Promise<Set<string>> {
  const result = await db
    .prepare(
      'SELECT poster_transaction_id FROM synced_transactions WHERE clock_booking_id = ?',
    )
    .bind(clockBookingId)
    .all<{ poster_transaction_id: string }>()
  return new Set(result.results.map((r) => r.poster_transaction_id))
}

export async function createSyncedTransaction(
  db: D1Database,
  data: Omit<SyncedTransaction, 'synced_at'>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO synced_transactions
       (poster_transaction_id, clock_booking_id, clock_charge_id, amount_cents, product_name)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      data.poster_transaction_id,
      data.clock_booking_id,
      data.clock_charge_id,
      data.amount_cents,
      data.product_name,
    )
    .run()
}

// --- Dead Letters ---

export async function getDeadLetters(
  db: D1Database,
  unresolvedOnly?: boolean,
): Promise<DeadLetter[]> {
  if (unresolvedOnly) {
    const result = await db
      .prepare(
        'SELECT * FROM dead_letters WHERE resolved = 0 ORDER BY created_at DESC',
      )
      .all<DeadLetter>()
    return result.results
  }

  const result = await db
    .prepare('SELECT * FROM dead_letters ORDER BY created_at DESC')
    .all<DeadLetter>()
  return result.results
}

export async function createDeadLetter(
  db: D1Database,
  data: {
    clock_booking_id?: string
    operation: string
    error_message: string
    payload?: string
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dead_letters (clock_booking_id, operation, error_message, payload)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      data.clock_booking_id ?? null,
      data.operation,
      data.error_message,
      data.payload ?? null,
    )
    .run()
}

export async function retryDeadLetter(
  db: D1Database,
  id: number,
): Promise<void> {
  await db
    .prepare('UPDATE dead_letters SET retries = retries + 1 WHERE id = ?')
    .bind(id)
    .run()
}

export async function resolveDeadLetter(
  db: D1Database,
  id: number,
): Promise<void> {
  await db
    .prepare('UPDATE dead_letters SET resolved = 1 WHERE id = ?')
    .bind(id)
    .run()
}

// --- Stats ---

export async function getStats(db: D1Database): Promise<DashboardStats> {
  const result = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM bookings) as totalBookings,
        (SELECT COUNT(*) FROM bookings WHERE status = 'active') as activeBookings,
        (SELECT COUNT(*) FROM bookings WHERE status = 'synced') as syncedBookings,
        (SELECT COUNT(*) FROM dead_letters WHERE resolved = 0) as unresolvedDeadLetters,
        (SELECT COUNT(*) FROM synced_transactions) as totalChargesPosted`,
    )
    .first<DashboardStats>()

  return (
    result ?? {
      totalBookings: 0,
      activeBookings: 0,
      syncedBookings: 0,
      unresolvedDeadLetters: 0,
      totalChargesPosted: 0,
    }
  )
}

// --- Booking Detail ---

export async function getBookingDetail(
  db: D1Database,
  clockBookingId: string,
): Promise<{ booking: Booking; transactions: SyncedTransaction[] } | null> {
  const booking = await getBooking(db, clockBookingId)
  if (!booking) return null

  const transactions = await getSyncedTransactions(db, clockBookingId)
  return { booking, transactions }
}

import type { Env } from '../env'
import type { ClockClient } from './clock'
import type { ClockCharge } from '@shared/types'
import { PosterClient } from './poster'
import {
  getBooking,
  updateBookingStatus,
  getSyncedTransactionIds,
  createSyncedTransaction,
  logActivity,
  createDeadLetter,
} from '../db/queries'
import { sendAlert } from './notifications'

export async function transferInvoice(
  env: Env,
  clock: ClockClient,
  clockBookingId: string,
): Promise<void> {
  try {
    // 1. Look up booking
    const booking = await getBooking(env.DB, clockBookingId)
    if (!booking || !booking.poster_client_id) {
      throw new Error(`No booking or Poster client for ${clockBookingId}`)
    }

    // 2. Get Poster transactions for the stay
    const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
    const dateFrom = (booking.check_in || '').replace(/-/g, '')
    const dateTo = (booking.check_out || '').replace(/-/g, '')
    const transactions = await poster.getClientTransactions(
      booking.poster_client_id,
      dateFrom,
      dateTo,
    )

    // 3. Filter already-synced
    const syncedIds = await getSyncedTransactionIds(env.DB, clockBookingId)
    const newTransactions = transactions.filter(
      (t) => !syncedIds.has(t.transaction_id),
    )

    if (newTransactions.length === 0) {
      await updateBookingStatus(env.DB, clockBookingId, 'synced')
      return
    }

    // 4. Get folio
    const folio = await clock.getFolio(clockBookingId)

    // 5. Build charges from Poster transactions
    const charges: Array<{
      txId: string
      charge: ClockCharge
      productName: string
      amountCents: number
    }> = []

    for (const txn of newTransactions) {
      const [detail] = await poster.getTransaction(txn.transaction_id, true)
      if (!detail?.products) continue

      for (const product of detail.products) {
        const price = Number(product.product_price) / 100
        if (price <= 0) continue

        charges.push({
          txId: txn.transaction_id,
          charge: {
            charge_template_id: 1001, // Default food template -- configured via KV later
            text: `POS #${txn.transaction_id}`,
            price,
            qty: Number(product.num) || 1,
            service_date: txn.date_close_date?.split(' ')[0] || '',
            currency: 'THB',
            tax_rate: 0.07,
          },
          productName: `Product #${product.product_id}`,
          amountCents: Math.round(price * 100),
        })
      }
    }

    // 6. Post charges to Clock (in batches if needed, but usually small)
    if (charges.length > 0) {
      const results = await clock.postCharges(
        String(folio.id),
        charges.map((c) => c.charge),
      )

      // 7. Record synced transactions
      for (let i = 0; i < charges.length; i++) {
        await createSyncedTransaction(env.DB, {
          poster_transaction_id: `${charges[i].txId}_${i}`,
          clock_booking_id: clockBookingId,
          clock_charge_id: results[i]?.id ? String(results[i].id) : null,
          amount_cents: charges[i].amountCents,
          product_name: charges[i].productName,
        })
      }

      await logActivity(env.DB, {
        type: 'charge_posted',
        booking_id: clockBookingId,
        summary: `Posted ${charges.length} charges to folio #${folio.id} for ${booking.guest_name}`,
      })
    }

    // 8. Update status
    await updateBookingStatus(env.DB, clockBookingId, 'synced')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await createDeadLetter(env.DB, {
      clock_booking_id: clockBookingId,
      operation: 'charge_post',
      error_message: message,
    })
    await logActivity(env.DB, {
      type: 'error',
      booking_id: clockBookingId,
      summary: `Invoice transfer failed: ${message}`,
    })
    await sendAlert(
      env,
      'Invoice transfer failed',
      `Booking ${clockBookingId}: ${message}`,
    )
  }
}

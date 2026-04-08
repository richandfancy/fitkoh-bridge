import type { Env } from '../env'
import type { ClockClient } from './clock'
import { PosterClient } from './poster'
import { getBooking, createBooking, logActivity, createDeadLetter } from '../db/queries'
import { sendAlert } from './notifications'

export async function syncGuest(
  env: Env,
  clock: ClockClient,
  clockBookingId: string,
): Promise<void> {
  try {
    // 1. Check if already synced (idempotent)
    const existing = await getBooking(env.DB, clockBookingId)
    if (existing) return

    // 2. Fetch booking from Clock PMS
    const clockBooking = await clock.getBooking(clockBookingId)

    // 3. Create client in Poster (or find existing)
    const poster = new PosterClient(env.POSTER_ACCESS_TOKEN)
    let posterClientId: number

    try {
      posterClientId = await poster.createClient({
        client_name: `${clockBooking.guest_first_name} ${clockBooking.guest_last_name}`,
        client_groups_id_client: 1, // "New customers" group -- configurable via KV later
        phone: clockBooking.guest_phone_number || undefined,
        email: clockBooking.guest_e_mail || undefined,
        comment: `Clock Booking #${clockBookingId}`,
      })
    } catch {
      // Duplicate -- find existing by phone
      if (clockBooking.guest_phone_number) {
        const clients = await poster.getClients({
          phone: clockBooking.guest_phone_number,
        })
        if (clients.length > 0) {
          posterClientId = Number(clients[0].client_id)
        } else {
          throw new Error('Failed to create or find Poster client')
        }
      } else {
        throw new Error(
          'Failed to create Poster client and no phone to search by',
        )
      }
    }

    // 4. Save to D1
    await createBooking(env.DB, {
      clock_booking_id: clockBookingId,
      poster_client_id: posterClientId,
      clock_folio_id: null,
      guest_name: `${clockBooking.guest_first_name} ${clockBooking.guest_last_name}`,
      room_number: clockBooking.room_number,
      check_in: clockBooking.arrival,
      check_out: clockBooking.departure,
    })

    // 5. Log activity
    await logActivity(env.DB, {
      type: 'guest_created',
      booking_id: clockBookingId,
      summary: `Created Poster client #${posterClientId} for ${clockBooking.guest_first_name} ${clockBooking.guest_last_name} (Room ${clockBooking.room_number})`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await createDeadLetter(env.DB, {
      clock_booking_id: clockBookingId,
      operation: 'guest_create',
      error_message: message,
    })
    await logActivity(env.DB, {
      type: 'error',
      booking_id: clockBookingId,
      summary: `Guest sync failed: ${message}`,
    })
    await sendAlert(
      env,
      'Guest sync failed',
      `Booking ${clockBookingId}: ${message}`,
    )
  }
}

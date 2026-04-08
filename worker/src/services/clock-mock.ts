import type {
  ClockBooking,
  ClockFolio,
  ClockChargeTemplate,
  ClockCharge,
} from '@shared/types'
import type { ClockClient } from './clock'

const MOCK_GUESTS = [
  {
    title: 'Mr.',
    first: 'Klaus',
    last: 'Mueller',
    phone: '+49 170 1234567',
    email: 'k.mueller@gmail.com',
  },
  {
    title: 'Ms.',
    first: 'Emma',
    last: 'Thompson',
    phone: '+44 7700 900123',
    email: 'emma.thompson@outlook.com',
  },
  {
    title: 'Mr.',
    first: 'Pierre',
    last: 'Dupont',
    phone: '+33 6 12 34 56 78',
    email: 'p.dupont@free.fr',
  },
  {
    title: 'Mr.',
    first: 'Lars',
    last: 'Johansson',
    phone: '+46 70 123 4567',
    email: 'lars.johansson@telia.se',
  },
  {
    title: 'Ms.',
    first: 'Sophie',
    last: 'Weber',
    phone: '+49 151 9876543',
    email: 's.weber@web.de',
  },
  {
    title: 'Mr.',
    first: 'James',
    last: 'Wilson',
    phone: '+44 7911 123456',
    email: 'james.wilson@yahoo.co.uk',
  },
  {
    title: 'Ms.',
    first: 'Marie',
    last: 'Lefevre',
    phone: '+33 7 98 76 54 32',
    email: 'marie.lefevre@orange.fr',
  },
  {
    title: 'Mr.',
    first: 'Henrik',
    last: 'Nielsen',
    phone: '+45 20 12 34 56',
    email: 'h.nielsen@mail.dk',
  },
] as const

export const MOCK_BOOKINGS: ClockBooking[] = [
  {
    id: 1,
    number: 'BK-2026-001',
    arrival: '2026-03-10',
    departure: '2026-03-17',
    room_number: '101',
    room_type: 'Deluxe Pool Villa',
    accept_charges: true,
    guest_title: MOCK_GUESTS[0].title,
    guest_first_name: MOCK_GUESTS[0].first,
    guest_last_name: MOCK_GUESTS[0].last,
    guest_phone_number: MOCK_GUESTS[0].phone,
    guest_e_mail: MOCK_GUESTS[0].email,
  },
  {
    id: 2,
    number: 'BK-2026-002',
    arrival: '2026-03-12',
    departure: '2026-03-19',
    room_number: '105',
    room_type: 'Garden Suite',
    accept_charges: true,
    guest_title: MOCK_GUESTS[1].title,
    guest_first_name: MOCK_GUESTS[1].first,
    guest_last_name: MOCK_GUESTS[1].last,
    guest_phone_number: MOCK_GUESTS[1].phone,
    guest_e_mail: MOCK_GUESTS[1].email,
  },
  {
    id: 3,
    number: 'BK-2026-003',
    arrival: '2026-03-15',
    departure: '2026-03-22',
    room_number: '112',
    room_type: 'Beachfront Bungalow',
    accept_charges: true,
    guest_title: MOCK_GUESTS[2].title,
    guest_first_name: MOCK_GUESTS[2].first,
    guest_last_name: MOCK_GUESTS[2].last,
    guest_phone_number: MOCK_GUESTS[2].phone,
    guest_e_mail: MOCK_GUESTS[2].email,
  },
  {
    id: 4,
    number: 'BK-2026-004',
    arrival: '2026-03-20',
    departure: '2026-03-28',
    room_number: '118',
    room_type: 'Deluxe Pool Villa',
    accept_charges: true,
    guest_title: MOCK_GUESTS[3].title,
    guest_first_name: MOCK_GUESTS[3].first,
    guest_last_name: MOCK_GUESTS[3].last,
    guest_phone_number: MOCK_GUESTS[3].phone,
    guest_e_mail: MOCK_GUESTS[3].email,
  },
  {
    id: 5,
    number: 'BK-2026-005',
    arrival: '2026-03-25',
    departure: '2026-04-02',
    room_number: '203',
    room_type: 'Ocean View Room',
    accept_charges: true,
    guest_title: MOCK_GUESTS[4].title,
    guest_first_name: MOCK_GUESTS[4].first,
    guest_last_name: MOCK_GUESTS[4].last,
    guest_phone_number: MOCK_GUESTS[4].phone,
    guest_e_mail: MOCK_GUESTS[4].email,
  },
  {
    id: 6,
    number: 'BK-2026-006',
    arrival: '2026-04-01',
    departure: '2026-04-08',
    room_number: '210',
    room_type: 'Garden Suite',
    accept_charges: false,
    guest_title: MOCK_GUESTS[5].title,
    guest_first_name: MOCK_GUESTS[5].first,
    guest_last_name: MOCK_GUESTS[5].last,
    guest_phone_number: MOCK_GUESTS[5].phone,
    guest_e_mail: MOCK_GUESTS[5].email,
  },
  {
    id: 7,
    number: 'BK-2026-007',
    arrival: '2026-04-05',
    departure: '2026-04-12',
    room_number: '215',
    room_type: 'Beachfront Bungalow',
    accept_charges: true,
    guest_title: MOCK_GUESTS[6].title,
    guest_first_name: MOCK_GUESTS[6].first,
    guest_last_name: MOCK_GUESTS[6].last,
    guest_phone_number: MOCK_GUESTS[6].phone,
    guest_e_mail: MOCK_GUESTS[6].email,
  },
]

const MOCK_CHARGE_TEMPLATES: ClockChargeTemplate[] = [
  {
    id: 1001,
    text: 'Food',
    revenue_group: 'F&B',
    revenue_category: 'Restaurant',
    plain_price_cents: null,
    currency: 'THB',
    tax_rate: 0.07,
  },
  {
    id: 1002,
    text: 'Beverage',
    revenue_group: 'F&B',
    revenue_category: 'Bar',
    plain_price_cents: null,
    currency: 'THB',
    tax_rate: 0.07,
  },
  {
    id: 1003,
    text: 'Spa',
    revenue_group: 'Wellness',
    revenue_category: 'Spa Services',
    plain_price_cents: null,
    currency: 'THB',
    tax_rate: 0.07,
  },
  {
    id: 1004,
    text: 'Minibar',
    revenue_group: 'F&B',
    revenue_category: 'In-Room Dining',
    plain_price_cents: null,
    currency: 'THB',
    tax_rate: 0.07,
  },
  {
    id: 1005,
    text: 'Extra Services',
    revenue_group: 'Miscellaneous',
    revenue_category: 'Ancillary',
    plain_price_cents: null,
    currency: 'THB',
    tax_rate: 0.07,
  },
]

let chargeIdCounter = 5001

async function delay(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 150))
}

export class MockClockClient implements ClockClient {
  async getBooking(bookingId: string): Promise<ClockBooking> {
    await delay()
    const booking = MOCK_BOOKINGS.find((b) => b.number === bookingId)
    if (!booking) throw new Error(`Booking ${bookingId} not found`)
    return booking
  }

  async getFolio(bookingId: string): Promise<ClockFolio> {
    await delay()
    const booking = MOCK_BOOKINGS.find((b) => b.number === bookingId)
    if (!booking) throw new Error(`Folio not found for booking ${bookingId}`)
    return {
      id: booking.id * 100,
      name: `Main Folio - ${booking.guest_first_name} ${booking.guest_last_name}`,
      payer_type: 'guest',
    }
  }

  async postCharges(
    _folioId: string,
    charges: ClockCharge[],
  ): Promise<{ id: number; text: string }[]> {
    await delay()
    return charges.map((charge) => ({
      id: chargeIdCounter++,
      text: charge.text,
    }))
  }

  async getChargeTemplates(): Promise<ClockChargeTemplate[]> {
    await delay()
    return MOCK_CHARGE_TEMPLATES
  }
}

export async function seedDatabase(db: D1Database): Promise<void> {
  // Insert mock bookings (some with poster_client_id, some without)
  const bookingInserts = MOCK_BOOKINGS.map((b, i) => {
    // First 4 bookings have poster_client_id set; last 3 are unlinked
    const posterClientId = i < 4 ? 1000 + i : null
    return db
      .prepare(
        `INSERT OR IGNORE INTO bookings
         (clock_booking_id, poster_client_id, clock_folio_id, guest_name, room_number, check_in, check_out, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        b.number,
        posterClientId,
        i < 4 ? String(b.id * 100) : null,
        `${b.guest_first_name} ${b.guest_last_name}`,
        b.room_number,
        b.arrival,
        b.departure,
        i < 2 ? 'synced' : 'active',
      )
  })
  await db.batch(bookingInserts)

  // Insert activity log entries
  const activityEntries: Array<{
    type: string
    booking_id: string | null
    summary: string
    created_at: string
  }> = [
    {
      type: 'guest_created',
      booking_id: 'BK-2026-001',
      summary:
        'Created Poster client #1000 for Klaus Mueller (Room 101)',
      created_at: '2026-03-10 14:22:00',
    },
    {
      type: 'charge_posted',
      booking_id: 'BK-2026-001',
      summary:
        'Posted 3 charges to folio #100 for Klaus Mueller',
      created_at: '2026-03-11 20:15:00',
    },
    {
      type: 'guest_created',
      booking_id: 'BK-2026-002',
      summary:
        'Created Poster client #1001 for Emma Thompson (Room 105)',
      created_at: '2026-03-12 15:30:00',
    },
    {
      type: 'charge_posted',
      booking_id: 'BK-2026-002',
      summary:
        'Posted 5 charges to folio #200 for Emma Thompson',
      created_at: '2026-03-13 21:00:00',
    },
    {
      type: 'guest_created',
      booking_id: 'BK-2026-003',
      summary:
        'Created Poster client #1002 for Pierre Dupont (Room 112)',
      created_at: '2026-03-15 16:45:00',
    },
    {
      type: 'charge_posted',
      booking_id: 'BK-2026-003',
      summary:
        'Posted 2 charges to folio #300 for Pierre Dupont',
      created_at: '2026-03-16 19:30:00',
    },
    {
      type: 'guest_created',
      booking_id: 'BK-2026-004',
      summary:
        'Created Poster client #1003 for Lars Johansson (Room 118)',
      created_at: '2026-03-20 13:10:00',
    },
    {
      type: 'booking_new',
      booking_id: 'BK-2026-005',
      summary:
        'New booking received for Sophie Weber (Room 203, Mar 25 - Apr 2)',
      created_at: '2026-03-25 10:00:00',
    },
    {
      type: 'booking_new',
      booking_id: 'BK-2026-006',
      summary:
        'New booking received for James Wilson (Room 210, Apr 1 - Apr 8)',
      created_at: '2026-04-01 09:30:00',
    },
    {
      type: 'error',
      booking_id: 'BK-2026-005',
      summary:
        'Guest sync failed: Poster API timeout after 30s',
      created_at: '2026-03-25 10:05:00',
    },
    {
      type: 'booking_new',
      booking_id: 'BK-2026-007',
      summary:
        'New booking received for Marie Lefevre (Room 215, Apr 5 - Apr 12)',
      created_at: '2026-04-05 11:00:00',
    },
    {
      type: 'charge_posted',
      booking_id: 'BK-2026-004',
      summary:
        'Posted 4 charges to folio #400 for Lars Johansson',
      created_at: '2026-03-22 20:45:00',
    },
  ]

  const activityInserts = activityEntries.map((entry) =>
    db
      .prepare(
        `INSERT INTO activity_log (type, booking_id, summary, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(entry.type, entry.booking_id, entry.summary, entry.created_at),
  )
  await db.batch(activityInserts)

  // Insert dead letters
  const deadLetterEntries: Array<{
    clock_booking_id: string
    operation: string
    error_message: string
    retries: number
    resolved: number
    created_at: string
  }> = [
    {
      clock_booking_id: 'BK-2026-005',
      operation: 'charge_post',
      error_message:
        'Clock PMS folio #500 is closed. Cannot post charges to a finalized folio.',
      retries: 2,
      resolved: 0,
      created_at: '2026-03-28 18:30:00',
    },
    {
      clock_booking_id: 'BK-2026-003',
      operation: 'guest_create',
      error_message:
        'Poster API returned 429 Too Many Requests. Rate limit exceeded.',
      retries: 1,
      resolved: 1,
      created_at: '2026-03-15 16:40:00',
    },
    {
      clock_booking_id: 'BK-2026-006',
      operation: 'charge_post',
      error_message:
        'Booking BK-2026-006 has accept_charges=false. Guest declined room charges.',
      retries: 0,
      resolved: 0,
      created_at: '2026-04-02 14:15:00',
    },
  ]

  const deadLetterInserts = deadLetterEntries.map((entry) =>
    db
      .prepare(
        `INSERT INTO dead_letters (clock_booking_id, operation, error_message, retries, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.clock_booking_id,
        entry.operation,
        entry.error_message,
        entry.retries,
        entry.resolved,
        entry.created_at,
      ),
  )
  await db.batch(deadLetterInserts)
}

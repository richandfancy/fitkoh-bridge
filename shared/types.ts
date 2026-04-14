// Bridge webhook events
export type BridgeEventType =
  | 'meal.ordered'
  | 'guest.synced'
  | 'invoice.transferred'
  | 'error.occurred'

export interface BridgeEvent<T = unknown> {
  id: string              // unique event ID (uuid or timestamp-based)
  type: BridgeEventType
  timestamp: string        // ISO 8601
  data: T
}

export interface MealOrderedData {
  posterClientId: number
  posterProductId: string
  productName: string
  quantity: number
  price: number
  fitkohMenuItemId: number | null
  transactionId: number
  time: string             // when the item was ordered
}

export interface WebhookSubscription {
  id: number
  url: string
  events: string           // JSON array
  secret: string            // HMAC-SHA256 signing secret
  description: string | null
  active: number
  created_at: string
  last_triggered_at: string | null
  last_status_code: number | null
  failure_count: number
}

// Activity types
export type ActivityType =
  | 'booking_new'
  | 'guest_created'
  | 'checkout'
  | 'charge_posted'
  | 'cache_warmed'
  | 'error'
export type BookingStatus = 'active' | 'checked_out' | 'synced'

// D1 row types
export interface Booking {
  clock_booking_id: string
  poster_client_id: number | null
  clock_folio_id: string | null
  guest_name: string | null
  room_number: string | null
  check_in: string | null
  check_out: string | null
  status: BookingStatus
  created_at: string
}

export interface SyncedTransaction {
  poster_transaction_id: string
  clock_booking_id: string
  clock_charge_id: string | null
  amount_cents: number | null
  product_name: string | null
  synced_at: string
}

export interface ActivityLogEntry {
  id: number
  type: ActivityType
  booking_id: string | null
  summary: string
  payload: string | null
  created_at: string
}

export interface DeadLetter {
  id: number
  clock_booking_id: string | null
  operation: string
  error_message: string | null
  payload: string | null
  retries: number
  resolved: number // 0 or 1 (SQLite boolean)
  created_at: string
}

// Dashboard stats
export interface DashboardStats {
  totalBookings: number
  activeBookings: number
  syncedBookings: number
  unresolvedDeadLetters: number
  totalChargesPosted: number
}

// Booking with charge count (for list view)
export interface BookingWithCharges extends Booking {
  charge_count: number
}

// Poster API types
export interface PosterClient {
  client_id: string
  firstname: string
  lastname: string
  phone: string
  email: string
  comment: string
  client_groups_id: string
  client_groups_name: string
  total_payed_sum: string
}

export interface PosterTransaction {
  transaction_id: string
  date_start: string
  date_close: string
  date_close_date: string
  status: string
  sum: string
  client_id: string
  client_firstname: string | null
  client_lastname: string | null
  table_name: string
  name: string // waiter/location
  spot_id?: string
  products?: PosterTransactionProduct[]
}

export interface PosterTransactionProduct {
  product_id: string
  modification_id: string
  num: string
  product_price: string
  tax_sum: string
}

export interface PosterTransactionHistoryEntry {
  transaction_id: string
  type_history: string // 'additem' | 'open' | 'close' | etc
  time: string // epoch ms
  value: string // product_id for additem
  value_text: string
}

// Clock API types (for mock interface)
export interface ClockBooking {
  id: number
  number: string
  arrival: string
  departure: string
  room_number: string
  room_type: string
  accept_charges: boolean
  guest_title: string
  guest_first_name: string
  guest_last_name: string
  guest_phone_number: string
  guest_e_mail: string
}

export interface ClockFolio {
  id: number
  name: string
  payer_type: string
}

export interface ClockChargeTemplate {
  id: number
  text: string
  revenue_group: string
  revenue_category: string
  plain_price_cents: number | null
  currency: string
  tax_rate: number
}

export interface ClockCharge {
  charge_template_id: number
  text: string
  price: number
  qty: number
  service_date: string
  currency: string
  tax_rate: number
}

// SNS webhook payload from Clock PMS
export interface SNSWebhookPayload {
  TopicArn: string
  Subject: string
  Message: string
  Timestamp: string
  Signature?: string
}

// Pre-invoice types
export interface PreInvoiceDay {
  date: string
  items: PreInvoiceItem[]
  subtotal: number
  deduction: number
  net: number
}

export interface PreInvoiceItem {
  name: string
  quantity: number
  unitPrice: number
  totalPrice: number
  mealPlanIncluded: boolean
}

export interface PreInvoiceResponse {
  guestName: string
  posterClientId: number
  dateRange: { from: string; to: string }
  days: PreInvoiceDay[]
  totals: {
    gross: number
    totalDeductions: number
    finalAmount: number
  }
}

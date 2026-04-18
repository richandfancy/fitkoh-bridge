// Runtime Zod schemas for the two hottest Poster API response shapes.
//
// Poster's JSON is loosely typed — numeric IDs arrive as strings on some
// endpoints and numbers on others (see `.ai/LEARNINGS.md`). Without runtime
// validation, a silent field rename or type flip on Poster's side corrupts
// the KV snapshot and every dashboard that reads it.
//
// We only validate the shapes that feed the live-orders pipeline:
//   - dash.getTransactions        → PosterTransactionSchema
//   - transactions.getTransactions → PosterDetailedTransactionSchema
//
// Everything else continues to use the plain TypeScript types in
// `./types.ts`. This is intentional — a big-bang Zod rewrite would add
// parse overhead on every Poster call; we establish the pattern on the
// hot paths first and expand only when drift bites.
//
// Both schemas are `.passthrough()`: unknown fields are tolerated so new
// Poster additions don't break the bridge. Removed / renamed fields DO
// trigger a failed parse, which we surface as a Sentry type-drift alert.

import { z } from 'zod'

// Normalize Poster's "string or number" numeric IDs to plain strings.
// Keep the output a `string` to match the existing TypeScript types in
// shared/types.ts so this schema is a drop-in validator.
const NumericIdString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))

// Normalize to number. Used for fields where downstream code treats the
// value as a number (table_id, spot_id, transaction_id in the detailed feed).
const NumericIdNumber = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))

// --- dash.getTransactions -------------------------------------------------
//
// Used by orders-feed for client_id + client name + spot name lookups and
// for open/closed bill counts. Field-level notes:
//   - transaction_id: numeric, sometimes returned as string. Normalized to
//     string to match the existing PosterTransaction TS type.
//   - date_start / date_close: unix-ms strings ("1776400559048") per the
//     .ai/LEARNINGS.md timestamp-format note. Left as raw strings.
//   - client_id: "0" when unassigned; otherwise a stringified numeric ID.
//   - status: "1" = open, "2" = closed, "3" = void (documented strings).
//   - sum: value in satang (Thai "cents"), string.
//   - products / spot_id / table_name / name are present on some responses
//     only — marked optional to match reality.
export const PosterTransactionSchema = z
  .object({
    transaction_id: NumericIdString,
    date_start: z.string(),
    date_close: z.string(),
    date_close_date: z.string().optional(),
    status: z.string(),
    sum: z.string(),
    client_id: NumericIdString,
    client_firstname: z.string().nullable().optional(),
    client_lastname: z.string().nullable().optional(),
    table_name: z.string().optional(),
    name: z.string().optional(),
    spot_id: z.union([z.string(), z.number()]).optional(),
    products: z
      .array(
        z
          .object({
            product_id: NumericIdString,
            modification_id: z.string().optional(),
            num: z.string().optional(),
            product_price: z.string().optional(),
            tax_sum: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

export type PosterTransactionParsed = z.infer<typeof PosterTransactionSchema>

// --- transactions.getTransactions (detailed) -----------------------------
//
// Used by orders-feed for per-line products with table/spot IDs. Notes:
//   - transaction_id / client_id / table_id / spot_id: arrive as numbers
//     most of the time, but Poster has leaked strings here before — coerce.
//   - date_close: "YYYY-MM-DD HH:MM:SS" string (different format from the
//     dash feed — see .ai/LEARNINGS.md).
//   - products[*].num arrives as a number on this feed (unlike the dash
//     feed where it's a string). Keep as `number | string` for safety.
export const PosterDetailedProductSchema = z
  .object({
    product_id: NumericIdNumber,
    num: z.union([z.string(), z.number()]).transform((v) => Number(v)),
    product_sum: z.string(),
  })
  .passthrough()

export const PosterDetailedTransactionSchema = z
  .object({
    transaction_id: NumericIdNumber,
    date_close: z.string(),
    client_id: NumericIdNumber,
    table_id: NumericIdNumber,
    spot_id: NumericIdNumber,
    // `.nullish()` tolerates both `null` and `undefined`; `.default([])`
    // collapses both to an empty array so downstream `(t.products || [])`
    // is redundant but harmless.
    products: z
      .array(PosterDetailedProductSchema)
      .nullish()
      .transform((v) => v ?? []),
  })
  .passthrough()

export type PosterDetailedTransactionParsed = z.infer<
  typeof PosterDetailedTransactionSchema
>

// Tests for the `toIso` normalizer that converts Poster's multiple timestamp
// formats into ISO 8601.
//
// Why this has its own file: `toIso` is small and pure but every piece of the
// live-orders pipeline — sort order, freshness checks, "last punch" per-user
// — depends on it. The silent-NaN bug that shipped before BAC-1149 would
// have been caught by these assertions.

import { describe, expect, it } from 'vitest'
import { toIso } from './orders-feed'

describe('toIso', () => {
  it('converts a unix-ms string from dash.getTransactions to ISO', () => {
    // 1776400559048 ms = 2026-04-17T04:35:59.048Z (UTC). Verified against
    // `new Date(1776400559048).toISOString()` — documented here so the next
    // test reader doesn't have to.
    expect(toIso('1776400559048')).toBe('2026-04-17T04:35:59.048Z')
  })

  it('normalizes transactions.getTransactions "YYYY-MM-DD HH:MM:SS" by replacing the space', () => {
    // Poster doesn't tell us the timezone here — the worker elsewhere treats
    // it as ICT (+07:00). `toIso` only does format normalization; tz is the
    // caller's problem.
    expect(toIso('2026-04-17 14:47:35')).toBe('2026-04-17T14:47:35')
  })

  it('returns null for the literal Poster sentinel "0"', () => {
    // dash.getTransactions returns `date_close: "0"` for open bills. Anything
    // that treats this as a real timestamp produces a 1970 date and wrecks
    // sort order.
    expect(toIso('0')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(toIso('')).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(toIso(undefined)).toBeNull()
  })

  it('returns null for non-numeric junk without a date separator', () => {
    expect(toIso('garbage')).toBeNull()
  })

  it('returns null for a non-positive ms value', () => {
    // Number("-1") is finite but <= 0 — rejected by the `ms > 0` guard.
    expect(toIso('-1')).toBeNull()
  })

  it('converts a ms value near the max valid JS Date range to an ISO string', () => {
    // 8_640_000_000_000_000 ms = maximum representable Date per ECMA-262.
    // Anything strictly larger makes `toISOString()` throw RangeError, which
    // the current `toIso` does not guard against. The spec calls for a "large
    // valid ms" input, so we use a value near (but still inside) the range.
    const result = toIso('8000000000000000')
    expect(result).not.toBeNull()
    expect(result).toMatch(/^\+?\d{4,6}-\d{2}-\d{2}T/)
  })
})

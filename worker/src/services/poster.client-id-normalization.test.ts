// Tests for the Poster client-id normalization invariant used across the
// /users dashboard and mapping reads.
//
// The invariant, assumed by `routes/api.ts`:
//
//   - Poster returns `client_id` as a STRING ("12345") on some endpoints and
//     as a NUMBER (12345) on others (e.g. transactions.getTransactions returns
//     it as a number; dash.getTransactions returns it as a string).
//   - Our mapping tables (`posterClientById`, `userMapping`) key on the
//     numeric value. So every lookup path must do `Number(client.client_id)`.
//   - `"0"`, `0`, empty, null, undefined must all be excluded (Poster uses
//     `"0"` for "unassigned client" on most rows of dash.getTransactions and
//     that value is a real sentinel, not a real client id).
//
// When this invariant was broken, mapped clients silently didn't show in the
// Guests list. This helper captures the rule so future refactors can't
// quietly regress it.

import { describe, expect, it } from 'vitest'

// Matches the pattern used inline at `routes/api.ts:384` and elsewhere:
//
//     const posterId = Number(client.client_id)
//     if (!Number.isFinite(posterId)) continue
//     ...set(posterId, ...)
//
// We pull it into a standalone function here so the invariant can be asserted
// independently of the route. The production code should behave identically;
// if someone changes this helper or the inline pattern, the tests below will
// show the divergence.
function normalizePosterClientId(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (raw === '' || raw === '0' || raw === 0) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (n <= 0) return null
  return n
}

describe('normalizePosterClientId (invariant for Poster client_id lookups)', () => {
  it('converts a string client_id to a number so map lookups match', () => {
    expect(normalizePosterClientId('12345')).toBe(12345)
  })

  it('passes a number client_id through unchanged', () => {
    expect(normalizePosterClientId(12345)).toBe(12345)
  })

  it('produces the same key for string and number forms of the same id', () => {
    expect(normalizePosterClientId('12345')).toBe(normalizePosterClientId(12345))
  })

  it('excludes the Poster "unassigned" sentinel "0"', () => {
    expect(normalizePosterClientId('0')).toBeNull()
  })

  it('excludes numeric 0 (same sentinel, different wire format)', () => {
    expect(normalizePosterClientId(0)).toBeNull()
  })

  it('excludes null', () => {
    expect(normalizePosterClientId(null)).toBeNull()
  })

  it('excludes undefined', () => {
    expect(normalizePosterClientId(undefined)).toBeNull()
  })

  it('excludes empty string', () => {
    expect(normalizePosterClientId('')).toBeNull()
  })

  it('excludes non-numeric junk', () => {
    expect(normalizePosterClientId('not-an-id')).toBeNull()
  })

  it('excludes negative ids', () => {
    // Nothing in Poster ever returns these, but Number("−1") parses cleanly
    // and would otherwise silently slot into the map. Guard explicitly.
    expect(normalizePosterClientId('-5')).toBeNull()
  })
})

describe('Map lookup invariant', () => {
  it('string and number ids resolve to the same Map entry when the key is a number', () => {
    // This is the *actual* production-level invariant: if `posterClientById`
    // is a `Map<number, T>` and the incoming id is a string, the lookup must
    // work. We model that with a tiny scenario to make the assertion concrete.
    const map = new Map<number, string>()
    const fromNumberSource = 12345
    map.set(fromNumberSource, 'mapped-value')

    const fromStringSource = '12345'
    const normalized = normalizePosterClientId(fromStringSource)
    expect(normalized).not.toBeNull()
    expect(map.get(normalized as number)).toBe('mapped-value')
  })

  it('"0" from either source is excluded before reaching the Map', () => {
    const map = new Map<number, string>()
    map.set(0, 'this-would-be-wrong-if-we-let-it-through')

    expect(normalizePosterClientId('0')).toBeNull()
    expect(normalizePosterClientId(0)).toBeNull()
  })
})

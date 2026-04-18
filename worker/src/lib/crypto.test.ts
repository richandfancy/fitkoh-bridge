// Unit tests for HMAC session + magic-link token helpers.
//
// These run under the workers pool so `crypto.subtle` behaves exactly as in
// production — the same Web Crypto implementation signs both here and on the
// live Worker.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  createMagicLinkToken,
  createSessionToken,
  verifyMagicLinkToken,
  verifySessionToken,
} from './crypto'

const SECRET = 'test-secret-dashboard-hmac-key'
const OTHER_SECRET = 'a-different-secret-entirely'

describe('createMagicLinkToken / verifyMagicLinkToken', () => {
  it('roundtrips: verify returns the original email plus hmac + expiresAt', async () => {
    const token = await createMagicLinkToken(SECRET, 'jon@example.com')
    const result = await verifyMagicLinkToken(SECRET, token)
    // BAC-1212 widened the return shape from `{email}` to
    // `{email, hmac, expiresAt}` so /auth/callback can key the single-use KV
    // record off the hmac.
    expect(result?.email).toBe('jon@example.com')
    expect(typeof result?.hmac).toBe('string')
    expect(result?.hmac.length).toBeGreaterThan(20)
    expect(typeof result?.expiresAt).toBe('number')
    expect(result!.expiresAt).toBeGreaterThan(Date.now())
  })

  it('rejects a tampered signature (single flipped bit)', async () => {
    const token = await createMagicLinkToken(SECRET, 'jon@example.com')
    const parts = token.split('.')
    // Flip the last hex char of the signature, which changes one nibble (4
    // bits). constantTimeEqual must refuse the mutated HMAC.
    const lastChar = parts[2].slice(-1)
    const flipped = lastChar === 'f' ? 'e' : 'f'
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${flipped}`

    const result = await verifyMagicLinkToken(SECRET, tampered)
    expect(result).toBeNull()
  })

  it('rejects a token with an expired expiresAt timestamp', async () => {
    const realNow = Date.now
    // Issue the token one second in the past relative to the verification
    // moment. Magic links expire 15 minutes after issue, so we rewind 16.
    const verifyAtMs = 1_800_000_000_000 // arbitrary fixed instant
    const issueAtMs = verifyAtMs - 16 * 60 * 1000

    vi.spyOn(Date, 'now').mockReturnValue(issueAtMs)
    const token = await createMagicLinkToken(SECRET, 'jon@example.com')
    vi.spyOn(Date, 'now').mockReturnValue(verifyAtMs)
    const result = await verifyMagicLinkToken(SECRET, token)

    Date.now = realNow
    expect(result).toBeNull()
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await createMagicLinkToken(SECRET, 'jon@example.com')
    const result = await verifyMagicLinkToken(OTHER_SECRET, token)
    expect(result).toBeNull()
  })

  // TODO(BAC-1212): once magic-link-hardening lands with single-use
  // enforcement (consumed-tokens KV bookkeeping), re-enable the test below.
  // The second verifyMagicLinkToken call for the same token should return
  // null even when the signature and expiry are still valid.
  //
  // it.todo('rejects a replayed token on the second verify (single-use)', async () => {
  //   const token = await createMagicLinkToken(SECRET, 'jon@example.com')
  //   expect(await verifyMagicLinkToken(SECRET, token)).toEqual({ email: 'jon@example.com' })
  //   expect(await verifyMagicLinkToken(SECRET, token)).toBeNull()
  // })
})

describe('createSessionToken / verifySessionToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('roundtrips: verify returns true for a fresh token', async () => {
    const token = await createSessionToken(SECRET)
    const ok = await verifySessionToken(SECRET, token)
    expect(ok).toBe(true)
  })

  it('rejects a token older than SESSION_MAX_AGE_MS (30 days)', async () => {
    const verifyAtMs = 1_800_000_000_000
    // Issue the session 30 days + 1 second ago.
    const issueAtMs = verifyAtMs - (30 * 24 * 60 * 60 * 1000 + 1000)

    vi.spyOn(Date, 'now').mockReturnValue(issueAtMs)
    const token = await createSessionToken(SECRET)
    vi.spyOn(Date, 'now').mockReturnValue(verifyAtMs)
    const ok = await verifySessionToken(SECRET, token)

    expect(ok).toBe(false)
  })

  it('rejects a tampered signature (single flipped bit)', async () => {
    const token = await createSessionToken(SECRET)
    const dotIdx = token.indexOf('.')
    const ts = token.substring(0, dotIdx)
    const sig = token.substring(dotIdx + 1)
    const lastChar = sig.slice(-1)
    const flipped = lastChar === 'f' ? 'e' : 'f'
    const tampered = `${ts}.${sig.slice(0, -1)}${flipped}`

    const ok = await verifySessionToken(SECRET, tampered)
    expect(ok).toBe(false)
  })
})

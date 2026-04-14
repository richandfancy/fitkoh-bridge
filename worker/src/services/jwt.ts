// Bridge JWT helpers — HS256 sign/verify using Web Crypto (Workers native).
//
// Tokens are short-lived (seconds-to-hours) and scoped to a single
// `posterClientId` so the FitKoh app can call the bridge from the browser
// without exposing the master API key. See /api/v1/auth/token for issuance.

import type { Env } from '../env'

export interface BridgeJwtPayload {
  sub: number // posterClientId
  scope: string // e.g. 'meals:read'
  iat: number
  exp: number
}

const DEV_FALLBACK_SECRET = 'dev-secret-change-in-prod'

function getSecret(env: Env): string {
  if (!env.JWT_SECRET) {
    if (env.ENVIRONMENT === 'production') throw new Error('JWT_SECRET must be set in production')
    return DEV_FALLBACK_SECRET
  }
  return env.JWT_SECRET
}

function base64UrlEncode(data: Uint8Array | string): string {
  let str: string
  if (typeof data === 'string') {
    // Encode string as UTF-8 bytes before base64 so non-ASCII payloads
    // (e.g. accented names) survive the round-trip.
    const bytes = new TextEncoder().encode(data)
    str = String.fromCharCode(...bytes)
  } else {
    str = String.fromCharCode(...data)
  }
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function base64UrlDecode(input: string): string {
  let str = input.replace(/-/g, '+').replace(/_/g, '/')
  const pad = str.length % 4
  if (pad) str += '='.repeat(4 - pad)
  const binary = atob(str)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return base64UrlEncode(new Uint8Array(sig))
}

// Constant-time string compare — avoids leaking timing info via `===`.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Sign a new bridge JWT.
 *
 * @param env               Worker env (reads `JWT_SECRET`, dev fallback if missing)
 * @param payload           `sub` + `scope` claims (iat/exp are set automatically)
 * @param expiresInSeconds  Lifetime in seconds — caller should clamp to a sane range
 */
export async function signJwt(
  env: Env,
  payload: Omit<BridgeJwtPayload, 'iat' | 'exp'>,
  expiresInSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const fullPayload: BridgeJwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  }
  const header = { alg: 'HS256', typ: 'JWT' }
  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = await hmacSign(getSecret(env), signingInput)
  return `${signingInput}.${signature}`
}

/**
 * Verify a bridge JWT. Returns the payload on success, or `null` if the
 * signature is invalid, the token is malformed, or it has expired.
 */
export async function verifyJwt(
  env: Env,
  token: string,
): Promise<BridgeJwtPayload | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [encodedHeader, encodedPayload, signature] = parts
    const signingInput = `${encodedHeader}.${encodedPayload}`
    const expected = await hmacSign(getSecret(env), signingInput)
    if (!timingSafeEqual(expected, signature)) return null

    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as BridgeJwtPayload
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.exp !== 'number' || payload.exp < now) return null
    if (typeof payload.sub !== 'number') return null
    return payload
  } catch {
    return null
  }
}

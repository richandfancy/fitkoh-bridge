// API key management for public /api/v1 endpoints

export interface ApiKey {
  id: number
  name: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  scopes: string[]
}

// Raw DB row shape for api_keys — `scopes` is stored as a JSON string.
interface ApiKeyRow {
  id: number
  name: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  scopes: string | null
}

// Fallback scopes for rows predating migration 0006 or written with a
// malformed scopes blob. Matches the migration's column default so legacy
// keys keep the same "full access" behavior they had before scopes existed.
const LEGACY_FULL_SCOPES: string[] = ['meals:read:all', 'meals:write']

function parseScopes(raw: string | null): string[] {
  if (!raw) return LEGACY_FULL_SCOPES
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      return parsed
    }
  } catch {
    // fall through
  }
  return LEGACY_FULL_SCOPES
}

/**
 * Check whether a scope list satisfies a required scope.
 *
 * A `:all` scope is treated as a wildcard for its resource+action pair — so
 * `meals:read:all` satisfies both `meals:read:all` and `meals:read:self`.
 * Exact matches always pass.
 */
export function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes(required)) return true

  const parts = required.split(':')
  // Only apply the wildcard rule when the required scope is of the form
  // "{resource}:{action}:{target}" — otherwise there's no `:all` variant.
  if (parts.length !== 3) return false

  const wildcard = `${parts[0]}:${parts[1]}:all`
  return scopes.includes(wildcard)
}

// Hash a key using Web Crypto SHA-256 (Workers compatible)
export async function hashKey(key: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(key)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Generate a new API key: "fbk_" + 48 random hex chars
export function generateKey(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `fbk_${hex}`
}

export async function createApiKey(
  db: D1Database,
  name: string,
): Promise<{ id: number; key: string; prefix: string }> {
  const key = generateKey()
  const hashed = await hashKey(key)
  const prefix = key.slice(0, 12) // "fbk_abc12345"

  const result = await db
    .prepare(
      'INSERT INTO api_keys (name, hashed_key, key_prefix) VALUES (?, ?, ?) RETURNING id',
    )
    .bind(name, hashed, prefix)
    .first<{ id: number }>()

  if (!result) throw new Error('Failed to create API key')
  return { id: result.id, key, prefix }
}

export async function listApiKeys(db: D1Database): Promise<ApiKey[]> {
  const result = await db
    .prepare(
      'SELECT id, name, key_prefix, created_at, last_used_at, revoked_at, scopes FROM api_keys ORDER BY created_at DESC',
    )
    .all<ApiKeyRow>()
  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    scopes: parseScopes(row.scopes),
  }))
}

export async function verifyApiKey(
  db: D1Database,
  rawKey: string,
): Promise<ApiKey | null> {
  const hashed = await hashKey(rawKey)
  const row = await db
    .prepare(
      'SELECT id, name, key_prefix, created_at, last_used_at, revoked_at, scopes FROM api_keys WHERE hashed_key = ? AND revoked_at IS NULL',
    )
    .bind(hashed)
    .first<ApiKeyRow>()

  if (!row) return null

  // Update last_used_at (fire-and-forget, don't block response)
  await db
    .prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?')
    .bind(row.id)
    .run()

  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    scopes: parseScopes(row.scopes),
  }
}

export async function revokeApiKey(
  db: D1Database,
  id: number,
): Promise<void> {
  await db
    .prepare('UPDATE api_keys SET revoked_at = datetime(\'now\') WHERE id = ?')
    .bind(id)
    .run()
}

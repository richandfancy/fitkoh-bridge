// API key management for public /api/v1 endpoints

export interface ApiKey {
  id: number
  name: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
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
      'SELECT id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC',
    )
    .all<ApiKey>()
  return result.results
}

export async function verifyApiKey(
  db: D1Database,
  rawKey: string,
): Promise<ApiKey | null> {
  const hashed = await hashKey(rawKey)
  const row = await db
    .prepare(
      'SELECT id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE hashed_key = ? AND revoked_at IS NULL',
    )
    .bind(hashed)
    .first<ApiKey>()

  if (!row) return null

  // Update last_used_at (fire-and-forget, don't block response)
  await db
    .prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?')
    .bind(row.id)
    .run()

  return row
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

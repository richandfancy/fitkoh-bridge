import type { Env } from '../env'

const CRON_HEALTH_KEY = 'bridge_health:last_cron_ok_at'
const STALE_CRON_AFTER_MS = 180_000

export async function recordCronSuccess(env: Env, now = new Date()): Promise<void> {
  await env.CONFIG.put(CRON_HEALTH_KEY, now.toISOString())
}

export async function getCronHealth(env: Env, now = Date.now()): Promise<{
  lastCronOkAt: string | null
  staleCron: boolean
  cronAgeSeconds: number | null
}> {
  const lastCronOkAt = await env.CONFIG.get(CRON_HEALTH_KEY)
  if (!lastCronOkAt) {
    return { lastCronOkAt: null, staleCron: true, cronAgeSeconds: null }
  }

  const ageMs = now - new Date(lastCronOkAt).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return { lastCronOkAt, staleCron: true, cronAgeSeconds: null }
  }

  return {
    lastCronOkAt,
    staleCron: ageMs > STALE_CRON_AFTER_MS,
    cronAgeSeconds: Math.floor(ageMs / 1000),
  }
}

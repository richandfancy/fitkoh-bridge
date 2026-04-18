import type { Env } from '../env'
import type { ClockClient } from './clock'
import { MockClockClient } from './clock-mock'

/**
 * Returns the Clock PMS client to use for the current request.
 *
 * Until real Clock credentials arrive from Pavel, this always returns the
 * `MockClockClient`. Once a real `ClockClient` implementation lands (see
 * `services/clock.ts` for the interface), swap in:
 *
 *   return new ClockClient({
 *     apiKey: env.CLOCK_API_KEY,
 *     accountId: env.CLOCK_ACCOUNT_ID!,
 *   })
 *
 * gated behind `env.CLOCK_API_KEY` so local dev and staging without creds
 * continue to fall back to the mock without any route/service changes.
 */
export function getClockClient(env: Env): ClockClient {
  if (!env.CLOCK_API_KEY) return new MockClockClient()
  // Real ClockClient doesn't exist yet. Until credentials arrive, returning
  // MockClockClient keeps behaviour unchanged. When the real client lands,
  // instantiate it here (see docblock above).
  return new MockClockClient()
}

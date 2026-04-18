// Dedup-path tests for the auto-importer.
//
// Shape under test:
//
//   INSERT OR IGNORE INTO auto_imported_items (...)
//     -> if a row was inserted (claim), dispatch
//       -> on dispatch success: leave the row as the dedup marker
//       -> on dispatch failure: DELETE the row so the next tick can retry
//     -> if no row was inserted (someone else claimed), skip silently
//
// These run under the workers pool so `env.DB` is a real D1 instance. The
// pool declares a throwaway in-memory D1 in `worker/vitest.config.ts`. The
// `auto_imported_items` schema is re-applied per-test in `beforeEach` so
// tests never leak rows at each other.
//
// We go through the public `importItemsForUser` entry point because it
// exercises the real claim + dispatch + DELETE flow. The only two outbound
// dependencies are mocked: PosterClient.getTransactionProducts (so we don't
// hit Poster) and global fetch (so we don't hit FitKoh).

import { env } from 'cloudflare:test'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { Env as WorkerEnv } from '../env'
import { PosterClient } from './poster'
import { importItemsForUser } from './auto-importer'

// `env` from `cloudflare:test` is typed as `Cloudflare.Env` (the auto-inferred
// bindings shape). Our code takes `worker/src/env.ts:Env`. The two describe
// the same Miniflare bindings, so a single widening cast keeps every test
// assertion readable.
const testEnv = env as unknown as WorkerEnv

const MAPPED_POSTER_CLIENT_ID = 4242
const FITKOH_USER_ID = 99
const PRODUCT_ID = '777'
const FITKOH_MENU_ITEM_ID = 11

async function resetTable() {
  // The `auto_imported_items` table is created by migration 0003. Recreate it
  // per test to fully isolate dedup state — isolated miniflare state still
  // shares the schema within a file run.
  await env.DB.prepare('DROP TABLE IF EXISTS auto_imported_items').run()
  await env.DB.prepare(
    `CREATE TABLE auto_imported_items (
       id TEXT PRIMARY KEY,
       poster_client_id INTEGER NOT NULL,
       fitkoh_user_id INTEGER NOT NULL,
       fitkoh_menu_item_id INTEGER NOT NULL,
       poster_product_name TEXT,
       imported_at TEXT DEFAULT (datetime('now'))
     )`,
  ).run()
}

async function seedKvMappings() {
  await env.CONFIG.put(
    'poster_to_fitkoh_users',
    JSON.stringify({
      [String(MAPPED_POSTER_CLIENT_ID)]: {
        fitkohUserId: FITKOH_USER_ID,
        name: 'Test Guest',
      },
    }),
  )
  await env.CONFIG.put(
    'poster_to_fitkoh_items',
    JSON.stringify({ [PRODUCT_ID]: FITKOH_MENU_ITEM_ID }),
  )
}

function makeNewItem(overrides: Partial<{
  id: string
  transactionId: number
  productId: number
  clientId: number
  time: string
}> = {}) {
  return {
    id: `${MAPPED_POSTER_CLIENT_ID}:${overrides.transactionId ?? 1001}:0`,
    productId: overrides.productId ?? Number(PRODUCT_ID),
    productName: 'Test Product',
    quantity: 1,
    price: 100,
    time: overrides.time ?? '1776400559048',
    transactionId: overrides.transactionId ?? 1001,
    clientId: overrides.clientId ?? MAPPED_POSTER_CLIENT_ID,
  }
}

describe('auto-importer dedup path (via importItemsForUser)', () => {
  beforeAll(() => {
    // `FITKOH_API_URL` and `FITKOH_API_KEY` aren't in `[vars]` of
    // wrangler.toml (they're production secrets). Inject them so
    // `logToFitkoh` doesn't short-circuit with a misleading error.
    testEnv.FITKOH_API_URL = 'https://fitkoh.test'
    testEnv.FITKOH_API_KEY = 'test-api-key'
  })

  beforeEach(async () => {
    await resetTable()
    await seedKvMappings()

    // PosterClient call is irrelevant to dedup — just return one product line
    // matching the item we pass in so one DispatchableItem is built.
    vi.spyOn(PosterClient.prototype, 'getTransactionProducts').mockResolvedValue(
      [{ product_id: PRODUCT_ID, num: '1', product_sum: '100', time: '1776400559048' }],
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('happy path: claim + dispatch + row persists, second tick is a no-op', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await importItemsForUser(testEnv, [
      makeNewItem(),
    ])
    expect(first).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const rowsAfter = await env.DB.prepare(
      'SELECT id FROM auto_imported_items',
    ).all()
    expect(rowsAfter.results.length).toBe(1)

    // Second tick with the exact same id → INSERT OR IGNORE is a no-op, no
    // new fetch is fired.
    fetchMock.mockClear()
    const second = await importItemsForUser(testEnv, [
      makeNewItem(),
    ])
    expect(second).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  // TODO(BAC-1215): revisit once keep-claim-on-failure lands. After that
  // change, a dispatch failure should LEAVE the row claimed (maybe with a
  // retry-counter column) so the next tick can see it was already tried and
  // apply retry classification rules, instead of blindly re-claiming.
  it('dispatch failure: row is DELETEd so the next tick re-claims (CURRENT behavior)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('kaboom', { status: 500 })) // first tick fails
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) // retry succeeds
    vi.stubGlobal('fetch', fetchMock)

    const first = await importItemsForUser(testEnv, [
      makeNewItem(),
    ])
    expect(first).toBe(0) // error path returned 0 dispatched

    const rowsAfterFail = await env.DB.prepare(
      'SELECT id FROM auto_imported_items',
    ).all()
    // Current behavior: DELETE unwinds the claim so retries can happen.
    expect(rowsAfterFail.results.length).toBe(0)

    const second = await importItemsForUser(testEnv, [
      makeNewItem(),
    ])
    expect(second).toBe(1)

    const rowsAfterRetry = await env.DB.prepare(
      'SELECT id FROM auto_imported_items',
    ).all()
    expect(rowsAfterRetry.results.length).toBe(1)
  })

  it('race: two concurrent ticks calling INSERT OR IGNORE on the same id — only one dispatches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const item = makeNewItem()
    const [a, b] = await Promise.all([
      importItemsForUser(testEnv, [item]),
      importItemsForUser(testEnv, [item]),
    ])

    // Exactly one tick claims the row and dispatches. The other's
    // INSERT OR IGNORE produces changes=0 and it skips silently.
    expect(a + b).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const rows = await env.DB.prepare('SELECT id FROM auto_imported_items').all()
    expect(rows.results.length).toBe(1)
  })
})

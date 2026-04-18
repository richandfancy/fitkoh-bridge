// Worker-runtime Vitest config.
//
// Tests live beside the code in `worker/src/**/*.test.ts` and run inside a
// real Workers isolate via `@cloudflare/vitest-pool-workers`. The pool is the
// ONLY way to get accurate behavior for `KVNamespace`, `D1Database`, and
// `ExecutionContext` — a Node shim would silently diverge from production.
//
// We deliberately do NOT pass `wrangler.configPath` here. The real
// wrangler.toml references `../dist` via its `[assets]` block, which only
// exists after `pnpm build`. Tests should run against a freshly cloned repo
// without a build step, so we declare only the bindings tests actually need
// (DB, CONFIG) with an inline Miniflare config.
//
// Migrations are applied per-test (see auto-importer.dedup.test.ts) rather
// than via `readD1Migrations()` so each suite is explicit about the schema
// it depends on. When we add more suites that need shared schema we can
// revisit — for now, isolation beats convenience.
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import path from 'node:path'

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2024-12-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: {
          DB: 'fitkoh-bridge-test-db',
        },
        kvNamespaces: {
          CONFIG: 'fitkoh-bridge-test-kv',
        },
        // Dummy secrets — real tests inject their own via the `env` object.
        bindings: {
          POSTER_ACCESS_TOKEN: 'test-poster-token',
          DASHBOARD_SECRET: 'test-dashboard-secret',
          RESEND_API_KEY: 'test-resend-key',
          APP_NAME: 'FitKoh Bridge (Test)',
          ENVIRONMENT: 'test',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      // Mirror the root tsconfig paths so imports like `@shared/types`
      // resolve the same under the runner.
      '@shared': path.resolve(__dirname, '..', 'shared'),
    },
  },
})

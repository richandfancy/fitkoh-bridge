// Augment `Cloudflare.Env` (used by the `env` export of `cloudflare:test`)
// with the bindings we declare in vitest.config.ts. Without this, test files
// that touch `env.DB` / `env.CONFIG` fail type-check even though they work
// fine at runtime.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    CONFIG: KVNamespace
    POSTER_ACCESS_TOKEN: string
    DASHBOARD_SECRET: string
    RESEND_API_KEY: string
    APP_NAME: string
    ENVIRONMENT: string
    FITKOH_API_URL?: string
    FITKOH_API_KEY?: string
  }
}

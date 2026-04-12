export interface Env {
  DB: D1Database
  CONFIG: KVNamespace
  ASSETS: Fetcher
  POSTER_ACCESS_TOKEN: string
  DASHBOARD_SECRET: string
  RESEND_API_KEY: string
  APP_NAME: string
  ENVIRONMENT: string
  // Optional — HS256 secret for bridge JWTs issued to FitKoh app users.
  // Falls back to a hard-coded dev value in services/jwt.ts if unset.
  JWT_SECRET?: string
  // Optional — HTTP Basic auth password for /docs and /api/v1/openapi.json.
  // Falls back to a dev password if unset.
  DOCS_PASSWORD?: string
  // Optional — FitKoh auto-import config. When both are set, the cron trigger
  // will auto-import Poster orders for mapped users into FitKoh.
  FITKOH_API_URL?: string
  FITKOH_API_KEY?: string
}

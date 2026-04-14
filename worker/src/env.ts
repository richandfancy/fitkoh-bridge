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
  // FitKoh trainer endpoint — bridge dispatches meal.ordered events as a
  // FitKoh trainer user (BAC-1068) instead of a custom webhook. These are
  // required in production; if unset, auto-import will log and skip dispatch.
  FITKOH_API_URL?: string
  FITKOH_API_KEY?: string
}

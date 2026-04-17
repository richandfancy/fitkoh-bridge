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
  // Comma-separated list of admin emails allowed to sign in to the dashboard
  // via magic link (BAC-1080). Case-insensitive; callers should lowercase
  // before comparing. Required in production — if unset, request-link will
  // refuse all requests.
  BRIDGE_ADMIN_EMAILS?: string
  // Optional Sentry DSN for Worker error reporting.
  SENTRY_DSN?: string
}

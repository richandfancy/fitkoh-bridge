export interface Env {
  DB: D1Database
  CONFIG: KVNamespace
  ASSETS: Fetcher
  POSTER_ACCESS_TOKEN: string
  DASHBOARD_SECRET: string
  RESEND_API_KEY: string
  APP_NAME: string
  ENVIRONMENT: string
}

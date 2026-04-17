import { useEffect, useRef, useState } from 'react'
import { UserRound } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/EmptyState'
import { Skeleton } from '@/components/Skeleton'
import type { UserMatchRow } from '@shared/types'

const POLL_INTERVAL_MS = 15_000

function formatPosterDate(value: string | null): string {
  if (!value) return '—'
  const parsed = value.replace(' ', 'T')
  const date = new Date(parsed)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatRelative(value: string | null, now: number): string {
  if (!value) return '—'
  const parsed = value.replace(' ', 'T')
  const ts = new Date(parsed).getTime()
  if (!Number.isFinite(ts)) return '—'
  const deltaSec = Math.max(0, Math.round((now - ts) / 1000))
  if (deltaSec < 60) return `${deltaSec}s ago`
  const deltaMin = Math.round(deltaSec / 60)
  if (deltaMin < 60) return `${deltaMin}m ago`
  const deltaHr = Math.round(deltaMin / 60)
  if (deltaHr < 24) return `${deltaHr}h ago`
  const deltaDay = Math.round(deltaHr / 24)
  return `${deltaDay}d ago`
}

function formatAmount(total: number | null | undefined): string {
  const n = typeof total === 'number' ? total : Number(total ?? 0)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return `฿${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function SourceDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        active ? 'bg-status-green' : 'bg-muted-foreground/30'
      }`}
    />
  )
}

export function UsersPage() {
  const [rows, setRows] = useState<UserMatchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const isFetchingRef = useRef(false)

  const load = async (opts: { showSkeleton?: boolean } = {}) => {
    if (isFetchingRef.current) return
    isFetchingRef.current = true
    if (opts.showSkeleton) setLoading(true)
    try {
      const data = await api.get<UserMatchRow[]>('/api/dashboard/users')
      setRows(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users')
    } finally {
      if (opts.showSkeleton) setLoading(false)
      isFetchingRef.current = false
    }
  }

  useEffect(() => {
    load({ showSkeleton: true })
    const onRefresh = () => load()
    window.addEventListener('bridge:guests:refresh', onRefresh)
    return () => window.removeEventListener('bridge:guests:refresh', onRefresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll for fresh data while the page is visible. BAC-1149: puts the user
  // with the most recent order at the top as orders come in.
  useEffect(() => {
    let interval: number | null = null
    const start = () => {
      if (interval !== null) return
      interval = window.setInterval(() => load(), POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (interval !== null) {
        window.clearInterval(interval)
        interval = null
      }
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        load()
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tick once a second to keep relative timestamps fresh without refetching.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  if (loading) {
    return (
      <div className="space-y-3 animate-fade-in">
        <h1 className="text-xl font-semibold mb-2">Guests</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Cross-system matching across Clock, Poster, FitKoh, and Rezerv.
        </p>
        {Array.from({ length: 6 }).map((_, idx) => (
          <div key={idx} className="bg-card border border-border rounded-xl p-4">
            <div className="grid grid-cols-2 md:grid-cols-8 gap-3">
              {Array.from({ length: 8 }).map((__, innerIdx) => (
                <Skeleton key={innerIdx} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="animate-fade-in">
        <h1 className="text-xl font-semibold mb-4">Guests</h1>
        <div className="bg-card border border-destructive/30 rounded-xl p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="animate-fade-in">
        <h1 className="text-xl font-semibold mb-2">Guests</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Cross-system matching across Clock, Poster, FitKoh, and Rezerv.
        </p>
        <EmptyState
          icon={UserRound}
          title="No guests found"
          description="Users will appear when bookings, Poster clients, or mappings exist."
        />
      </div>
    )
  }

  return (
    <div className="animate-fade-in-up pb-24">
      <h1 className="text-xl font-semibold mb-2">Guests</h1>
      <p className="text-sm text-muted-foreground mb-4">
        Matching dashboard for user identities across source systems.
      </p>

      {/* Mobile: vertical card list so the page never horizontal-scrolls. */}
      <div className="md:hidden space-y-2">
        {rows.map((row) => {
          const displayName =
            `${row.clockFirstName ?? row.posterFirstName ?? ''} ${row.clockLastName ?? row.posterLastName ?? ''}`.trim()
            || (row.posterId !== null ? `Poster #${row.posterId}` : 'Unknown guest')
          const hasOpen = row.posterOpenBillsTotal > 0
          return (
            <div
              key={row.id}
              className="bg-card border border-border rounded-xl p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground truncate">
                    {displayName}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {row.posterId !== null ? `Poster #${row.posterId}` : 'No Poster ID'}
                    {row.posterCreatedAt && ` · ${formatPosterDate(row.posterCreatedAt)}`}
                  </div>
                </div>
                <div className="text-xs tabular-nums shrink-0">
                  {row.lastOrderAt ? (
                    <span className="text-primary font-medium">
                      {formatRelative(row.lastOrderAt, now)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-secondary/40 px-2.5 py-1.5">
                  <div className="text-muted-foreground">Open</div>
                  <div
                    className={cn(
                      'font-semibold tabular-nums',
                      hasOpen ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {formatAmount(row.posterOpenBillsTotal)}
                  </div>
                </div>
                <div className="rounded-lg bg-secondary/40 px-2.5 py-1.5">
                  <div className="text-muted-foreground">Closed</div>
                  <div className="font-semibold tabular-nums text-foreground">
                    {formatAmount(row.posterClosedBillsTotal)}
                  </div>
                </div>
              </div>

              {(row.fitkohUserId !== null || row.rezervUserId !== null) && (
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  {row.fitkohUserId !== null && (
                    <span className="rounded-md bg-secondary/60 px-1.5 py-0.5 text-muted-foreground">
                      FitKoh #{row.fitkohUserId}
                    </span>
                  )}
                  {row.rezervUserId !== null && (
                    <span className="rounded-md bg-secondary/60 px-1.5 py-0.5 text-muted-foreground">
                      Rezerv {row.rezervUserId}
                    </span>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><SourceDot active={row.hasClock} />Clock</span>
                <span className="inline-flex items-center gap-1"><SourceDot active={row.hasPoster} />Poster</span>
                <span className="inline-flex items-center gap-1"><SourceDot active={row.hasFitkoh} />FitKoh</span>
                <span className="inline-flex items-center gap-1"><SourceDot active={row.hasRezerv} />Rezerv</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Desktop: original wide table. */}
      <div className="hidden md:block bg-card border border-border rounded-xl overflow-x-auto">
        <table className="w-full min-w-[1060px] text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-xs">
              <th className="text-left px-4 py-3 font-medium">Last Order</th>
              <th className="text-left px-4 py-3 font-medium">Clock ID</th>
              <th className="text-left px-4 py-3 font-medium">Clock Firstname</th>
              <th className="text-left px-4 py-3 font-medium">Clock Lastname</th>
              <th className="text-left px-4 py-3 font-medium">Poster ID</th>
              <th className="text-left px-4 py-3 font-medium">Poster Firstname</th>
              <th className="text-left px-4 py-3 font-medium">Poster Lastname</th>
              <th className="text-left px-4 py-3 font-medium">Poster Created</th>
              <th className="text-left px-4 py-3 font-medium">Open Bills Total</th>
              <th className="text-left px-4 py-3 font-medium">Closed Bills Total</th>
              <th className="text-left px-4 py-3 font-medium">FitKoh User ID</th>
              <th className="text-left px-4 py-3 font-medium">Rezerv User ID</th>
              <th className="text-left px-4 py-3 font-medium">Sources</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 text-foreground whitespace-nowrap">
                  {row.lastOrderAt ? (
                    <span className="text-primary">{formatRelative(row.lastOrderAt, now)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-foreground">{row.clockId ?? '—'}</td>
                <td className="px-4 py-3 text-foreground">{row.clockFirstName ?? '—'}</td>
                <td className="px-4 py-3 text-foreground">{row.clockLastName ?? '—'}</td>
                <td className="px-4 py-3 text-foreground">{row.posterId ?? '—'}</td>
                <td className="px-4 py-3 text-foreground">{row.posterFirstName ?? '—'}</td>
                <td className="px-4 py-3 text-foreground">{row.posterLastName ?? '—'}</td>
                <td className="px-4 py-3 text-foreground">{formatPosterDate(row.posterCreatedAt)}</td>
                <td className="px-4 py-3 text-foreground">{formatAmount(row.posterOpenBillsTotal)}</td>
                <td className="px-4 py-3 text-foreground">{formatAmount(row.posterClosedBillsTotal)}</td>
                <td className="px-4 py-3 text-foreground">{row.fitkohUserId ?? '—'}</td>
                <td className="px-4 py-3 text-foreground">{row.rezervUserId ?? '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1"><SourceDot active={row.hasClock} />Clock</span>
                    <span className="inline-flex items-center gap-1"><SourceDot active={row.hasPoster} />Poster</span>
                    <span className="inline-flex items-center gap-1"><SourceDot active={row.hasFitkoh} />FitKoh</span>
                    <span className="inline-flex items-center gap-1"><SourceDot active={row.hasRezerv} />Rezerv</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

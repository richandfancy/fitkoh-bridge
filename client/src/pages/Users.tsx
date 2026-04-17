import { useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState } from '@/components/EmptyState'
import { Skeleton } from '@/components/Skeleton'
import type { UserMatchRow } from '@shared/types'

function formatPosterDate(value: string | null): string {
  if (!value) return '—'
  const parsed = value.replace(' ', 'T')
  const date = new Date(parsed)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
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

  const load = () => {
    setLoading(true)
    api.get<UserMatchRow[]>('/api/dashboard/users')
      .then(setRows)
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load users')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const onRefresh = () => load()
    window.addEventListener('bridge:guests:refresh', onRefresh)
    return () => window.removeEventListener('bridge:guests:refresh', onRefresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      <div className="bg-card border border-border rounded-xl overflow-x-auto">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-xs">
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

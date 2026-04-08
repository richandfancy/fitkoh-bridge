import { useState, useEffect } from 'react'
import { useRoute, useLocation } from 'wouter'
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw, User } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatDate, formatCurrency, formatRelativeTime } from '@/lib/utils'
import { Badge } from '@/components/Badge'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import type { Booking, SyncedTransaction, PosterTransaction } from '@shared/types'

interface GuestDetailData {
  booking: Booking
  transactions: SyncedTransaction[]
}

interface MealDay {
  date: string
  transactions: PosterTransaction[]
  total: number
}

export function GuestDetailPage() {
  const [, params] = useRoute('/guests/:id')
  const [, setLocation] = useLocation()
  const id = params?.id

  const [data, setData] = useState<GuestDetailData | null>(null)
  const [meals, setMeals] = useState<MealDay[]>([])
  const [loading, setLoading] = useState(true)
  const [mealsLoading, setMealsLoading] = useState(false)
  const [mealsError, setMealsError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [activeTab, setActiveTab] = useState<'charges' | 'meals'>('charges')
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!id) return
    setLoading(true)
    api.get<GuestDetailData>(`/api/dashboard/guests/${id}`)
      .then(setData)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load guest'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    if (!id || !data?.booking.poster_client_id) return
    setMealsLoading(true)
    api.get<PosterTransaction[]>(`/api/dashboard/guests/${id}/meals`)
      .then(txns => {
        const dayMap = new Map<string, PosterTransaction[]>()
        for (const txn of txns) {
          const date = txn.date_close_date || txn.date_close?.split(' ')[0] || 'Unknown'
          if (!dayMap.has(date)) dayMap.set(date, [])
          dayMap.get(date)!.push(txn)
        }
        const days: MealDay[] = Array.from(dayMap.entries())
          .map(([date, transactions]) => ({
            date,
            transactions,
            total: transactions.reduce((sum, t) => sum + (Number(t.sum) || 0), 0),
          }))
          .sort((a, b) => b.date.localeCompare(a.date))

        setMeals(days)
        setExpandedDays(new Set(days.slice(0, 2).map(d => d.date)))
      })
      .catch(err => setMealsError(err instanceof Error ? err.message : 'Failed to load meals'))
      .finally(() => setMealsLoading(false))
  }, [id, data?.booking.poster_client_id])

  const handleSync = async () => {
    if (!id) return
    setSyncing(true)
    try {
      await api.post(`/api/admin/sync/${id}`)
      const refreshed = await api.get<GuestDetailData>(`/api/dashboard/guests/${id}`)
      setData(refreshed)
    } catch {
      // Error handled silently — the UI state updates
    } finally {
      setSyncing(false)
    }
  }

  const toggleDay = (date: string) => {
    setExpandedDays(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-fade-in">
        <Skeleton className="h-6 w-32" />
        <div className="bg-card border border-border rounded-xl p-4 space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="animate-fade-in">
        <button onClick={() => setLocation('/guests')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors">
          <ArrowLeft size={16} /> Back to Guests
        </button>
        <div className="bg-card border border-destructive/30 rounded-xl p-6 text-center">
          <p className="text-sm text-destructive">{error || 'Guest not found'}</p>
        </div>
      </div>
    )
  }

  const { booking, transactions } = data
  const hasPoster = booking.poster_client_id !== null
  const mealsGrandTotal = meals.reduce((sum, d) => sum + d.total, 0)

  return (
    <div className="space-y-4 animate-fade-in-up pb-24">
      {/* Back nav */}
      <button onClick={() => setLocation('/guests')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
        <ArrowLeft size={16} /> Back to Guests
      </button>

      {/* Guest info card */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold text-foreground">{booking.guest_name || 'Unknown Guest'}</h1>
            {booking.room_number && <p className="text-sm text-muted-foreground">Room {booking.room_number}</p>}
          </div>
          <Badge variant={booking.status}>{booking.status.replace('_', ' ')}</Badge>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Check-in</p>
            <p className="text-foreground">{booking.check_in ? formatDate(booking.check_in) : '-'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Check-out</p>
            <p className="text-foreground">{booking.check_out ? formatDate(booking.check_out) : '-'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Clock Booking ID</p>
            <p className="text-foreground font-mono text-xs">{booking.clock_booking_id}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Poster Client ID</p>
            <p className={cn('font-mono text-xs', hasPoster ? 'text-foreground' : 'text-muted-foreground')}>{hasPoster ? booking.poster_client_id : 'Not synced'}</p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          {hasPoster && (
            <button
              onClick={() => setLocation(`/pre-invoice/${booking.poster_client_id}`)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              <ExternalLink size={14} />
              Pre-Invoice
            </button>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary text-secondary-foreground text-xs font-semibold disabled:opacity-50 transition-opacity"
          >
            {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {syncing ? 'Syncing...' : 'Manual Sync'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-secondary rounded-xl p-1">
        <button
          onClick={() => setActiveTab('charges')}
          className={cn(
            'flex-1 py-2 text-xs font-medium rounded-lg transition-colors',
            activeTab === 'charges' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
          )}
        >
          Synced Charges ({transactions.length})
        </button>
        {hasPoster && (
          <button
            onClick={() => setActiveTab('meals')}
            className={cn(
              'flex-1 py-2 text-xs font-medium rounded-lg transition-colors',
              activeTab === 'meals' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            )}
          >
            Meals from Poster
          </button>
        )}
      </div>

      {/* Charges tab */}
      {activeTab === 'charges' && (
        <div className="animate-fade-in">
          {transactions.length === 0 ? (
            <EmptyState icon={User} title="No synced charges" description="Charges will appear here when posted to Clock" />
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="text-left px-4 py-3 font-medium">Product</th>
                    <th className="text-right px-4 py-3 font-medium">Amount</th>
                    <th className="text-right px-4 py-3 font-medium">Synced</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map(txn => (
                    <tr key={txn.poster_transaction_id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 text-foreground">{txn.product_name || 'Unknown'}</td>
                      <td className="px-4 py-3 text-right text-foreground">{txn.amount_cents !== null ? formatCurrency(txn.amount_cents / 100) : '-'}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground text-xs">{formatRelativeTime(txn.synced_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Meals tab */}
      {activeTab === 'meals' && hasPoster && (
        <div className="space-y-2 animate-fade-in">
          {mealsLoading && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded-xl p-4 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                  <Skeleton className="h-3 w-24" />
                </div>
              ))}
            </div>
          )}

          {mealsError && (
            <div className="bg-card border border-destructive/30 rounded-xl p-4 text-center">
              <p className="text-sm text-destructive">{mealsError}</p>
            </div>
          )}

          {!mealsLoading && !mealsError && meals.length === 0 && (
            <EmptyState icon={User} title="No meals found" description="No Poster transactions for this guest" />
          )}

          {meals.map(day => (
            <div key={day.date} className="bg-card border border-border rounded-xl overflow-hidden">
              <button
                onClick={() => toggleDay(day.date)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/30 transition-colors"
              >
                <span className="text-sm font-medium text-foreground">{formatDate(day.date)}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{formatCurrency(day.total / 100)}</span>
                  {expandedDays.has(day.date) ? <ChevronDown size={16} className="text-muted-foreground" /> : <ChevronRight size={16} className="text-muted-foreground" />}
                </div>
              </button>
              {expandedDays.has(day.date) && (
                <div className="border-t border-border">
                  {day.transactions.map(txn => (
                    <div key={txn.transaction_id} className="px-4 py-2 flex items-center justify-between text-sm border-b border-border/50 last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="text-foreground truncate">{txn.table_name || txn.name || `Transaction #${txn.transaction_id}`}</p>
                        <p className="text-xs text-muted-foreground">{txn.date_close ? formatRelativeTime(txn.date_close) : ''}</p>
                      </div>
                      <span className="text-foreground font-medium">{formatCurrency(Number(txn.sum) / 100)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {meals.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">Grand Total</span>
              <span className="text-lg font-bold text-foreground">{formatCurrency(mealsGrandTotal / 100)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

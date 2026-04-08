import { useState, useEffect } from 'react'
import { useRoute } from 'wouter'
import { FileText, Loader2, Printer } from 'lucide-react'
import { api } from '@/lib/api'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { Badge } from '@/components/Badge'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import type { BookingWithCharges, PreInvoiceResponse } from '@shared/types'

export function PreInvoicePage() {
  const [, params] = useRoute('/pre-invoice/:posterClientId')
  const paramClientId = params?.posterClientId

  const [guests, setGuests] = useState<BookingWithCharges[]>([])
  const [guestsLoading, setGuestsLoading] = useState(false)
  const [selectedClientId, setSelectedClientId] = useState(paramClientId || '')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [invoice, setInvoice] = useState<PreInvoiceResponse | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch guests for the selector if no client ID in URL
  useEffect(() => {
    if (paramClientId) {
      setSelectedClientId(paramClientId)
      return
    }
    setGuestsLoading(true)
    api.get<BookingWithCharges[]>('/api/dashboard/guests')
      .then(data => {
        const withPoster = data.filter(g => g.poster_client_id !== null)
        setGuests(withPoster)
      })
      .catch(() => {})
      .finally(() => setGuestsLoading(false))
  }, [paramClientId])

  // Set default dates when a guest is selected
  useEffect(() => {
    if (!selectedClientId || paramClientId) return
    const guest = guests.find(g => String(g.poster_client_id) === selectedClientId)
    if (guest) {
      if (guest.check_in) setDateFrom(guest.check_in.split('T')[0])
      setDateTo(new Date().toISOString().split('T')[0])
    }
  }, [selectedClientId, guests, paramClientId])

  // Set default date range if came from URL
  useEffect(() => {
    if (paramClientId && !dateTo) {
      setDateTo(new Date().toISOString().split('T')[0])
    }
  }, [paramClientId, dateTo])

  const handleGenerate = async () => {
    if (!selectedClientId) return
    setGenerating(true)
    setError(null)
    setInvoice(null)
    try {
      const queryParams = new URLSearchParams()
      if (dateFrom) queryParams.set('dateFrom', dateFrom)
      if (dateTo) queryParams.set('dateTo', dateTo)
      const data = await api.get<PreInvoiceResponse>(`/api/dashboard/pre-invoice/${selectedClientId}?${queryParams}`)
      setInvoice(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate pre-invoice')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-4 animate-fade-in-up pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Pre-Invoice</h1>
        {invoice && (
          <button
            onClick={() => window.print()}
            className="no-print flex items-center gap-1.5 px-3 py-2 rounded-xl bg-secondary text-secondary-foreground text-xs font-semibold hover:bg-secondary/80 transition-colors"
          >
            <Printer size={14} />
            Print
          </button>
        )}
      </div>

      {/* Controls */}
      <div className="no-print bg-card border border-border rounded-xl p-4 space-y-3">
        {!paramClientId && (
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Guest</label>
            {guestsLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <select
                value={selectedClientId}
                onChange={e => setSelectedClientId(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Select a guest</option>
                {guests.map(g => (
                  <option key={g.clock_booking_id} value={String(g.poster_client_id)}>
                    {g.guest_name || 'Unknown'} — Room {g.room_number || '?'}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <button
          onClick={handleGenerate}
          disabled={generating || !selectedClientId}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-primary text-primary-foreground font-semibold disabled:opacity-50 transition-opacity"
        >
          {generating ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
          {generating ? 'Generating...' : 'Generate'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-card border border-destructive/30 rounded-xl p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {/* Results */}
      {invoice && (
        <div className="space-y-4 animate-fade-in-up">
          {/* Header */}
          <div className="bg-card border border-border rounded-xl p-4">
            <h2 className="text-lg font-semibold text-foreground">{invoice.guestName}</h2>
            <p className="text-sm text-muted-foreground">
              {formatDate(invoice.dateRange.from)} — {formatDate(invoice.dateRange.to)}
            </p>
          </div>

          {/* Daily breakdowns */}
          {invoice.days.length === 0 ? (
            <EmptyState icon={FileText} title="No items found" description="No transactions in this date range" />
          ) : (
            invoice.days.map(day => (
              <div key={day.date} className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <span className="text-sm font-semibold text-foreground">{formatDate(day.date)}</span>
                </div>

                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 text-xs text-muted-foreground">
                      <th className="text-left px-4 py-2 font-medium">Item</th>
                      <th className="text-right px-4 py-2 font-medium">Qty</th>
                      <th className="text-right px-4 py-2 font-medium">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.items.map((item, idx) => (
                      <tr key={idx} className="border-b border-border/30 last:border-0">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-foreground">{item.name}</span>
                            {item.mealPlanIncluded && <Badge variant="synced">Included</Badge>}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{item.quantity}</td>
                        <td className={cn('px-4 py-2 text-right', item.mealPlanIncluded ? 'line-through text-muted-foreground' : 'text-foreground')}>
                          {formatCurrency(item.totalPrice)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="border-t border-border px-4 py-2 space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Subtotal</span>
                    <span>{formatCurrency(day.subtotal)}</span>
                  </div>
                  {day.deduction > 0 && (
                    <div className="flex justify-between text-xs text-status-green">
                      <span>Meal plan deduction</span>
                      <span>-{formatCurrency(day.deduction)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-medium text-foreground">
                    <span>Net</span>
                    <span>{formatCurrency(day.net)}</span>
                  </div>
                </div>
              </div>
            ))
          )}

          {/* Summary card */}
          {invoice.days.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4 space-y-2">
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Gross Total</span>
                <span>{formatCurrency(invoice.totals.gross)}</span>
              </div>
              {invoice.totals.totalDeductions > 0 && (
                <div className="flex justify-between text-sm text-status-green">
                  <span>Total Deductions (3 meals/day included)</span>
                  <span>-{formatCurrency(invoice.totals.totalDeductions)}</span>
                </div>
              )}
              <hr className="border-border" />
              <div className="flex justify-between items-center">
                <span className="text-sm font-semibold text-foreground">Amount Due</span>
                <span className="text-xl font-bold text-foreground">{formatCurrency(invoice.totals.finalAmount)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

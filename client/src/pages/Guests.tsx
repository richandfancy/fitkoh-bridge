import { useState, useEffect } from 'react'
import { useLocation } from 'wouter'
import { Users } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { Badge } from '@/components/Badge'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import type { BookingWithCharges } from '@shared/types'

export function GuestsPage() {
  const [, setLocation] = useLocation()
  const [guests, setGuests] = useState<BookingWithCharges[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<BookingWithCharges[]>('/api/dashboard/guests')
      .then(data => {
        const sorted = [...data].sort((a, b) => {
          const dateA = a.check_in ? new Date(a.check_in).getTime() : 0
          const dateB = b.check_in ? new Date(b.check_in).getTime() : 0
          return dateB - dateA
        })
        setGuests(sorted)
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load guests'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="space-y-3 animate-fade-in">
        <h1 className="text-xl font-semibold mb-4">Guests</h1>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-5 w-16" />
            </div>
            <div className="flex items-center gap-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
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

  return (
    <div className="animate-fade-in-up pb-24">
      <h1 className="text-xl font-semibold mb-4">Guests</h1>

      {guests.length === 0 ? (
        <EmptyState icon={Users} title="No guests yet" description="Guests will appear when bookings are received" />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs">
                  <th className="text-left px-4 py-3 font-medium">Guest Name</th>
                  <th className="text-left px-4 py-3 font-medium">Room</th>
                  <th className="text-left px-4 py-3 font-medium">Check-in</th>
                  <th className="text-left px-4 py-3 font-medium">Check-out</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Poster</th>
                </tr>
              </thead>
              <tbody>
                {guests.map(guest => (
                  <tr
                    key={guest.clock_booking_id}
                    onClick={() => setLocation(`/guests/${guest.clock_booking_id}`)}
                    className="border-b border-border last:border-0 hover:bg-secondary/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 font-medium text-foreground">{guest.guest_name || 'Unknown'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{guest.room_number || '-'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{guest.check_in ? formatDate(guest.check_in) : '-'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{guest.check_out ? formatDate(guest.check_out) : '-'}</td>
                    <td className="px-4 py-3"><Badge variant={guest.status}>{guest.status.replace('_', ' ')}</Badge></td>
                    <td className="px-4 py-3">
                      <PosterStatus synced={guest.poster_client_id !== null} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {guests.map(guest => (
              <div
                key={guest.clock_booking_id}
                onClick={() => setLocation(`/guests/${guest.clock_booking_id}`)}
                className="bg-card border border-border rounded-xl p-4 hover:bg-secondary/50 cursor-pointer transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-foreground">{guest.guest_name || 'Unknown'}</span>
                  <Badge variant={guest.status}>{guest.status.replace('_', ' ')}</Badge>
                </div>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  {guest.room_number && <span>Room {guest.room_number}</span>}
                  {guest.check_in && <span>{formatDate(guest.check_in)}</span>}
                  <PosterStatus synced={guest.poster_client_id !== null} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function PosterStatus({ synced }: { synced: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`w-1.5 h-1.5 rounded-full ${synced ? 'bg-status-green' : 'bg-muted-foreground/40'}`} />
      <span className={synced ? 'text-status-green' : 'text-muted-foreground'}>{synced ? 'Synced' : 'Not synced'}</span>
    </span>
  )
}

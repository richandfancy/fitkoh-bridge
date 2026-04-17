import { useEffect, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { PosterClientGroup } from '@shared/types'

interface CreateUserDrawerProps {
  open: boolean
  onClose: () => void
}

export function CreateUserDrawer({ open, onClose }: CreateUserDrawerProps) {
  const [groups, setGroups] = useState<PosterClientGroup[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [creating, setCreating] = useState(false)

  const [groupId, setGroupId] = useState<number | ''>('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [patronymic, setPatronymic] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [birthday, setBirthday] = useState('')
  const [gender, setGender] = useState<number | ''>('')
  const [cardNumber, setCardNumber] = useState('')
  const [comment, setComment] = useState('')
  const [country, setCountry] = useState('')
  const [city, setCity] = useState('')
  const [address, setAddress] = useState('')

  const hasGroup = typeof groupId === 'number' && groupId > 0
  const hasIdentity = Boolean(
    firstName.trim() || lastName.trim() || phone.trim() || email.trim(),
  )
  const canCreate = hasGroup && hasIdentity && !creating

  useEffect(() => {
    if (!open) return
    setLoadingGroups(true)
    api.get<PosterClientGroup[]>('/api/dashboard/poster/client-groups')
      .then((data) => setGroups(data))
      .catch(() => toast.error('Failed to load Poster groups'))
      .finally(() => setLoadingGroups(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const handleCreate = async () => {
    if (!canCreate) return
    setCreating(true)
    try {
      const result = await api.post<{ posterClientId: number }>(
        '/api/dashboard/poster/clients',
        {
          groupId,
          firstName,
          lastName,
          patronymic,
          phone,
          email,
          birthday,
          gender: typeof gender === 'number' ? gender : undefined,
          cardNumber,
          comment,
          country,
          city,
          address,
        },
      )
      toast.success(`Created Poster user #${result.posterClientId}`)
      onClose()
      window.dispatchEvent(new CustomEvent('bridge:guests:refresh'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  if (!open) return null

  return (
    <div className="no-print fixed inset-0 z-[70]">
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="absolute bottom-0 left-0 right-0 max-h-[85dvh] bg-card border-t border-border rounded-t-3xl shadow-2xl overflow-hidden">
        <div className="px-4 pt-3 pb-2 flex items-center justify-between border-b border-border">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Create User</h2>
            <p className="text-xs text-muted-foreground">Creates a client directly in Poster</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close drawer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4 overflow-y-auto max-h-[calc(85dvh-120px)] space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Group</label>
              <select
                value={groupId}
                onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground appearance-none focus:outline-none focus:ring-2 focus:ring-ring"
                disabled={loadingGroups}
              >
                <option value="">{loadingGroups ? 'Loading…' : 'Select group'}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <div className="text-xs text-muted-foreground">
                {groups.length === 0 && !loadingGroups ? 'No groups found in Poster.' : ''}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Firstname</label>
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Lastname</label>
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Patronymic</label>
              <input value={patronymic} onChange={(e) => setPatronymic(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Birthday</label>
              <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Gender</label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground appearance-none focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Not specified</option>
                <option value="1">Male</option>
                <option value="2">Female</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Card number</label>
              <input value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">Comment</label>
              <input value={comment} onChange={(e) => setComment(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="text-xs font-semibold text-foreground mb-2">Address</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Country</label>
                <input value={country} onChange={(e) => setCountry(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">City</label>
                <input value={city} onChange={(e) => setCity(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-muted-foreground mb-1">Address</label>
                <input value={address} onChange={(e) => setAddress(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2 bg-card">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-secondary text-foreground text-sm font-semibold hover:opacity-95 transition-opacity"
            disabled={creating}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canCreate}
            className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 transition-opacity flex items-center gap-2"
          >
            {creating && <Loader2 size={14} className="animate-spin" />}
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

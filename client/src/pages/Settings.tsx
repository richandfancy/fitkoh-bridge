import { useState, useEffect } from 'react'
import { Loader2, Save, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import type { ClockChargeTemplate } from '@shared/types'

const POSTER_CATEGORIES = ['Food', 'Beverage', 'Spa', 'Services', 'Other'] as const

interface Mappings {
  [posterCategory: string]: number | null
}

export function SettingsPage() {
  const [templates, setTemplates] = useState<ClockChargeTemplate[]>([])
  const [mappings, setMappings] = useState<Mappings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tplData, mapData] = await Promise.all([
          api.get<ClockChargeTemplate[]>('/api/dashboard/config/templates'),
          api.get<Mappings>('/api/dashboard/config/mappings'),
        ])
        setTemplates(tplData)
        setMappings(mapData)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load settings')
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  const handleMappingChange = (category: string, templateId: string) => {
    setMappings(prev => ({
      ...prev,
      [category]: templateId ? Number(templateId) : null,
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.put('/api/dashboard/config/mappings', mappings)
      toast.success('Mappings saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-fade-in">
        <h1 className="text-xl font-semibold mb-4">Settings</h1>
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          {POSTER_CATEGORIES.map(cat => (
            <div key={cat} className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-48" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="animate-fade-in">
        <h1 className="text-xl font-semibold mb-4">Settings</h1>
        <div className="bg-card border border-destructive/30 rounded-xl p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 animate-fade-in-up pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <div className="bg-card border border-border rounded-xl p-4">
        <h2 className="text-sm font-semibold text-foreground mb-1">Charge Template Mappings</h2>
        <p className="text-xs text-muted-foreground mb-4">Map Poster categories to Clock PMS charge templates</p>

        {templates.length === 0 ? (
          <EmptyState icon={Settings} title="No templates available" description="Clock charge templates will appear here when configured" />
        ) : (
          <div className="space-y-3">
            {POSTER_CATEGORIES.map(category => (
              <div key={category} className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium text-foreground shrink-0">{category}</span>
                <select
                  value={mappings[category] ?? ''}
                  onChange={e => handleMappingChange(category, e.target.value)}
                  className="flex-1 max-w-xs px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Not mapped</option>
                  {templates.map(tpl => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.text} ({tpl.revenue_category})
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-primary text-primary-foreground font-semibold disabled:opacity-50 transition-opacity"
      >
        {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
        {saving ? 'Saving...' : 'Save Mappings'}
      </button>
    </div>
  )
}

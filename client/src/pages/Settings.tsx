import { useState, useEffect } from 'react'
import { Loader2, Save, Settings, Key, Plus, Trash2, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Skeleton } from '@/components/Skeleton'
import { EmptyState } from '@/components/EmptyState'
import { formatRelativeTime } from '@/lib/utils'
import type { ClockChargeTemplate } from '@shared/types'

const POSTER_CATEGORIES = ['Food', 'Beverage', 'Spa', 'Services', 'Other'] as const

interface Mappings {
  [posterCategory: string]: number | null
}

interface ApiKey {
  id: number
  name: string
  key_prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

interface NewApiKey {
  id: number
  key: string
  prefix: string
}

export function SettingsPage() {
  const [templates, setTemplates] = useState<ClockChargeTemplate[]>([])
  const [mappings, setMappings] = useState<Mappings>({})
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [creatingKey, setCreatingKey] = useState(false)
  const [justCreated, setJustCreated] = useState<NewApiKey | null>(null)
  const [copied, setCopied] = useState(false)

  const loadApiKeys = async () => {
    try {
      const keys = await api.get<ApiKey[]>('/api/admin/api-keys')
      setApiKeys(keys)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tplData, mapData, keysData] = await Promise.all([
          api.get<ClockChargeTemplate[]>('/api/dashboard/config/templates'),
          api.get<Mappings>('/api/dashboard/config/mappings'),
          api.get<ApiKey[]>('/api/admin/api-keys'),
        ])
        setTemplates(tplData)
        setMappings(mapData)
        setApiKeys(keysData)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load settings')
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return
    setCreatingKey(true)
    try {
      const result = await api.post<NewApiKey>('/api/admin/api-keys', { name: newKeyName.trim() })
      setJustCreated(result)
      setNewKeyName('')
      await loadApiKeys()
      toast.success('API key created')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create key')
    } finally {
      setCreatingKey(false)
    }
  }

  const handleRevokeKey = async (id: number) => {
    if (!confirm('Revoke this API key? Any system using it will lose access immediately.')) return
    try {
      await api.post(`/api/admin/api-keys/${id}/revoke`)
      await loadApiKeys()
      toast.success('Key revoked')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke key')
    }
  }

  const copyKey = async () => {
    if (!justCreated) return
    await navigator.clipboard.writeText(justCreated.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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

      {/* API Keys section */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <Key size={16} className="text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">API Keys</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          For external systems (FitKoh app, Homebase) to access <code className="bg-secondary px-1 py-0.5 rounded text-[10px]">/api/v1/*</code>
        </p>

        {/* Just-created key display (one-time) */}
        {justCreated && (
          <div className="mb-4 p-3 rounded-lg bg-primary/10 border border-primary/30">
            <p className="text-xs font-semibold text-primary mb-2">
              New key created — copy it now, you won't see it again
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-background px-2 py-1.5 rounded break-all">
                {justCreated.key}
              </code>
              <button
                onClick={copyKey}
                className="shrink-0 p-2 rounded-lg bg-secondary hover:bg-secondary/80 transition-colors"
              >
                {copied ? <Check size={14} className="text-primary" /> : <Copy size={14} />}
              </button>
            </div>
            <button
              onClick={() => setJustCreated(null)}
              className="mt-2 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Create new key */}
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateKey()}
            placeholder="e.g. FitKoh App"
            className="flex-1 px-3 py-2 rounded-xl bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            onClick={handleCreateKey}
            disabled={creatingKey || !newKeyName.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 transition-opacity"
          >
            {creatingKey ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create
          </button>
        </div>

        {/* Existing keys list */}
        {apiKeys.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No API keys yet
          </p>
        ) : (
          <div className="space-y-1">
            {apiKeys.map((key) => (
              <div
                key={key.id}
                className={`flex items-center gap-3 p-3 rounded-lg border ${
                  key.revoked_at ? 'border-border/30 opacity-50' : 'border-border bg-background/40'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate">
                      {key.name}
                    </span>
                    {key.revoked_at && (
                      <span className="text-[10px] text-destructive uppercase tracking-wide">
                        Revoked
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">
                    {key.key_prefix}…
                  </div>
                  <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                    Created {formatRelativeTime(key.created_at)}
                    {key.last_used_at && (
                      <> · Last used {formatRelativeTime(key.last_used_at)}</>
                    )}
                  </div>
                </div>
                {!key.revoked_at && (
                  <button
                    onClick={() => handleRevokeKey(key.id)}
                    className="shrink-0 p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

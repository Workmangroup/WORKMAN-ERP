'use client'

import { useState, useTransition } from 'react'
import { X, Check } from 'lucide-react'
import { accessSummary, type AccessChoice, type WarehouseRole } from '@/lib/admin/matrix'
import { setWarehouseAccessAction } from '../matrix-actions'

export interface WhCol { id: string; name: string; code: string }
export interface UserRowLite { id: string; name: string; email: string }

const ROLE_LABEL: Record<AccessChoice, string> = { none: 'Aucun', viewer: 'Lecture', operator: 'Opérateur', manager: 'Responsable' }

/** Matrice utilisateurs × entrepôts. Chaque cellule choisit le rôle ; « Aucun » retire l'accès. */
export function WarehouseAccessMatrix({ users, warehouses, grants, canEdit }: {
  users: UserRowLite[]; warehouses: WhCol[]; grants: Record<string, Record<string, WarehouseRole>>; canEdit: boolean
}) {
  const [state, setState] = useState(grants)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()

  const change = (userId: string, whId: string, choice: AccessChoice) => {
    const before = state[userId]?.[whId]
    const prev: AccessChoice = before ?? 'none'
    if (prev === choice) return
    setState((s) => {
      const row = { ...(s[userId] ?? {}) }
      if (choice === 'none') delete row[whId]
      else row[whId] = choice
      return { ...s, [userId]: row }
    })
    start(async () => {
      const r = await setWarehouseAccessAction(userId, whId, choice)
      if (!r.ok) {
        setState((s) => {
          const row = { ...(s[userId] ?? {}) }
          if (before) row[whId] = before
          else delete row[whId]
          return { ...s, [userId]: row }
        })
      }
      setMsg({ ok: r.ok, text: r.message })
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-soft" aria-live="polite">{pending ? 'Enregistrement…' : msg?.text ?? (canEdit ? 'Choisissez le rôle de chaque personne dans chaque entrepôt.' : 'Lecture seule.')}</p>
      <div className="space-y-3">
        {users.map((u) => {
          const sum = accessSummary(warehouses, state[u.id] ?? {})
          return (
            <article key={u.id} className="rounded-lg border border-line bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{u.name}</p>
                  <p className="text-xs text-ink-soft">{u.email}</p>
                </div>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {sum.allowed.map((a) => (
                    <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 font-medium text-success-text"><Check className="h-3 w-3" aria-hidden />{a.name} · {ROLE_LABEL[a.role]}</span>
                  ))}
                  {sum.denied.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-0.5 text-ink-soft"><X className="h-3 w-3" aria-hidden />Refusé : {sum.denied.map((d) => d.name).join(', ')}</span>
                  )}
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {warehouses.map((w) => (
                  <label key={w.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
                    <span className="min-w-0"><span className="block truncate font-medium">{w.name}</span><span className="font-mono text-[11px] text-ink-faint">{w.code}</span></span>
                    <select value={state[u.id]?.[w.id] ?? 'none'} disabled={!canEdit || pending}
                      onChange={(e) => change(u.id, w.id, e.target.value as AccessChoice)}
                      aria-label={`Accès de ${u.name} à ${w.name}`}
                      className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm disabled:opacity-60">
                      {(['none', 'viewer', 'operator', 'manager'] as AccessChoice[]).map((c) => <option key={c} value={c}>{ROLE_LABEL[c]}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

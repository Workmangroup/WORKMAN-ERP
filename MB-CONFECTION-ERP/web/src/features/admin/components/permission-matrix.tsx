'use client'

import { useMemo, useState, useTransition } from 'react'
import { Lock, Search } from 'lucide-react'
import { groupByModule, togglePermission, type PermRef } from '@/lib/admin/matrix'
import { setRolePermissionsAction } from '../matrix-actions'
import { cn } from '@/lib/utils'

export interface RoleCol { id: string; code: string; label: string; is_system: boolean; permissions: string[] }

/** Matrice rôles × permissions : une bascule enregistre aussitôt, avec retour arrière si le serveur refuse. */
export function PermissionMatrix({ roles, perms, canEdit }: { roles: RoleCol[]; perms: PermRef[]; canEdit: boolean }) {
  const [state, setState] = useState<Record<string, string[]>>(() => Object.fromEntries(roles.map((r) => [r.id, r.permissions])))
  const [query, setQuery] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, start] = useTransition()

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? perms.filter((p) => p.code.includes(q) || p.label.toLowerCase().includes(q) || p.module.includes(q)) : perms
    return groupByModule(filtered)
  }, [perms, query])

  const toggle = (role: RoleCol, code: string, on: boolean) => {
    const before = state[role.id] ?? []
    const after = togglePermission(before, code, on)
    setState((s) => ({ ...s, [role.id]: after }))
    start(async () => {
      const r = await setRolePermissionsAction(role.id, after)
      if (!r.ok) {
        setState((s) => ({ ...s, [role.id]: before }))
        setMsg({ ok: false, text: r.message })
      } else setMsg({ ok: true, text: `${role.label} : ${r.message}` })
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative w-full max-w-sm">
          <span className="sr-only">Filtrer les permissions</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrer : stock, achats, écriture…"
            className="h-9 w-full rounded-md border border-line-strong bg-surface pl-8 pr-3 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <span className="text-xs text-ink-soft" aria-live="polite">{pending ? 'Enregistrement…' : msg?.text ?? (canEdit ? 'Chaque bascule est enregistrée immédiatement.' : 'Lecture seule.')}</span>
      </div>

      <div className="overflow-auto rounded-lg border border-line bg-surface shadow-card" style={{ maxHeight: '70vh' }}>
        <table className="w-full min-w-[46rem] border-separate border-spacing-0 text-sm">
          <caption className="sr-only">Matrice des permissions par rôle</caption>
          <thead className="sticky top-0 z-10 bg-canvas text-xs text-ink-soft">
            <tr>
              <th scope="col" className="sticky left-0 z-20 min-w-[16rem] bg-canvas px-4 py-3 text-left font-semibold">Permission</th>
              {roles.map((r) => (
                <th key={r.id} scope="col" className="px-3 py-3 text-center font-semibold">
                  <span className="block whitespace-nowrap">{r.label}</span>
                  {r.is_system && <span className="block text-[10px] font-normal text-ink-faint">système</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <FragmentModule key={g.module} module={g.module} count={roles.length + 1}>
                {g.perms.map((p) => (
                  <tr key={p.code} className="border-t border-line transition-colors duration-150 hover:bg-brand-50/40 motion-reduce:transition-none">
                    <th scope="row" className="sticky left-0 z-[1] bg-surface px-4 py-2 text-left font-normal">
                      <span className="block font-mono text-xs text-ink-soft">{p.code}</span>
                      <span className="block text-sm">{p.label}</span>
                    </th>
                    {roles.map((r) => {
                      const on = (state[r.id] ?? []).includes(p.code)
                      const locked = r.code === 'admin'
                      return (
                        <td key={r.id} className="px-3 py-2 text-center">
                          {locked ? (
                            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-700" title="Administrateur : toutes les permissions, verrouillé">
                              <Lock className="h-3.5 w-3.5" aria-hidden />
                            </span>
                          ) : (
                            <input type="checkbox" checked={on} disabled={!canEdit || pending}
                              onChange={(e) => toggle(r, p.code, e.target.checked)}
                              aria-label={`${p.label} pour ${r.label}`}
                              className={cn('h-5 w-5 cursor-pointer accent-brand-600 disabled:cursor-not-allowed', !canEdit && 'opacity-60')} />
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </FragmentModule>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-faint">L’administrateur conserve toujours toutes les permissions : sa colonne est verrouillée pour éviter une perte d’accès.</p>
    </div>
  )
}

function FragmentModule({ module, count, children }: { module: string; count: number; children: React.ReactNode }) {
  return (
    <>
      <tr className="bg-canvas/70">
        <td colSpan={count} className="sticky left-0 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-brand-700">{module}</td>
      </tr>
      {children}
    </>
  )
}

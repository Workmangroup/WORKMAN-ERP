'use client'

import { ShieldOff, UserPlus } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { Badge } from '@/components/ui/badge'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { ACCESS_ROLES, roleLabel, roleTone } from '@/lib/warehouses/options'
import { formatDateTime } from '@/lib/utils'
import { assignUserAction, revokeUserAction } from '../actions'
import type { AccessRow } from '../services/warehouses.service'

/** Affectation des utilisateurs à cet entrepôt : rôles, ajout, retrait (historisé). */
export function AccessPanel({ warehouseId, rows, candidates, canManage }: {
  warehouseId: string; rows: AccessRow[]; candidates: { id: string; label: string }[]; canManage: boolean
}) {
  const active = rows.filter((r) => r.active)
  const history = rows.filter((r) => !r.active)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{active.length} accès actif(s). Un utilisateur ne voit et ne modifie que les entrepôts qui lui sont affectés.</p>
        {canManage && candidates.length > 0 && (
          <ActionDialog trigger={<><UserPlus className="h-4 w-4" /> Affecter un utilisateur</>} triggerVariant="primary" title="Affecter un utilisateur" action={assignUserAction} hidden={{ warehouse_id: warehouseId }} submit="Accorder l’accès"
            description="Le rôle détermine ce que la personne peut faire dans cet entrepôt.">
            {(st) => (
              <div className="space-y-3">
                <FormField id="au-user" label="Utilisateur *" errors={st?.fieldErrors?.user_id}>
                  <Select id="au-user" name="user_id" defaultValue=""><option value="">— Choisir —</option>{candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
                </FormField>
                <FormField id="au-role" label="Rôle *" errors={st?.fieldErrors?.role}>
                  <Select id="au-role" name="role" defaultValue="operator">{ACCESS_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label} — {r.hint}</option>)}</Select>
                </FormField>
              </div>
            )}
          </ActionDialog>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Utilisateur</th><th className="px-2 py-2 font-semibold">Rôle</th><th className="px-2 py-2 font-semibold">Accordé le</th><th className="px-2 py-2" /></tr></thead>
          <tbody className="divide-y divide-line">
            {active.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2"><span className="font-semibold">{r.full_name}</span><span className="block text-xs text-ink-soft">{r.email}</span></td>
                <td className="px-2 py-2"><Badge tone={roleTone(r.role)}>{roleLabel(r.role)}</Badge></td>
                <td className="px-2 py-2 text-ink-soft">{formatDateTime(r.granted_at)}</td>
                <td className="px-2 py-2 text-right">
                  {canManage && (
                    <RpcButton action={revokeUserAction} fields={{ warehouse_id: warehouseId, user_id: r.user_id }} variant="ghost" size="sm" confirm={`Retirer l’accès de ${r.full_name} à cet entrepôt ?`}>
                      <ShieldOff className="h-4 w-4 text-danger-text" /> Retirer
                    </RpcButton>
                  )}
                </td>
              </tr>
            ))}
            {active.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-ink-soft">Aucun utilisateur affecté.</td></tr>}
          </tbody>
        </table>
      </div>

      {history.length > 0 && (
        <details className="rounded-md border border-line bg-white p-3 shadow-card">
          <summary className="cursor-pointer text-sm font-semibold">Accès retirés ({history.length})</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {history.map((r) => <li key={r.id} className="text-ink-soft">{r.full_name} — {roleLabel(r.role)} · retiré le {r.revoked_at ? formatDateTime(r.revoked_at) : '—'}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

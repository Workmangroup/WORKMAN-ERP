import type { Metadata } from 'next'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { ExitRuleForm, LineScanForm, PickCreateForm, SubstitutionForm } from '@/features/stock/components/picking-forms'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { cancelPickAction, confirmPickAction, decideSubstitutionAction } from '@/features/stock/picking-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Préparation et prélèvement' }

const PICK_STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  open: { label: 'Ouverte', tone: 'warning' }, confirmed: { label: 'Confirmée', tone: 'success' }, cancelled: { label: 'Annulée', tone: 'neutral' },
}
const SUBST_LABEL: Record<string, string> = { none: '—', pending: 'Accord en attente', approved: 'Approuvée', refused: 'Refusée' }
const UUID = /^[0-9a-f-]{36}$/i
const DEC = /^\d+([.,]\d+)?$/
type Proposal = { rule: string; available: number; proposed: number; short: number; lines: { seq: number; lot_code: string; location_id: string; qty: number; expiry_date: string | null }[]; excluded: { lot_code: string; qty: number; reason: string }[] }

export default async function PickingPage({ searchParams }: {
  searchParams: Promise<{ pick?: string; material?: string; warehouse?: string; qty?: string }>
}) {
  const ctx = await requireAnyPermission(P.STOCK_READ)
  const sp = await searchParams
  const canWrite = ctx.permissions.includes(P.STOCK_WRITE)
  const canAdjust = ctx.permissions.includes(P.STOCK_ADJUST)
  const supabase = await createClient()

  const { data: policy } = await supabase.rpc('stock_exit_policy_get')
  const rule = (policy as { exit_rule?: string } | null)?.exit_rule ?? 'fifo'
  const { data: access } = await supabase.rpc('wh_my_access')
  const whs = ((access ?? []) as { warehouse_id: string; code: string; name: string }[])
  const whLabels = whs.map((w) => ({ id: w.warehouse_id, label: `${w.code} — ${w.name}` }))
  const mats = await supabase.from('bom_materials').select('id,name').is('archived_at', null).order('name').limit(500)
  const matList = (mats.data ?? []).map((m) => ({ id: m.id as string, name: m.name as string }))
  const matName = (id: string) => matList.find((m) => m.id === id)?.name ?? id.slice(0, 8)
  const whName = (id: string) => whLabels.find((w) => w.id === id)?.label ?? id.slice(0, 8)

  // Aperçu de proposition (lecture seule) : sur les paramètres de la requête.
  const previewMat = sp.material && UUID.test(sp.material) ? sp.material : null
  const previewWh = sp.warehouse && UUID.test(sp.warehouse) ? sp.warehouse : null
  const previewQty = sp.qty && DEC.test(sp.qty) ? Number(sp.qty.replace(',', '.')) : null
  let proposal: Proposal | null = null
  let proposalError = false
  if (previewMat && previewWh && previewQty && previewQty > 0) {
    const { data, error } = await supabase.rpc('stock_pick_proposal', { p_material: previewMat, p_warehouse: previewWh, p_qty: previewQty })
    if (error) proposalError = true
    else proposal = data as Proposal
  }

  const picks = await supabase.from('stock_pick_lists').select('id,number,status,qty_requested,exit_rule,created_at,warehouse_id,material_id')
    .order('created_at', { ascending: false }).limit(30)
  const selected = sp.pick && UUID.test(sp.pick) ? sp.pick : null
  const pick = selected ? (picks.data ?? []).find((p) => p.id === selected) ?? null : null
  const lines = pick ? (await supabase.from('stock_pick_lines').select('id,seq,lot_id,lot_code,location_id,qty,scanned,scan_errors,substitution_status,substitution_reason,substitute_lot_id,movement_id,substitution_requested_by')
    .eq('pick_id', pick.id).order('seq')).data ?? [] : []
  const today = new Date().toISOString().slice(0, 10)
  const lots = pick ? (await supabase.from('stock_lots').select('id,lot_code,expiry_date,qty_remaining,warehouse_id,material_id')
    .eq('material_id', pick.material_id).eq('warehouse_id', pick.warehouse_id).gt('qty_remaining', 0).order('received_at').limit(200)).data ?? [] : []
  const substituteOptions = lots
    .filter((l) => !l.expiry_date || (l.expiry_date as string) >= today)
    .map((l) => ({ id: l.id as string, label: `${l.lot_code} — ${Number(l.qty_remaining)} dispo${l.expiry_date ? ' · échéance ' + l.expiry_date : ''}` }))
  const pickOpen = pick?.status === 'open'
  const anyPending = lines.some((l) => l.substitution_status === 'pending')
  const allScanned = lines.length > 0 && lines.every((l) => l.scanned)

  return (
    <>
      <PageHeader title="Préparation et prélèvement" description="Règle de sortie FIFO ou FEFO, proposition de lots, scan de chaque lot avant sortie. Lots échus et en quarantaine exclus ; substitution soumise à accord." />
      <div className="space-y-4 p-4 sm:p-6">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Règle de sortie</h2>
          <p className="text-xs text-ink-soft">Règle actuelle : <Badge tone="neutral">{rule.toUpperCase()}</Badge> · Valorisation : coût du lot (inchangée).</p>
          {canAdjust && <ExitRuleForm current={rule} />}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Proposition de lots</h2>
          <form method="get" className="grid gap-2 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-4" noValidate>
            <select name="material" defaultValue={previewMat ?? ''} className="h-9 rounded-md border border-line px-2 text-sm"><option value="">Composant…</option>{matList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <select name="warehouse" defaultValue={previewWh ?? ''} className="h-9 rounded-md border border-line px-2 text-sm"><option value="">Entrepôt…</option>{whLabels.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</select>
            <input name="qty" defaultValue={sp.qty ?? ''} inputMode="decimal" placeholder="Quantité" className="h-9 rounded-md border border-line px-2 text-sm" />
            <button type="submit" className="h-9 rounded-md border border-line bg-canvas px-3 text-sm font-semibold">Proposer</button>
          </form>
          {proposalError && <Alert tone="error">Proposition indisponible pour ce composant ou cet entrepôt (droit ou périmètre).</Alert>}
          {proposal && (
            <div className="space-y-2 rounded-md border border-line bg-white p-4 shadow-card">
              <p className="text-sm">Règle {proposal.rule.toUpperCase()} · disponible {proposal.available} · proposé {proposal.proposed}
                {proposal.short > 0 && <span className="font-semibold text-danger-text"> · manque {proposal.short}</span>}</p>
              <table className="w-full text-sm"><thead className="text-left text-xs text-ink-soft"><tr><th className="py-1">Ordre</th><th>Lot</th><th>Quantité</th><th>Échéance</th></tr></thead>
                <tbody className="divide-y divide-line">{proposal.lines.map((l) => <tr key={l.seq}><td className="py-1">{l.seq}</td><td className="font-mono">{l.lot_code}</td><td className="tabular-nums">{l.qty}</td><td>{l.expiry_date ?? '—'}</td></tr>)}</tbody></table>
              {proposal.excluded.length > 0 && (
                <div className="text-xs text-ink-soft">Exclus : {proposal.excluded.map((e) => `${e.lot_code} (${e.qty}, ${e.reason === 'BLOCKED' ? 'bloqué qualité' : 'échu'})`).join(' · ')}</div>
              )}
            </div>
          )}
        </section>

        {canWrite && whLabels.length > 0 && <PickCreateForm materials={matList} warehouses={whLabels} />}
        {canWrite && whLabels.length === 0 && <Alert tone="info">Aucun entrepôt ne vous est affecté : la préparation n’est pas possible.</Alert>}

        <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Liste</th><th className="px-2 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Entrepôt</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">Règle</th><th className="px-2 py-2 font-semibold">État</th><th className="px-4 py-2 font-semibold">Créée le</th></tr></thead>
            <tbody className="divide-y divide-line">
              {(picks.data ?? []).length === 0 && <tr><td colSpan={7} className="p-6 text-center text-ink-soft">Aucune liste de prélèvement visible.</td></tr>}
              {(picks.data ?? []).map((p) => (
                <tr key={p.id} className="hover:bg-canvas/60">
                  <td className="px-4 py-2 font-mono"><Link href={`/stock/picking?pick=${p.id}`} className="font-semibold text-brand-700 hover:underline">{p.number}</Link></td>
                  <td className="px-2 py-2">{matName(p.material_id)}</td>
                  <td className="px-2 py-2 text-xs">{whName(p.warehouse_id)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{Number(p.qty_requested)}</td>
                  <td className="px-2 py-2 uppercase">{p.exit_rule}</td>
                  <td className="px-2 py-2"><Badge tone={PICK_STATUS[p.status]?.tone ?? 'neutral'}>{PICK_STATUS[p.status]?.label ?? p.status}</Badge></td>
                  <td className="whitespace-nowrap px-4 py-2">{formatDateTime(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {pick && (
          <section className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold text-ink">{pick.number} — {matName(pick.material_id)} · {whName(pick.warehouse_id)}</h2>
            {!pickOpen && <Alert tone="info">Liste {PICK_STATUS[pick.status]?.label.toLowerCase() ?? pick.status} : plus aucune action de prélèvement.</Alert>}
            {anyPending && <Alert tone="warning">Une substitution attend un accord : elle bloque le scan et la confirmation tant qu’elle n’est pas tranchée.</Alert>}
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-soft"><tr><th className="py-1">#</th><th>Lot à sortir</th><th>Emplacement</th><th className="text-right">Quantité</th><th>Scan</th><th>Substitution</th><th>Sortie</th></tr></thead>
              <tbody className="divide-y divide-line align-top">
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="py-2">{l.seq}</td>
                    <td className="py-2 font-mono">{l.lot_code}{l.scan_errors > 0 && <span className="ml-2 text-xs text-danger-text">{l.scan_errors} scan(s) erroné(s)</span>}</td>
                    <td className="py-2 text-xs">{l.location_id.slice(0, 8)}</td>
                    <td className="py-2 text-right tabular-nums">{Number(l.qty)}</td>
                    <td className="py-2">{l.scanned ? <Badge tone="success">Scanné</Badge> : <Badge tone="warning">À scanner</Badge>}</td>
                    <td className="py-2 text-xs">
                      {SUBST_LABEL[l.substitution_status] ?? l.substitution_status}
                      {l.substitution_reason && <div className="text-ink-soft">{l.substitution_reason}</div>}
                      {l.substitution_status === 'pending' && canAdjust && (
                        <div className="mt-1 flex gap-2">
                          <RpcButton action={decideSubstitutionAction} fields={{ line_id: l.id, approve: 'true' }} pendingText="…">Approuver</RpcButton>
                          <RpcButton action={decideSubstitutionAction} fields={{ line_id: l.id, approve: 'false' }} variant="secondary" pendingText="…">Refuser</RpcButton>
                        </div>
                      )}
                    </td>
                    <td className="py-2 text-xs">{l.movement_id ? 'Sortie enregistrée' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pickOpen && canWrite && lines.map((l) => (
              <div key={`scan-${l.id}`} className="space-y-2 border-t border-line pt-2">
                <p className="text-xs text-ink-soft">Ligne {l.seq} — lot attendu <span className="font-mono">{l.lot_code}</span></p>
                <LineScanForm lineId={l.id} disabled={l.substitution_status === 'pending'} />
                {l.substitution_status !== 'pending' && substituteOptions.length > 0 && <SubstitutionForm lineId={l.id} lots={substituteOptions} />}
              </div>
            ))}
            {pickOpen && canWrite && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
                <RpcButton action={confirmPickAction} fields={{ pick_id: pick.id }} disabled={!allScanned || anyPending} confirm="Confirmer la sortie de tous les lots scannés ?" pendingText="Sortie…">Confirmer la sortie</RpcButton>
                <RpcButton action={cancelPickAction} fields={{ pick_id: pick.id }} variant="secondary" confirm="Annuler cette liste de prélèvement ?" pendingText="Annulation…">Annuler la liste</RpcButton>
                {!allScanned && <span className="text-xs text-ink-soft">Scannez chaque lot pour activer la confirmation.</span>}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  )
}

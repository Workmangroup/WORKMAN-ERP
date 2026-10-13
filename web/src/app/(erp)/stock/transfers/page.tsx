import type { Metadata } from 'next'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { LossForm, ReceiveForm, TransferCreateForm } from '@/features/stock/components/transfer-forms'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { cancelTransferAction, decideLossAction, prepareTransferAction, shipTransferAction } from '@/features/stock/transfers-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Transferts et stock en transit' }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Brouillon', tone: 'neutral' }, prepared: { label: 'Préparé', tone: 'neutral' }, shipped: { label: 'Expédié (en transit)', tone: 'warning' },
  partially_received: { label: 'Partiellement reçu', tone: 'warning' }, received: { label: 'Reçu', tone: 'success' }, cancelled: { label: 'Annulé', tone: 'neutral' },
}
const EVENT_LABEL: Record<string, string> = {
  prepared: 'Préparé', shipped: 'Expédié', received: 'Reçu', loss_declared: 'Écart déclaré', loss_approved: 'Écart approuvé', loss_refused: 'Écart refusé', cancelled: 'Annulé',
}
const UUID = /^[0-9a-f-]{36}$/i

type Detail = {
  id: string; number: string; status: string; from_warehouse_id: string; to_warehouse_id: string
  lines: { line_id: string; seq: number; material_id: string; qty_requested: number; qty_prepared: number; qty_shipped: number; qty_received: number; qty_lost: number; qty_pending_loss: number; in_transit: number }[]
  receipts: { receipt_id: string; line_id: string; qty: number; proof_ref: string; received_at: string }[]
  losses: { loss_id: string; line_id: string; qty: number; reason: string; status: string }[]
  events: { event: string; qty: number | null; at: string }[]
}

export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const ctx = await requireAnyPermission(P.STOCK_READ)
  const sp = await searchParams
  const canWrite = ctx.permissions.includes(P.STOCK_WRITE)
  const canAdjust = ctx.permissions.includes(P.STOCK_ADJUST)
  const supabase = await createClient()

  const { data: access } = await supabase.rpc('wh_my_access')
  const myWhs = ((access ?? []) as { warehouse_id: string; code: string; name: string }[])
  const whRows = await supabase.from('warehouses').select('id,code,name,kind').is('archived_at', null).neq('kind', 'transit').order('code').limit(200)
  const warehouses = (whRows.data ?? []).map((w) => ({ id: w.id as string, label: `${w.code} — ${w.name}` }))
  const whIds = warehouses.map((w) => w.id)
  const locRows = whIds.length ? await supabase.from('stock_locations').select('id,warehouse_id,code,kind').in('warehouse_id', whIds).is('archived_at', null).order('code').limit(500) : { data: [] }
  const locations = (locRows.data ?? []).map((l) => ({ id: l.id as string, warehouse_id: l.warehouse_id as string, code: `${l.code}${l.kind === 'quarantine' ? ' (quarantaine)' : ''}`, kind: l.kind as string }))
  const mats = await supabase.from('bom_materials').select('id,name').is('archived_at', null).order('name').limit(500)
  const matList = (mats.data ?? []).map((m) => ({ id: m.id as string, name: m.name as string }))
  const matName = (id: string) => matList.find((m) => m.id === id)?.name ?? id.slice(0, 8)
  const whName = (id: string) => warehouses.find((w) => w.id === id)?.label ?? id.slice(0, 8)

  const list = await supabase.from('stock_transfers').select('id,number,status,from_warehouse_id,to_warehouse_id,created_at').order('created_at', { ascending: false }).limit(30)
  const selected = sp.t && UUID.test(sp.t) ? sp.t : null
  let detail: Detail | null = null
  let detailError = false
  if (selected) {
    const { data, error } = await supabase.rpc('stock_transfer_detail', { p_transfer: selected })
    if (error) detailError = true
    else detail = data as Detail
  }
  const selectableLocs = locations.filter((l) => l.kind !== 'quarantine').map((l) => ({ id: l.id, warehouse_id: l.warehouse_id, code: l.code }))

  return (
    <>
      <PageHeader title="Transferts et stock en transit" description="Préparé, expédié, en transit, reçu, écart. Réception partielle avec bon de transport ; aucune double réception. Entre entrepôts d’une même société uniquement." />
      <div className="space-y-4 p-4 sm:p-6">
        {canWrite && <TransferCreateForm materials={matList} warehouses={warehouses} locations={selectableLocs} />}
        {canWrite && myWhs.length === 0 && <Alert tone="info">Aucun entrepôt ne vous est affecté : la création de transfert n’est pas possible.</Alert>}

        <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Transfert</th><th className="px-2 py-2 font-semibold">Depuis</th><th className="px-2 py-2 font-semibold">Vers</th><th className="px-2 py-2 font-semibold">État</th><th className="px-4 py-2 font-semibold">Créé le</th></tr></thead>
            <tbody className="divide-y divide-line">
              {(list.data ?? []).length === 0 && <tr><td colSpan={5} className="p-6 text-center text-ink-soft">Aucun transfert visible.</td></tr>}
              {(list.data ?? []).map((t) => (
                <tr key={t.id} className="hover:bg-canvas/60">
                  <td className="px-4 py-2 font-mono"><Link href={`/stock/transfers?t=${t.id}`} className="font-semibold text-brand-700 hover:underline">{t.number}</Link></td>
                  <td className="px-2 py-2 text-xs">{whName(t.from_warehouse_id)}</td>
                  <td className="px-2 py-2 text-xs">{whName(t.to_warehouse_id)}</td>
                  <td className="px-2 py-2"><Badge tone={STATUS[t.status]?.tone ?? 'neutral'}>{STATUS[t.status]?.label ?? t.status}</Badge></td>
                  <td className="whitespace-nowrap px-4 py-2">{formatDateTime(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {detailError && <Alert tone="error">Détail indisponible pour ce transfert (hors de votre périmètre ou introuvable).</Alert>}
        {detail && (
          <section className="space-y-4 rounded-md border border-line bg-white p-4 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-sm font-semibold text-ink">{detail.number}</h2>
              <Badge tone={STATUS[detail.status]?.tone ?? 'neutral'}>{STATUS[detail.status]?.label ?? detail.status}</Badge>
              <span className="text-xs text-ink-soft">{whName(detail.from_warehouse_id)} → {whName(detail.to_warehouse_id)}</span>
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-soft"><tr><th className="py-1">#</th><th>Composant</th><th className="text-right">Demandé</th><th className="text-right">Préparé</th><th className="text-right">Expédié</th><th className="text-right">Reçu</th><th className="text-right">Écart</th><th className="text-right">En transit</th></tr></thead>
              <tbody className="divide-y divide-line">
                {detail.lines.map((l) => (
                  <tr key={l.line_id}>
                    <td className="py-1">{l.seq}</td><td>{matName(l.material_id)}</td>
                    <td className="text-right tabular-nums">{l.qty_requested}</td><td className="text-right tabular-nums">{l.qty_prepared}</td>
                    <td className="text-right tabular-nums">{l.qty_shipped}</td><td className="text-right tabular-nums">{l.qty_received}</td>
                    <td className="text-right tabular-nums">{l.qty_lost}{l.qty_pending_loss > 0 && <span className="text-xs text-ink-soft"> (+{l.qty_pending_loss} en attente)</span>}</td>
                    <td className="text-right font-semibold tabular-nums">{l.in_transit}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {canWrite && (detail.status === 'draft' || detail.status === 'prepared') && (
              <div className="flex flex-wrap gap-3 border-t border-line pt-3">
                <RpcButton action={prepareTransferAction} fields={{ transfer_id: detail.id, lines: JSON.stringify(detail.lines.map((l) => ({ line_id: l.line_id, qty: l.qty_requested }))) }} pendingText="Préparation…">Préparer tout (quantités demandées)</RpcButton>
                {detail.status === 'prepared' && <RpcButton action={shipTransferAction} fields={{ transfer_id: detail.id }} confirm="Expédier : le stock sort du magasin source et passe en transit ?" pendingText="Expédition…">Expédier</RpcButton>}
                <RpcButton action={cancelTransferAction} fields={{ transfer_id: detail.id }} variant="secondary" confirm="Annuler ce transfert ?" pendingText="Annulation…">Annuler</RpcButton>
              </div>
            )}

            {canWrite && (detail.status === 'shipped' || detail.status === 'partially_received') && (
              <div className="space-y-3 border-t border-line pt-3">
                {detail.lines.filter((l) => l.in_transit > 0).map((l) => (
                  <div key={`rc-${l.line_id}`} className="space-y-2">
                    <p className="text-xs text-ink-soft">{matName(l.material_id)} — en transit {l.in_transit}</p>
                    <ReceiveForm transferId={detail.id} lineId={l.line_id} left={l.in_transit - l.qty_pending_loss} />
                    <LossForm transferId={detail.id} lineId={l.line_id} left={l.in_transit - l.qty_pending_loss} />
                  </div>
                ))}
              </div>
            )}

            {detail.losses.some((x) => x.status === 'pending') && (
              <div className="space-y-2 border-t border-line pt-3">
                <h3 className="text-xs font-semibold text-ink">Écarts en attente d’accord</h3>
                {detail.losses.filter((x) => x.status === 'pending').map((x) => (
                  <div key={x.loss_id} className="flex flex-wrap items-center gap-3 text-sm">
                    <span>{x.qty} — {x.reason}</span>
                    {canAdjust && (
                      <>
                        <RpcButton action={decideLossAction} fields={{ loss_id: x.loss_id, approve: 'true' }} pendingText="…">Approuver (sortie du transit)</RpcButton>
                        <RpcButton action={decideLossAction} fields={{ loss_id: x.loss_id, approve: 'false' }} variant="secondary" pendingText="…">Refuser</RpcButton>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-4 border-t border-line pt-3 md:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-semibold text-ink">Réceptions et preuves</h3>
                {detail.receipts.length === 0 ? <p className="text-xs text-ink-soft">Aucune réception.</p> : (
                  <ul className="space-y-1 text-xs">{detail.receipts.map((r) => <li key={r.receipt_id}>{formatDateTime(r.received_at)} — {r.qty} · bon de transport {r.proof_ref}</li>)}</ul>
                )}
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold text-ink">Historique</h3>
                <ul className="space-y-1 text-xs">{detail.events.map((e, i) => <li key={i}>{formatDateTime(e.at)} — {EVENT_LABEL[e.event] ?? e.event}{e.qty != null ? ` (${e.qty})` : ''}</li>)}</ul>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  )
}

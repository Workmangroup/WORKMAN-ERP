import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ActionForm } from '@/features/commercial/components/crm-forms'
import { deliveryConfirmAction, lotAssignAction, lotMarkNcAction, lotReceiveAction, returnInspectAction, returnReceiveAction, returnRequestAction, returnSettleAction } from '@/features/shipments/returns-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Lots, BL et retours' }

const inputCls = 'rounded-md border border-line bg-white px-3 py-2 text-sm'
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="grid gap-1 text-sm">{label}{children}</label>
const RET: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'danger' | 'warning' }> = {
  requested: { label: 'Demandé', tone: 'neutral' }, received: { label: 'Réceptionné', tone: 'brand' }, inspecting: { label: 'En inspection', tone: 'warning' },
  accepted: { label: 'Accepté : remis en stock', tone: 'success' }, rejected: { label: 'Refusé : lot non conforme', tone: 'danger' },
}

export default async function ReturnsPage() {
  const ctx = await requirePermission(P.SHIPMENTS_READ)
  const can = (p: string) => ctx.permissions.includes(p)
  const supabase = await createClient()
  const [lots, returns, lines, shipments, variants, warehouses] = await Promise.all([
    supabase.from('finished_lots').select('id,lot_code,variant_id,qty_in,qty_out,status,origin').order('created_at', { ascending: false }).limit(200).then((r) => r.data ?? []),
    supabase.from('customer_returns').select('id,number,status,qty,reason,declared_condition,origin_lot_id,shipment_line_id').order('requested_at', { ascending: false }).limit(200).then((r) => r.data ?? []),
    supabase.from('shipment_lines').select('id,qty_picked,qty_shipped,variant_id,shipment:shipments(number,status,bl_number)').order('created_at', { ascending: false }).limit(200).then((r) => (r.data ?? []) as unknown as { id: string; qty_shipped: number; variant_id: string; shipment: { number: string; status: string; bl_number: string | null } | null }[]),
    supabase.from('shipments').select('id,number,status,bl_number').order('created_at', { ascending: false }).limit(200).then((r) => r.data ?? []),
    supabase.from('product_variants').select('id,sku').order('sku').limit(300).then((r) => (r.data ?? []) as { id: string; sku: string }[]),
    supabase.from('warehouses').select('id,name').order('name').limit(100).then((r) => (r.data ?? []) as { id: string; name: string }[]),
  ])
  const sku = new Map(variants.map((v) => [v.id, v.sku]))
  const lotCode = new Map(lots.map((l) => [l.id, l.lot_code as string]))
  const lineLabel = (l: (typeof lines)[number]) => `${l.shipment?.number ?? '—'} · ${sku.get(l.variant_id) ?? '—'} · ${l.qty_shipped} expédiée(s)`
  return (
    <>
      <PageHeader title="Lots, BL et retours" description="Un lot non conforme n’est jamais expédié ni remis en stock. Un retour est contrôlé avant tout effet sur le stock ; il ne crée ni avoir ni remboursement." />
      <div className="space-y-4 p-4 sm:p-6">
        {can(P.STOCK_WRITE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Réception d’un lot de produits finis</h2>
            <div className="mt-3"><ActionForm action={lotReceiveAction} submit="Recevoir le lot">
              <Field label="Variante"><select name="variant_id" required className={inputCls}><option value="">Choisir…</option>{variants.map((v) => <option key={v.id} value={v.id}>{v.sku}</option>)}</select></Field>
              <Field label="Entrepôt"><select name="warehouse_id" required className={inputCls}><option value="">Choisir…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
              <Field label="Code du lot"><input name="lot_code" required minLength={2} maxLength={60} className={inputCls} /></Field>
              <Field label="Quantité"><input name="qty" required inputMode="numeric" className={inputCls} /></Field>
              <Field label="Origine (ordre de fabrication, facultatif)"><input name="origin_ref" maxLength={60} className={inputCls} /></Field>
            </ActionForm></div>
          </section>
        )}

        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Lots</h2>
          <ul className="mt-3 divide-y divide-line text-sm">
            {lots.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-mono text-xs">{l.lot_code}</span><span>{sku.get(l.variant_id) ?? '—'}</span>
                <span className="text-ink-soft">{l.qty_out} sorti / {l.qty_in} · origine {l.origin === 'return' ? 'retour' : 'réception'}</span>
                <Badge tone={l.status === 'nc' ? 'danger' : 'success'}>{l.status === 'nc' ? 'Non conforme' : 'Libéré'}</Badge>
                {can(P.QUALITY_WRITE) && l.status === 'released' && (
                  <div className="w-full sm:w-auto"><ActionForm action={lotMarkNcAction} submit="Marquer non conforme"><input type="hidden" name="lot_id" value={l.id} /><Field label="Motif (5 caractères minimum)"><input name="reason" required minLength={5} maxLength={300} className={inputCls} /></Field></ActionForm></div>
                )}
              </li>
            ))}
            {lots.length === 0 && <li className="py-2 text-ink-soft">Aucun lot.</li>}
          </ul>
        </section>

        {can(P.SHIPMENTS_WRITE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Affecter un lot à une ligne d’expédition (obligatoire avant le BL)</h2>
            <div className="mt-3"><ActionForm action={lotAssignAction} submit="Affecter le lot">
              <Field label="Ligne d’expédition"><select name="shipment_line_id" required className={inputCls}><option value="">Choisir…</option>{lines.filter((l) => l.shipment && ['preparing', 'picking', 'packed'].includes(l.shipment.status)).map((l) => <option key={l.id} value={l.id}>{lineLabel(l)}</option>)}</select></Field>
              <Field label="Lot libéré"><select name="lot_id" required className={inputCls}><option value="">Choisir…</option>{lots.filter((l) => l.status === 'released').map((l) => <option key={l.id} value={l.id}>{l.lot_code}</option>)}</select></Field>
              <Field label="Quantité"><input name="qty" required inputMode="numeric" className={inputCls} /></Field>
            </ActionForm></div>
          </section>
        )}

        {can(P.SHIPMENTS_WRITE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Confirmer une livraison (une seule fois)</h2>
            <div className="mt-3"><ActionForm action={deliveryConfirmAction} submit="Confirmer la livraison">
              <Field label="Expédition"><select name="shipment_id" required className={inputCls}><option value="">Choisir…</option>{shipments.filter((s) => s.status === 'shipped').map((s) => <option key={s.id} value={s.id}>{s.number} · {s.bl_number}</option>)}</select></Field>
              <Field label="Clé d’idempotence (8 caractères minimum)"><input name="idempotency_key" required minLength={8} maxLength={80} className={inputCls} /></Field>
              <Field label="Réceptionnaire"><input name="receiver" required minLength={2} maxLength={120} className={inputCls} /></Field>
            </ActionForm></div>
          </section>
        )}

        {can(P.SHIPMENTS_WRITE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Demander un retour</h2>
            <div className="mt-3"><ActionForm action={returnRequestAction} submit="Demander le retour">
              <Field label="Ligne expédiée"><select name="shipment_line_id" required className={inputCls}><option value="">Choisir…</option>{lines.filter((l) => l.shipment && ['shipped', 'delivered'].includes(l.shipment.status)).map((l) => <option key={l.id} value={l.id}>{lineLabel(l)}</option>)}</select></Field>
              <Field label="Quantité retournée"><input name="qty" required inputMode="numeric" className={inputCls} /></Field>
              <Field label="Lot d’origine (facultatif)"><select name="lot_id" className={inputCls}><option value="">—</option>{lots.map((l) => <option key={l.id} value={l.id}>{l.lot_code}</option>)}</select></Field>
              <Field label="État déclaré"><select name="condition" className={inputCls}><option value="unknown">Inconnu</option><option value="good">Bon état</option><option value="damaged">Endommagé</option></select></Field>
              <Field label="Motif (5 caractères minimum)"><input name="reason" required minLength={5} maxLength={300} className={inputCls} /></Field>
            </ActionForm></div>
          </section>
        )}

        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Retours</h2>
          <ul className="mt-3 divide-y divide-line text-sm">
            {returns.map((r) => (
              <li key={r.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-3"><span className="font-mono text-xs">{r.number}</span><span>{r.qty} pièce(s)</span><span className="text-ink-soft">« {r.reason} » · état déclaré : {r.declared_condition}</span>{r.origin_lot_id && <span className="text-xs text-ink-soft">lot {lotCode.get(r.origin_lot_id)}</span>}<Badge tone={RET[r.status]?.tone ?? 'neutral'}>{RET[r.status]?.label ?? r.status}</Badge></div>
                {r.status === 'requested' && can(P.SHIPMENTS_WRITE) && <ActionForm action={returnReceiveAction} submit="Marquer réceptionné"><input type="hidden" name="return_id" value={r.id} /><Field label="État constaté"><select name="condition" className={inputCls}><option value="good">Bon état</option><option value="damaged">Endommagé</option><option value="unknown">Inconnu</option></select></Field></ActionForm>}
                {r.status === 'received' && can(P.QUALITY_WRITE) && <ActionForm action={returnInspectAction} submit="Ouvrir l’inspection qualité"><input type="hidden" name="return_id" value={r.id} /></ActionForm>}
                {r.status === 'inspecting' && can(P.SHIPMENTS_WRITE) && <ActionForm action={returnSettleAction} submit="Régler selon la décision qualité"><input type="hidden" name="return_id" value={r.id} /></ActionForm>}
              </li>
            ))}
            {returns.length === 0 && <li className="py-2 text-ink-soft">Aucun retour.</li>}
          </ul>
        </section>
      </div>
    </>
  )
}

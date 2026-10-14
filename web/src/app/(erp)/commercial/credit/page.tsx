import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { requirePermission } from '@/features/auth/guards'
import { ActionForm } from '@/features/commercial/components/crm-forms'
import { creditDerogationRequestAction, marginPolicySetAction, stockBlockAction, stockBlockReleaseAction, variantCostSetAction } from '@/features/commercial/credit-actions'
import { getPromise, getStockPosition, listCreditStatus } from '@/features/commercial/services/credit.service'
import { clientOptions } from '@/features/commercial/services/commercial.service'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { formatQty } from '@/lib/bom/options'

export const metadata: Metadata = { title: 'Crédit et disponibilité' }

const inputCls = 'rounded-md border border-line bg-white px-3 py-2 text-sm'
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="grid gap-1 text-sm">{label}{children}</label>
const money = (n: number | null | undefined, c = 'EUR') => (n === null || n === undefined ? '—' : `${Number(n).toFixed(2)} ${c}`)

export default async function CreditPage({ searchParams }: { searchParams: Promise<{ variant?: string; qty?: string; date?: string }> }) {
  const ctx = await requirePermission(P.ORDERS_READ)
  const can = (p: string) => ctx.permissions.includes(p)
  const sp = await searchParams
  const supabase = await createClient()
  const [credit, clients, variants, warehouses, blocks, policy] = await Promise.all([
    listCreditStatus(),
    can(P.INVOICES_READ) || can(P.ORDERS_READ) ? clientOptions() : Promise.resolve([]),
    can(P.STOCK_READ) ? supabase.from('product_variants').select('id,sku').order('sku').limit(300).then((r) => (r.data ?? []) as { id: string; sku: string }[]) : Promise.resolve([]),
    can(P.STOCK_READ) ? supabase.from('warehouses').select('id,name').order('name').limit(100).then((r) => (r.data ?? []) as { id: string; name: string }[]) : Promise.resolve([]),
    can(P.STOCK_READ) ? supabase.from('variant_stock_blocks').select('id,variant_id,warehouse_id,qty,reason,blocked_at').eq('status', 'active').order('blocked_at', { ascending: false }).limit(100).then((r) => r.data ?? []) : Promise.resolve([]),
    can(P.COSTS_READ) ? supabase.from('margin_policy').select('min_margin_pct').maybeSingle().then((r) => r.data) : Promise.resolve(null),
  ])
  const position = sp.variant && can(P.STOCK_READ) ? await getStockPosition(sp.variant) : null
  const promise = sp.variant && sp.qty && sp.date && can(P.STOCK_READ) && Number(sp.qty) > 0 ? await getPromise(sp.variant, Number(sp.qty), sp.date) : null
  const skuOf = new Map(variants.map((v) => [v.id, v.sku]))
  const whOf = new Map(warehouses.map((w) => [w.id, w.name]))
  return (
    <>
      <PageHeader title="Crédit et disponibilité" description="Encours client plafonné (factures ouvertes et commandes non facturées). Le stock promis est le seul stock utilisable : bloqué, réservé et engagé en sont retirés." />
      <div className="space-y-4 p-4 sm:p-6">
        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Encours et plafond</h2>
          {credit.length === 0 ? <p className="mt-2 text-sm text-ink-soft">Aucun client avec plafond de crédit paramétré.</p> : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-2 font-semibold">Client</th><th className="px-2 py-2 text-right font-semibold">Plafond</th><th className="px-2 py-2 text-right font-semibold">Factures ouvertes</th><th className="px-2 py-2 text-right font-semibold">Commandes non facturées</th><th className="px-2 py-2 text-right font-semibold">Marge disponible</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {credit.map((c) => {
                    const name = clients.find((x) => x.id === c.client_id)?.name ?? c.client_id
                    return (
                      <tr key={c.client_id}><td className="px-3 py-2">{name}</td><td className="px-2 py-2 text-right tabular-nums">{money(c.credit_limit, c.base_currency)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{money(c.invoices_open, c.base_currency)}</td><td className="px-2 py-2 text-right tabular-nums">{money(c.orders_open, c.base_currency)}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{c.headroom === null ? '—' : <Badge tone={c.headroom < 0 ? 'danger' : 'success'}>{money(c.headroom, c.base_currency)}</Badge>}{c.excluded_no_rate > 0 && <span className="block text-xs text-warning-text">{c.excluded_no_rate} montant(s) sans taux validé</span>}</td></tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {can(P.DEROGATIONS_REQUEST) && clients.length > 0 && (
            <details className="mt-4"><summary className="cursor-pointer text-sm text-brand-600">Demander une dérogation de crédit (plafond élargi, datée, approuvée puis contrôlée)</summary>
              <div className="mt-3"><ActionForm action={creditDerogationRequestAction} submit="Demander la dérogation">
                <Field label="Client"><select name="client_id" required className={inputCls}><option value="">Choisir…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                <Field label="Dépassement maximal autorisé au total (devise de base)"><input name="max_amount" required inputMode="decimal" className={inputCls} /></Field>
                <Field label="Valide jusqu’au"><input type="date" name="valid_until" required className={inputCls} /></Field>
                <Field label="Motif (10 caractères minimum)"><input name="motive" required minLength={10} maxLength={500} className={inputCls} /></Field>
              </ActionForm></div>
            </details>
          )}
        </section>

        {can(P.COSTS_READ) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Marge et coûts</h2>
            <p className="mt-1 text-sm">Minimum de marge paramétré : {policy?.min_margin_pct !== undefined && policy?.min_margin_pct !== null ? `${policy.min_margin_pct} %` : 'aucun (pas de contrôle de marge)'}</p>
            {can(P.FINANCE_WRITE) && <div className="mt-3"><ActionForm action={marginPolicySetAction} submit="Enregistrer le minimum"><Field label="Marge minimale (%, vide = aucun contrôle)"><input name="min_margin_pct" inputMode="decimal" className={inputCls} /></Field></ActionForm></div>}
            {can(P.COSTS_READ) && (
              <div className="mt-4"><ActionForm action={variantCostSetAction} submit="Enregistrer le coût">
                <Field label="Variante"><select name="variant_id" required className={inputCls}><option value="">Choisir…</option>{variants.map((v) => <option key={v.id} value={v.id}>{v.sku}</option>)}</select></Field>
                <Field label="Coût unitaire"><input name="unit_cost" required inputMode="decimal" className={inputCls} /></Field>
                <Field label="Devise"><input name="currency" required maxLength={3} className={inputCls} /></Field>
              </ActionForm></div>
            )}
          </section>
        )}

        {can(P.STOCK_READ) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Disponibilité promise</h2>
            <form action="/commercial/credit" className="mt-3 grid gap-3 md:grid-cols-4 md:items-end">
              <Field label="Variante"><select name="variant" defaultValue={sp.variant ?? ''} className={inputCls}><option value="">Choisir…</option>{variants.map((v) => <option key={v.id} value={v.id}>{v.sku}</option>)}</select></Field>
              <Field label="Quantité"><input name="qty" defaultValue={sp.qty ?? ''} inputMode="numeric" className={inputCls} /></Field>
              <Field label="Date de livraison visée"><input type="date" name="date" defaultValue={sp.date ?? ''} className={inputCls} /></Field>
              <Button type="submit" variant="secondary" size="sm">Calculer</Button>
            </form>
            {position && (
              <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-4">
                <div><dt className="text-ink-soft">En stock</dt><dd className="tabular-nums">{formatQty(position.on_hand)}</dd></div>
                <div><dt className="text-ink-soft">Bloqué (non promis)</dt><dd className="tabular-nums">{formatQty(position.blocked)}</dd></div>
                <div><dt className="text-ink-soft">Réservé (prélevé)</dt><dd className="tabular-nums">{formatQty(position.reserved)}</dd></div>
                <div><dt className="text-ink-soft">Engagé non prélevé</dt><dd className="tabular-nums">{formatQty(position.committed_not_picked)}</dd></div>
                <div className="sm:col-span-4"><dt className="text-ink-soft">Utilisable</dt><dd className="text-base font-semibold tabular-nums">{formatQty(position.usable)}{position.over_committed && <span className="ml-2 text-xs text-danger-text">sur-engagé : à arbitrer</span>}</dd></div>
              </dl>
            )}
            {promise && (
              <div className="mt-4 rounded-md bg-canvas p-3 text-sm">
                <p className="font-semibold">{promise.promisable ? `Promesse possible : ${formatQty(Number(sp.qty))} pièce(s) à partir du stock utilisable.` : `Promesse impossible : il manque ${formatQty(promise.shortage)} pièce(s) dans le stock utilisable.`}</p>
                <ul className="mt-2 list-disc pl-5 text-xs text-ink-soft">
                  {promise.hypotheses.map((h) => <li key={h}>{h}</li>)}
                  {promise.expected_confirmed_by_date > 0 && <li>Production lancée attendue d’ici la date : {formatQty(promise.expected_confirmed_by_date)} (informatif, au niveau article, non promis).</li>}
                  {promise.expected_planned_by_date > 0 && <li>Production planifiée (non confirmée) : {formatQty(promise.expected_planned_by_date)} (hypothèse, non promise).</li>}
                </ul>
              </div>
            )}
          </section>
        )}

        {can(P.QUALITY_WRITE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Stock bloqué</h2>
            <div className="mt-3"><ActionForm action={stockBlockAction} submit="Bloquer le stock">
              <Field label="Variante"><select name="variant_id" required className={inputCls}><option value="">Choisir…</option>{variants.map((v) => <option key={v.id} value={v.id}>{v.sku}</option>)}</select></Field>
              <Field label="Entrepôt"><select name="warehouse_id" required className={inputCls}><option value="">Choisir…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
              <Field label="Quantité"><input name="qty" required inputMode="numeric" className={inputCls} /></Field>
              <Field label="Motif (10 caractères minimum)"><input name="reason" required minLength={10} maxLength={300} className={inputCls} /></Field>
            </ActionForm></div>
            <ul className="mt-4 divide-y divide-line text-sm">
              {blocks.map((b: { id: string; variant_id: string; warehouse_id: string; qty: number; reason: string }) => (
                <li key={b.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-mono text-xs">{skuOf.get(b.variant_id) ?? b.variant_id}</span><span>{formatQty(b.qty)} à {whOf.get(b.warehouse_id) ?? '—'}</span><span className="text-ink-soft">« {b.reason} »</span>
                  {can(P.QUALITY_APPROVE) && (
                    <div className="w-full sm:w-auto"><ActionForm action={stockBlockReleaseAction} submit="Lever le blocage (autre personne que l’auteur)">
                      <input type="hidden" name="block_id" value={b.id} />
                      <Field label="Motif de levée (10 caractères minimum)"><input name="reason" required minLength={10} maxLength={300} className={inputCls} /></Field>
                    </ActionForm></div>
                  )}
                </li>
              ))}
              {blocks.length === 0 && <li className="py-2 text-ink-soft">Aucun stock bloqué.</li>}
            </ul>
          </section>
        )}
      </div>
    </>
  )
}

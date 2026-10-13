import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { requirePermission } from '@/features/auth/guards'
import { ActionForm } from '@/features/commercial/components/crm-forms'
import { contractCreateAction, contractRenewAction, contractSignAction, contractTerminateAction } from '@/features/commercial/crm-actions'
import { clientOptions } from '@/features/commercial/services/commercial.service'
import { conditionsAt, listClientDocuments, listContracts, type ContractStatus } from '@/features/commercial/services/contracts.service'
import { fmtDay } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Contrats' }

const STATUS: Record<ContractStatus, { label: string; tone: 'neutral' | 'brand' | 'success' | 'danger' }> = {
  draft: { label: 'Brouillon', tone: 'neutral' },
  signed: { label: 'Signé', tone: 'success' },
  renewed: { label: 'Renouvelé', tone: 'brand' },
  terminated: { label: 'Résilié', tone: 'danger' },
}
const KINDS: Record<string, string> = { framework: 'Contrat cadre', price_agreement: 'Accord tarifaire', service: 'Prestation', other: 'Autre' }
const inputCls = 'rounded-md border border-line bg-white px-3 py-2 text-sm'

export default async function ContractsPage({ searchParams }: { searchParams: Promise<{ client?: string; on?: string }> }) {
  const ctx = await requirePermission(P.CONTRACTS_READ)
  const canWrite = ctx.permissions.includes(P.CONTRACTS_WRITE)
  const sp = await searchParams
  const [rows, clients] = await Promise.all([listContracts(), clientOptions()])
  const docs = canWrite ? await listClientDocuments(rows.filter((r) => r.status === 'draft').map((r) => r.client_id)) : {}
  const lookup = sp.client && sp.on && /^\d{4}-\d{2}-\d{2}$/.test(sp.on) ? await conditionsAt(sp.client, sp.on) : null
  return (
    <>
      <PageHeader title="Contrats" description="Un contrat ne vaut qu’une fois signé avec sa pièce signée de la GED. Les conditions s’appliquent à une date donnée ; un renouvellement commence après la fin du contrat remplacé." />
      <div className="space-y-4 p-4 sm:p-6">
        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Conditions valides à une date</h2>
          <form action="/commercial/contracts" className="mt-3 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">Client
              <select name="client" defaultValue={sp.client ?? ''} className={inputCls}><option value="">Choisir…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </label>
            <label className="grid gap-1 text-sm">Date
              <input type="date" name="on" defaultValue={sp.on ?? ''} className={inputCls} />
            </label>
            <Button type="submit" variant="secondary" size="sm">Consulter</Button>
          </form>
          {lookup && !lookup.ok && <p className="mt-3 text-sm text-danger-text">Consultation impossible : vérifiez le client et la date.</p>}
          {lookup && lookup.ok && lookup.value === null && <p className="mt-3 text-sm text-ink-soft">Aucun contrat signé ne couvre cette date : aucune condition n’est supposée.</p>}
          {lookup && lookup.ok && lookup.value && (
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <div><dt className="text-ink-soft">Contrat</dt><dd className="font-mono">{lookup.value.code} · {STATUS[lookup.value.status].label}</dd></div>
              <div><dt className="text-ink-soft">Validité</dt><dd>{fmtDay(lookup.value.start_on)} → {fmtDay(lookup.value.effective_end)}</dd></div>
              <div><dt className="text-ink-soft">Délai de paiement</dt><dd>{lookup.value.payment_terms ?? '—'}</dd></div>
              <div><dt className="text-ink-soft">Remise</dt><dd>{lookup.value.discount_pct === null ? '—' : `${lookup.value.discount_pct} %`}</dd></div>
              <div className="sm:col-span-2"><dt className="text-ink-soft">Conditions de prix</dt><dd>{lookup.value.price_conditions ?? '—'}</dd></div>
              <div className="sm:col-span-2"><dt className="text-ink-soft">Signé par</dt><dd>{lookup.value.signed_by_name} le {fmtDay(lookup.value.signed_at)}</dd></div>
            </dl>
          )}
        </section>

        {canWrite && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Nouveau contrat (brouillon)</h2>
            <div className="mt-3">
              <ActionForm action={contractCreateAction} submit="Créer le brouillon">
                <label className="grid gap-1 text-sm">Client
                  <select name="client_id" required className={inputCls}><option value="">Choisir…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </label>
                <label className="grid gap-1 text-sm">Type
                  <select name="kind" className={inputCls}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </label>
                <label className="grid gap-1 text-sm">Début<input type="date" name="start_on" required className={inputCls} /></label>
                <label className="grid gap-1 text-sm">Fin<input type="date" name="end_on" required className={inputCls} /></label>
                <label className="grid gap-1 text-sm">Devise (ex. EUR)<input name="currency" maxLength={3} className={inputCls} /></label>
                <label className="grid gap-1 text-sm">Délai de paiement<input name="payment_terms" maxLength={120} className={inputCls} /></label>
                <label className="grid gap-1 text-sm">Remise (%)<input name="discount_pct" inputMode="decimal" className={inputCls} /></label>
                <label className="grid gap-1 text-sm">Préavis de renouvellement (jours)<input type="number" name="renew_notice_days" min={0} max={365} defaultValue={30} className={inputCls} /></label>
                <label className="grid gap-1 text-sm md:col-span-2">Conditions de prix<input name="price_conditions" maxLength={1000} className={inputCls} /></label>
                <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" name="auto_renew" className="h-4 w-4" />Renouvellement automatique (sans effet tant que le renouvellement n’est pas signé)</label>
              </ActionForm>
            </div>
          </section>
        )}

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun contrat.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr>
                <th className="px-4 py-2 font-semibold">Contrat</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">Validité</th>
                <th className="px-2 py-2 font-semibold">Conditions</th><th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2 font-semibold">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-2"><span className="font-mono font-semibold">{r.code}</span><span className="block text-xs text-ink-soft">{KINDS[r.kind] ?? r.kind}{r.renews_contract_id ? ' · renouvellement' : ''}</span></td>
                    <td className="px-2 py-2">{r.client}</td>
                    <td className="whitespace-nowrap px-2 py-2">{fmtDay(r.start_on)} → {fmtDay(r.end_on)}{r.status === 'terminated' && <span className="block text-xs text-danger-text">résilié le {fmtDay(r.terminated_on)}</span>}</td>
                    <td className="px-2 py-2 text-xs">{r.payment_terms ?? '—'}{r.discount_pct !== null && <> · remise {r.discount_pct} %</>}{r.currency && <> · {r.currency}</>}</td>
                    <td className="px-2 py-2"><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
                    <td className="space-y-2 px-2 py-2">
                      {canWrite && r.status === 'draft' && (
                        <ActionForm action={contractSignAction} submit="Signer">
                          <input type="hidden" name="contract_id" value={r.id} />
                          <label className="grid gap-1 text-xs">Pièce signée (GED du client)
                            <select name="document_id" required className={inputCls}><option value="">Choisir…</option>{(docs[r.client_id] ?? []).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select>
                          </label>
                          <label className="grid gap-1 text-xs">Nom du signataire<input name="signed_by" required minLength={2} className={inputCls} /></label>
                        </ActionForm>
                      )}
                      {canWrite && r.status === 'signed' && (
                        <>
                          <details><summary className="cursor-pointer text-xs text-brand-600">Renouveler</summary>
                            <ActionForm action={contractRenewAction} submit="Créer le renouvellement">
                              <input type="hidden" name="contract_id" value={r.id} />
                              <label className="grid gap-1 text-xs">Début<input type="date" name="start_on" required className={inputCls} /></label>
                              <label className="grid gap-1 text-xs">Fin<input type="date" name="end_on" required className={inputCls} /></label>
                              <label className="grid gap-1 text-xs">Devise<input name="currency" maxLength={3} required className={inputCls} /></label>
                              <label className="grid gap-1 text-xs">Délai de paiement<input name="payment_terms" maxLength={120} className={inputCls} /></label>
                              <label className="grid gap-1 text-xs">Remise (%)<input name="discount_pct" inputMode="decimal" className={inputCls} /></label>
                              <label className="grid gap-1 text-xs">Conditions de prix<input name="price_conditions" maxLength={1000} className={inputCls} /></label>
                            </ActionForm>
                          </details>
                          <details><summary className="cursor-pointer text-xs text-danger-text">Résilier</summary>
                            <ActionForm action={contractTerminateAction} submit="Résilier">
                              <input type="hidden" name="contract_id" value={r.id} />
                              <label className="grid gap-1 text-xs">Date de résiliation<input type="date" name="terminated_on" required min={r.start_on} max={r.end_on} className={inputCls} /></label>
                              <label className="grid gap-1 text-xs">Motif<input name="reason" required minLength={3} maxLength={300} className={inputCls} /></label>
                            </ActionForm>
                          </details>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

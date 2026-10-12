'use client'

import { useActionState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { formatQty, unitLabel } from '@/lib/bom/options'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { addForecastAction, addReceiptAction, deleteRowAction, saveParamsAction } from '../actions'
import type { Forecast, ParamRow, Receipt } from '../types'

const fmt = (d: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`))
const dec = (n: number | null) => (n === null ? '' : String(n).replace('.', ','))

export function ForecastsManager({ forecasts, articles, canWrite }: { forecasts: Forecast[]; articles: { id: string; ref: string; name: string; client: string; has_bom: boolean }[]; canWrite: boolean }) {
  const [state, action] = useActionState(addForecastAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <div className="space-y-4">
      {canWrite && (
        <form action={action} className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card" noValidate>
          <p className="text-sm font-semibold">Ajouter une prévision de demande</p>
          {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
          {state?.ok && <p role="status" className="text-xs text-success-text">{state.message}</p>}
          <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_10rem_8rem_minmax(0,1.5fr)_auto] md:items-end">
            <FormField id="fc-article" label="Article *" errors={errs.article_id}>
              <Select id="fc-article" name="article_id" defaultValue={v('article_id')} aria-invalid={Boolean(errs.article_id)}>
                <option value="">— Choisir —</option>
                {articles.map((a) => <option key={a.id} value={a.id}>{a.ref} — {a.name} · {a.client}{a.has_bom ? '' : ' (sans BOM validée)'}</option>)}
              </Select>
            </FormField>
            <FormField id="fc-date" label="Date de livraison *" errors={errs.forecast_date}><Input id="fc-date" name="forecast_date" type="date" defaultValue={v('forecast_date')} /></FormField>
            <FormField id="fc-qty" label="Quantité *" errors={errs.qty}><Input id="fc-qty" name="qty" inputMode="decimal" defaultValue={v('qty')} placeholder="500" /></FormField>
            <FormField id="fc-note" label="Note" errors={errs.note}><Input id="fc-note" name="note" maxLength={300} defaultValue={v('note')} placeholder="Saison hiver…" /></FormField>
            <SubmitButton pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
          </div>
        </form>
      )}
      {forecasts.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune prévision. Les prévisions s’ajoutent aux commandes confirmées dans les simulations.</p> : (
        <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Article</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">Livraison</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">Note</th>{canWrite && <th className="w-24 px-4 py-2" />}</tr></thead>
            <tbody className="divide-y divide-line">
              {forecasts.map((f) => (
                <tr key={f.id}>
                  <td className="px-4 py-2"><span className="font-mono text-xs font-semibold text-brand-700">{f.article_ref}</span> {f.article_name}</td>
                  <td className="px-2 py-2 text-ink-soft">{f.client_name}</td>
                  <td className="whitespace-nowrap px-2 py-2">{fmt(f.forecast_date)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatQty(f.qty)}</td>
                  <td className="px-2 py-2 text-ink-soft">{f.note ?? ''}</td>
                  {canWrite && <td className="px-4 py-2 text-right"><RpcButton action={deleteRowAction} fields={{ id: f.id, table: 'mrp_forecasts' }} variant="ghost" size="sm" confirm="Supprimer cette prévision ?" aria-label="Supprimer la prévision"><Trash2 className="h-4 w-4 text-danger-text" /></RpcButton></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ParamRowForm({ p, canWrite }: { p: ParamRow; canWrite: boolean }) {
  const [state, action] = useActionState(saveParamsAction, null)
  const formId = `prm-${p.material_id}`
  return (
    <tr className="align-top">
      <td className="px-4 py-2"><span className="font-medium">{p.name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{p.code}</span>{p.supplier_name && <span className="block text-xs text-ink-soft">{p.supplier_name}{p.supplier_lead !== null ? ` · délai fournisseur ${p.supplier_lead} j` : ''}</span>}</td>
      {canWrite ? (<>
        <td className="px-2 py-2"><form id={formId} action={action}><input type="hidden" name="material_id" value={p.material_id} /></form>
          <Input form={formId} name="lead_time_days" inputMode="numeric" defaultValue={dec(p.lead_time_days)} placeholder={p.supplier_lead !== null ? String(p.supplier_lead) : 'défaut'} aria-label={`Délai en jours, ${p.name}`} className="h-8 w-24" /></td>
        <td className="px-2 py-2"><Input form={formId} name="moq" inputMode="decimal" defaultValue={p.moq ? dec(p.moq) : ''} placeholder="0" aria-label={`MOQ, ${p.name}`} className="h-8 w-24" /></td>
        <td className="px-2 py-2"><Input form={formId} name="order_multiple" inputMode="decimal" defaultValue={p.order_multiple ? dec(p.order_multiple) : ''} placeholder="0" aria-label={`Multiple, ${p.name}`} className="h-8 w-24" />
          {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-xs text-success-text' : 'text-xs text-danger-text'}>{state.message}</p>}</td>
        <td className="px-4 py-2 text-right"><Button type="submit" form={formId} variant="ghost" size="sm" aria-label={`Enregistrer ${p.name}`} title="Enregistrer"><Save className="h-4 w-4" /></Button></td>
      </>) : (<>
        <td className="px-2 py-2">{p.lead_time_days ?? '—'}</td><td className="px-2 py-2">{p.moq ? formatQty(p.moq) : '—'}</td><td className="px-2 py-2">{p.order_multiple ? formatQty(p.order_multiple) : '—'}</td><td />
      </>)}
    </tr>
  )
}

export function ParamsTable({ rows, canWrite }: { rows: ParamRow[]; canWrite: boolean }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Délai (jours)</th><th className="px-2 py-2 font-semibold">MOQ</th><th className="px-2 py-2 font-semibold">Multiple</th><th className="w-16 px-4 py-2" /></tr></thead>
        <tbody className="divide-y divide-line">
          {rows.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-ink-soft">Aucun composant au catalogue.</td></tr>}
          {rows.map((p) => <ParamRowForm key={p.material_id} p={p} canWrite={canWrite} />)}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-2 text-xs text-ink-soft">Délai vide = délai du fournisseur, sinon délai par défaut de la simulation. MOQ = quantité minimale de commande ; multiple = la commande est arrondie au multiple supérieur.</p>
    </div>
  )
}

export function ReceiptsManager({ receipts, materials, canWrite }: { receipts: Receipt[]; materials: { material_id: string; code: string; name: string; unit: string }[]; canWrite: boolean }) {
  const [state, action] = useActionState(addReceiptAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <div className="space-y-4">
      {canWrite && (
        <form action={action} className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card" noValidate>
          <p className="text-sm font-semibold">Planifier une réception (commande d’achat en cours)</p>
          {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
          {state?.ok && <p role="status" className="text-xs text-success-text">{state.message}</p>}
          <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_8rem_10rem_minmax(0,1.5fr)_auto] md:items-end">
            <FormField id="rc-mat" label="Composant *" errors={errs.material_id}>
              <Select id="rc-mat" name="material_id" defaultValue={v('material_id')}><option value="">— Choisir —</option>{materials.map((m) => <option key={m.material_id} value={m.material_id}>{m.name} ({m.code})</option>)}</Select>
            </FormField>
            <FormField id="rc-qty" label="Quantité *" errors={errs.qty}><Input id="rc-qty" name="qty" inputMode="decimal" defaultValue={v('qty')} /></FormField>
            <FormField id="rc-date" label="Date de réception *" errors={errs.due_date}><Input id="rc-date" name="due_date" type="date" defaultValue={v('due_date')} /></FormField>
            <FormField id="rc-ref" label="Référence" errors={errs.reference}><Input id="rc-ref" name="reference" maxLength={120} defaultValue={v('reference')} placeholder="PO-2026-014" /></FormField>
            <SubmitButton pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
          </div>
        </form>
      )}
      {receipts.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-8 text-center text-sm text-ink-soft">Aucune réception planifiée. Elles viennent réduire les achats suggérés tant que le module Achats n’alimente pas le MRP.</p> : (
        <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">Réception</th><th className="px-2 py-2 font-semibold">Référence</th>{canWrite && <th className="w-20 px-4 py-2" />}</tr></thead>
            <tbody className="divide-y divide-line">
              {receipts.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2"><span className="font-medium">{r.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{r.material_code}</span></td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.qty)} {unitLabel(r.unit)}</td>
                  <td className="whitespace-nowrap px-2 py-2">{fmt(r.due_date)}</td>
                  <td className="px-2 py-2 text-ink-soft">{r.reference ?? ''}</td>
                  {canWrite && <td className="px-4 py-2 text-right"><RpcButton action={deleteRowAction} fields={{ id: r.id, table: 'mrp_scheduled_receipts' }} variant="ghost" size="sm" confirm="Supprimer cette réception ?" aria-label="Supprimer la réception"><Trash2 className="h-4 w-4 text-danger-text" /></RpcButton></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

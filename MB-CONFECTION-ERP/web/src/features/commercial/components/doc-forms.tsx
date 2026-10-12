'use client'

import { useActionState, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, Plus, Save, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { formatQty } from '@/lib/bom/options'
import { useManualAction } from '@/lib/use-manual-action'
import type { FormState } from '@/features/auth/types'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { addInvoiceLineAction, addQuoteLineAction, createCreditNoteAction, createManualInvoiceAction, createQuoteAction, decideQuoteAction, issueCreditNoteAction, recordPaymentAction, updateInvoiceAction, updateQuoteAction } from '../actions'
import type { DocLine } from '../services/commercial.service'
import { PAY_METHODS, money } from '../status'

type Act = (prev: FormState, fd: FormData) => Promise<FormState>
const dec = (n: number) => String(n).replace('.', ',')
const Msg = ({ s }: { s: FormState }) => (s?.message ? <p role={s.ok ? 'status' : 'alert'} className={s.ok ? 'text-xs text-success-text' : 'text-xs text-danger-text'}>{s.message}</p> : null)

function LineRow({ l, editable, update, remove, qtyOnly, currency }: { l: DocLine; editable: boolean; update: Act; remove?: Act; qtyOnly?: boolean; currency: string }) {
  const [state, action] = useActionState(update, null)
  const formId = `dl-${l.id}`
  const total = Math.round(l.qty * l.unit_price * (1 - l.discount_pct / 100) * 100) / 100
  return (
    <tr className="align-top">
      {editable && !qtyOnly ? (<>
        <td className="px-4 py-2"><form id={formId} action={action}><input type="hidden" name="id" value={l.id} /></form><Input form={formId} name="description" maxLength={300} defaultValue={l.description} aria-label="Désignation" className="h-8 min-w-48" /><Msg s={state} /></td>
        <td className="px-2 py-2"><Input form={formId} name="qty" inputMode="decimal" defaultValue={dec(l.qty)} aria-label="Quantité" className="h-8 w-20" /></td>
        <td className="px-2 py-2"><Input form={formId} name="unit_price" inputMode="decimal" defaultValue={dec(l.unit_price)} aria-label="Prix unitaire" className="h-8 w-24" /></td>
        <td className="px-2 py-2"><Input form={formId} name="discount_pct" inputMode="decimal" defaultValue={l.discount_pct ? dec(l.discount_pct) : ''} placeholder="0" aria-label="Remise en %" className="h-8 w-16" /></td>
      </>) : editable && qtyOnly ? (<>
        <td className="px-4 py-2">{l.description}<form id={formId} action={action}><input type="hidden" name="id" value={l.id} /></form><Msg s={state} /></td>
        <td className="px-2 py-2"><Input form={formId} name="qty" inputMode="decimal" defaultValue={dec(l.qty)} aria-label="Quantité" className="h-8 w-20" /></td>
        <td className="px-2 py-2 tabular-nums">{money(l.unit_price, currency)}</td><td className="px-2 py-2 tabular-nums">{l.discount_pct ? `${formatQty(l.discount_pct)} %` : '—'}</td>
      </>) : (<>
        <td className="px-4 py-2">{l.description}{l.extra && <span className="block text-xs text-ink-soft">{l.extra}</span>}</td>
        <td className="px-2 py-2 tabular-nums">{formatQty(l.qty)}</td><td className="px-2 py-2 tabular-nums">{money(l.unit_price, currency)}</td><td className="px-2 py-2 tabular-nums">{l.discount_pct ? `${formatQty(l.discount_pct)} %` : '—'}</td>
      </>)}
      <td className="px-2 py-2 text-right tabular-nums">{money(total, currency)}</td>
      <td className="px-4 py-2 text-right">{editable && <div className="flex justify-end gap-1">
        <Button type="submit" form={formId} variant="ghost" size="sm" aria-label="Enregistrer la ligne" title="Enregistrer"><Save className="h-4 w-4" /></Button>
        {remove && <RpcButton action={remove} fields={{ id: l.id }} variant="ghost" size="sm" aria-label="Supprimer la ligne" confirm="Supprimer cette ligne ?">×</RpcButton>}</div>}</td>
    </tr>
  )
}

/** Tableau de lignes de document (devis, facture, avoir) : édition en ligne tant que le document est un brouillon. */
export function DocLines({ lines, editable, update, remove, qtyOnly, currency }: { lines: DocLine[]; editable: boolean; update: Act; remove?: Act; qtyOnly?: boolean; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Désignation</th><th className="px-2 py-2 font-semibold">Qté</th><th className="px-2 py-2 font-semibold">Prix unit. HT</th><th className="px-2 py-2 font-semibold">Remise</th><th className="px-2 py-2 text-right font-semibold">Total HT</th><th className="w-24 px-4 py-2" /></tr></thead>
        <tbody className="divide-y divide-line">
          {lines.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-ink-soft">Aucune ligne.</td></tr>}
          {lines.map((l) => <LineRow key={l.id} l={l} editable={editable} update={update} remove={remove} qtyOnly={qtyOnly} currency={currency} />)}
        </tbody>
      </table>
    </div>
  )
}

export function Totals({ subtotal, tax, total, rate, currency, extra }: { subtotal: number; tax: number; total: number; rate: number; currency: string; extra?: React.ReactNode }) {
  return (
    <dl className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-t border-line p-4 text-sm">
      <dt className="text-ink-soft">Total HT</dt><dd className="text-right tabular-nums">{money(subtotal, currency)}</dd>
      <dt className="text-ink-soft">TVA {formatQty(rate)} %</dt><dd className="text-right tabular-nums">{money(tax, currency)}</dd>
      <dt className="font-semibold">Total TTC</dt><dd className="text-right text-base font-semibold tabular-nums">{money(total, currency)}</dd>
      {extra}
    </dl>
  )
}

// ---------------------------------------------------------------------
// Devis
// ---------------------------------------------------------------------
export function NewQuoteForm({ clients, prospects, defaultParty, vatByParty = {} }: { clients: { id: string; name: string }[]; prospects: { id: string; name: string; code: string }[]; defaultParty?: string; vatByParty?: Record<string, number> }) {
  const [state, action] = useActionState(createQuoteAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb = '') => state?.values?.[k] ?? fb
  const [party, setParty] = useState(v('party', defaultParty ?? ''))
  const autoVat = vatByParty[party]
  const [tax, setTax] = useState(autoVat !== undefined ? String(autoVat) : v('tax_rate', '19'))
  const pickParty = (value: string) => { setParty(value); if (vatByParty[value] !== undefined) setTax(String(vatByParty[value])) }
  return (
    <form action={action} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3"><h2 className="text-base font-semibold">Devis</h2><p className="text-xs text-ink-soft">Pour un client (avec ses articles) ou pour un prospect (lignes libres). Code DEV-AAAA-xxxx généré.</p></div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField id="party" label="Client ou prospect *" errors={errs.party}>
            <Select id="party" name="party" defaultValue={v('party', defaultParty)} onChange={(e) => pickParty(e.target.value)} aria-invalid={Boolean(errs.party)}>
              <option value="">— Choisir —</option>
              <optgroup label="Clients">{clients.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}</optgroup>
              <optgroup label="Prospects ouverts">{prospects.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name} ({p.code})</option>)}</optgroup>
            </Select></FormField></div>
          <FormField id="valid_until" label="Valable jusqu’au" errors={errs.valid_until} hint="Par défaut 30 jours."><Input id="valid_until" name="valid_until" type="date" defaultValue={v('valid_until')} /></FormField>
          <FormField id="lead_days" label="Délai de livraison (jours)" errors={errs.lead_days}><Input id="lead_days" name="lead_days" inputMode="numeric" defaultValue={v('lead_days', '30')} /></FormField>
          <FormField id="tax_rate" label="TVA (%)" errors={errs.tax_rate} hint={autoVat !== undefined ? (autoVat === 0 ? 'Export ou client exonéré : sans TVA, imposé par le pays du client.' : 'Client local : TVA normale.') : 'Prospect : saisissez le taux (0 pour un export exonéré).'}><Input id="tax_rate" name="tax_rate" inputMode="decimal" value={tax} readOnly={autoVat !== undefined} onChange={(e) => setTax(e.target.value)} /></FormField>
          <FormField id="payment_terms" label="Conditions de paiement" errors={errs.payment_terms}><Input id="payment_terms" name="payment_terms" maxLength={120} defaultValue={v('payment_terms')} placeholder="30 jours fin de mois" /></FormField>
          <div className="sm:col-span-2"><FormField id="notes" label="Notes (visibles sur le devis)" errors={errs.notes}><Textarea id="notes" name="notes" rows={3} maxLength={2000} defaultValue={v('notes')} /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2"><Link href="/commercial/quotes" className={buttonVariants({ variant: 'secondary' })}>Annuler</Link><SubmitButton pendingText="Création…">Créer le devis</SubmitButton></div>
    </form>
  )
}

export function QuoteHeaderForm({ q }: { q: { id: string; valid_until: string; lead_days: number; tax_rate: number; payment_terms: string | null; notes: string | null } }) {
  const [state, action] = useActionState(updateQuoteAction, null)
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
      <input type="hidden" name="id" value={q.id} />
      <div><label htmlFor="q-valid" className="mb-1 block text-xs font-semibold">Valable jusqu’au</label><Input id="q-valid" name="valid_until" type="date" defaultValue={q.valid_until} className="w-40" /></div>
      <div><label htmlFor="q-lead" className="mb-1 block text-xs font-semibold">Délai (j)</label><Input id="q-lead" name="lead_days" inputMode="numeric" defaultValue={q.lead_days} className="w-20" /></div>
      <div><label htmlFor="q-tax" className="mb-1 block text-xs font-semibold">TVA %</label><Input id="q-tax" name="tax_rate" inputMode="decimal" defaultValue={dec(q.tax_rate)} className="w-20" /></div>
      <div className="min-w-40 flex-1"><label htmlFor="q-terms" className="mb-1 block text-xs font-semibold">Conditions de paiement</label><Input id="q-terms" name="payment_terms" maxLength={120} defaultValue={q.payment_terms ?? ''} /></div>
      <div className="min-w-40 flex-1"><label htmlFor="q-notes" className="mb-1 block text-xs font-semibold">Notes</label><Input id="q-notes" name="notes" maxLength={2000} defaultValue={q.notes ?? ''} /></div>
      <SubmitButton variant="secondary" pendingText="Enregistrement…"><Save className="h-4 w-4" /> Enregistrer</SubmitButton>
      <Msg s={state} />
    </form>
  )
}

export function AddQuoteLine({ quoteId, articles, canArticle }: { quoteId: string; articles: { id: string; ref: string; name: string }[]; canArticle: boolean }) {
  const [state, action] = useActionState(addQuoteLineAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form action={action} className="space-y-3 border-t border-line bg-canvas/50 p-4" noValidate>
      <input type="hidden" name="quote_id" value={quoteId} />
      <p className="text-sm font-semibold">Ajouter une ligne</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_6rem_7rem_5rem_auto] md:items-end">
        {canArticle ? <FormField id="ql-art" label="Article du client" errors={errs.article_id}><Select id="ql-art" name="article_id" defaultValue={v('article_id')}><option value="">— Ligne libre —</option>{articles.map((a) => <option key={a.id} value={a.id}>{a.ref} — {a.name}</option>)}</Select></FormField> : <span />}
        <FormField id="ql-desc" label="Désignation" errors={errs.description} hint={canArticle ? 'Vide = nom de l’article.' : undefined}><Input id="ql-desc" name="description" maxLength={300} defaultValue={v('description')} /></FormField>
        <FormField id="ql-qty" label="Quantité *" errors={errs.qty}><Input id="ql-qty" name="qty" inputMode="decimal" defaultValue={v('qty')} /></FormField>
        <FormField id="ql-price" label="Prix HT" errors={errs.unit_price}><Input id="ql-price" name="unit_price" inputMode="decimal" defaultValue={v('unit_price')} placeholder="0" /></FormField>
        <FormField id="ql-disc" label="Remise %" errors={errs.discount_pct}><Input id="ql-disc" name="discount_pct" inputMode="decimal" defaultValue={v('discount_pct')} placeholder="0" /></FormField>
        <SubmitButton pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
      </div>
    </form>
  )
}

/** Réponse du client : accepté, ou refusé avec motif. */
export function QuoteDecideDialog({ id, code }: { id: string; code: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="command" size="sm" onClick={() => setOpen(true)}><Check className="h-4 w-4" /> Réponse du client</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Réponse du client — ${code}`}><QuoteDecideForm id={id} onDone={() => setOpen(false)} /></Dialog>
    </>
  )
}
function QuoteDecideForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [state, action, pending] = useManualAction(decideQuoteAction, null)
  const formRef = useRef<HTMLFormElement>(null)
  const decision = useRef<HTMLInputElement>(null)
  const decide = (value: 'accept' | 'reject') => { if (decision.current) decision.current.value = value; formRef.current?.requestSubmit() }
  return (
    <form ref={formRef} onSubmit={action} className="space-y-3">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="decision" ref={decision} defaultValue="accept" />
      {state && !state.ok && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <FormField id="reason" label="Motif / commentaire" hint="Obligatoire en cas de refus."><Textarea id="reason" name="reason" rows={3} maxLength={300} autoFocus /></FormField>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>{state?.ok ? 'Fermer' : 'Annuler'}</Button>
        <Button type="button" variant="danger" disabled={pending} onClick={() => decide('reject')}><X className="h-4 w-4" /> Refusé</Button>
        <Button type="button" disabled={pending} onClick={() => decide('accept')}><Check className="h-4 w-4" /> Accepté</Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Factures, encaissements, avoirs
// ---------------------------------------------------------------------
export function NewManualInvoiceForm({ clients }: { clients: { id: string; name: string }[] }) {
  const [state, action] = useActionState(createManualInvoiceAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb = '') => state?.values?.[k] ?? fb
  return (
    <form action={action} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3"><h2 className="text-base font-semibold">Facture sans commande</h2><p className="text-xs text-ink-soft">Prestations, frais, échantillons… Les factures de marchandises se créent depuis la commande. Le numéro est attribué à l’émission.</p></div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="client_id" label="Client *" errors={errs.client_id}><Select id="client_id" name="client_id" defaultValue={v('client_id')}><option value="">— Choisir —</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></FormField>
          <FormField id="tax_rate" label="TVA (%)" errors={errs.tax_rate}><Input id="tax_rate" name="tax_rate" inputMode="decimal" defaultValue={v('tax_rate', '19')} /></FormField>
          <div className="sm:col-span-2"><FormField id="payment_terms" label="Conditions de paiement" errors={errs.payment_terms}><Input id="payment_terms" name="payment_terms" maxLength={120} defaultValue={v('payment_terms')} /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2"><Link href="/commercial/invoices" className={buttonVariants({ variant: 'secondary' })}>Annuler</Link><SubmitButton pendingText="Création…">Créer le brouillon</SubmitButton></div>
    </form>
  )
}

export function InvoiceHeaderForm({ i }: { i: { id: string; tax_rate: number; payment_terms: string | null; notes: string | null } }) {
  const [state, action] = useActionState(updateInvoiceAction, null)
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
      <input type="hidden" name="id" value={i.id} />
      <div><label htmlFor="i-tax" className="mb-1 block text-xs font-semibold">TVA %</label><Input id="i-tax" name="tax_rate" inputMode="decimal" defaultValue={dec(i.tax_rate)} className="w-20" /></div>
      <div className="min-w-40 flex-1"><label htmlFor="i-terms" className="mb-1 block text-xs font-semibold">Conditions de paiement</label><Input id="i-terms" name="payment_terms" maxLength={120} defaultValue={i.payment_terms ?? ''} /></div>
      <div className="min-w-40 flex-1"><label htmlFor="i-notes" className="mb-1 block text-xs font-semibold">Notes</label><Input id="i-notes" name="notes" maxLength={2000} defaultValue={i.notes ?? ''} /></div>
      <SubmitButton variant="secondary" pendingText="Enregistrement…"><Save className="h-4 w-4" /> Enregistrer</SubmitButton>
      <Msg s={state} />
    </form>
  )
}

export function AddInvoiceLine({ invoiceId }: { invoiceId: string }) {
  const [state, action] = useActionState(addInvoiceLineAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form action={action} className="space-y-3 border-t border-line bg-canvas/50 p-4" noValidate>
      <input type="hidden" name="invoice_id" value={invoiceId} />
      <p className="text-sm font-semibold">Ajouter une ligne</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_6rem_7rem_5rem_auto] md:items-end">
        <FormField id="il-desc" label="Désignation *" errors={errs.description}><Input id="il-desc" name="description" maxLength={300} defaultValue={v('description')} /></FormField>
        <FormField id="il-qty" label="Quantité *" errors={errs.qty}><Input id="il-qty" name="qty" inputMode="decimal" defaultValue={v('qty')} /></FormField>
        <FormField id="il-price" label="Prix HT" errors={errs.unit_price}><Input id="il-price" name="unit_price" inputMode="decimal" defaultValue={v('unit_price')} /></FormField>
        <FormField id="il-disc" label="Remise %" errors={errs.discount_pct}><Input id="il-disc" name="discount_pct" inputMode="decimal" defaultValue={v('discount_pct')} /></FormField>
        <SubmitButton pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
      </div>
    </form>
  )
}

export function PaymentDialog({ invoiceId, code, balance, currency }: { invoiceId: string; code: string; balance: number; currency: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="command" size="sm" onClick={() => setOpen(true)}>Enregistrer un paiement</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Paiement — ${code}`}><PaymentForm invoiceId={invoiceId} balance={balance} currency={currency} onDone={() => setOpen(false)} /></Dialog>
    </>
  )
}
function PaymentForm({ invoiceId, balance, currency, onDone }: { invoiceId: string; balance: number; currency: string; onDone: () => void }) {
  const [state, action] = useActionState(recordPaymentAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb = '') => state?.values?.[k] ?? fb
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="invoice_id" value={invoiceId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      {state?.ok && <Alert tone="success">{state.message}</Alert>}
      <p className="text-sm text-ink-soft">Solde restant dû : <strong className="tabular-nums text-ink">{money(balance, currency)}</strong></p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="amount" label="Montant *" errors={errs.amount}><Input id="amount" name="amount" inputMode="decimal" defaultValue={v('amount', dec(balance))} autoFocus /></FormField>
        <FormField id="paid_on" label="Date du paiement" errors={errs.paid_on}><Input id="paid_on" name="paid_on" type="date" defaultValue={v('paid_on', new Date().toISOString().slice(0, 10))} /></FormField>
        <FormField id="method" label="Mode de règlement"><Select id="method" name="method" defaultValue={v('method', 'transfer')}>{PAY_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></FormField>
        <FormField id="reference" label="Référence" errors={errs.reference}><Input id="reference" name="reference" maxLength={120} defaultValue={v('reference')} placeholder="N° de virement, de chèque…" /></FormField>
      </div>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>{state?.ok ? 'Fermer' : 'Annuler'}</Button><SubmitButton pendingText="Enregistrement…">Enregistrer</SubmitButton></div>
    </form>
  )
}

export function NewCreditNoteDialog({ invoiceId, code }: { invoiceId: string; code: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="command" size="sm" onClick={() => setOpen(true)}>Créer un avoir</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Avoir sur ${code}`}><CreditForm invoiceId={invoiceId} onCancel={() => setOpen(false)} /></Dialog>
    </>
  )
}
function CreditForm({ invoiceId, onCancel }: { invoiceId: string; onCancel: () => void }) {
  const [state, action] = useActionState(createCreditNoteAction, null)
  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="invoice_id" value={invoiceId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <FormField id="reason" label="Motif de l’avoir *" errors={state?.fieldErrors?.reason} hint="Retour de marchandise, remise commerciale, erreur de facturation…"><Input id="reason" name="reason" maxLength={300} defaultValue={state?.values?.reason ?? ''} autoFocus /></FormField>
      <p className="text-xs text-ink-soft">L’avoir est créé en brouillon avec les lignes de la facture : ajustez les quantités à créditer puis émettez-le.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onCancel}>Annuler</Button><SubmitButton pendingText="Création…">Créer l’avoir</SubmitButton></div>
    </form>
  )
}

/** Émission d'un avoir : option de réouverture des quantités de la commande (refacturation possible). */
export function IssueCreditForm({ id, hasOrder }: { id: string; hasOrder: boolean }) {
  const [state, action] = useActionState(issueCreditNoteAction, null)
  return (
    <form action={action} onSubmit={(e) => { if (!window.confirm('Émettre l’avoir ? Il recevra son numéro définitif et ne sera plus modifiable.')) e.preventDefault() }} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="id" value={id} />
      {hasOrder && <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="reopen" className="h-4 w-4 accent-brand-500" /> Rouvrir les quantités de la commande (à refacturer)</label>}
      <SubmitButton size="sm" pendingText="Émission…">Émettre l’avoir</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-xs text-success-text' : 'text-xs text-danger-text'}>{state.message}</p>}
    </form>
  )
}

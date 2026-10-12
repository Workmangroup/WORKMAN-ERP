'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { PackageCheck, Plus, Save, Undo2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { formatMoney, formatQty, unitLabel } from '@/lib/bom/options'
import { useManualAction } from '@/lib/use-manual-action'
import { RpcButton } from '@/features/stock/components/rpc-button'
import type { WarehouseWithLocations } from '@/features/stock/types'
import { addOrderLineAction, createOrderAction, deleteOrderLineAction, receiveAction, returnAction, updateOrderHeaderAction, updateOrderLineAction } from '../actions'
import type { OrderLine } from '../services/purchases.service'

const dec = (n: number | null) => (n === null ? '' : String(n).replace('.', ','))

export function NewOrderForm({ suppliers }: { suppliers: { id: string; name: string }[] }) {
  const [state, action] = useActionState(createOrderAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form action={action} className="space-y-4" noValidate>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <section className="rounded-md border border-line bg-white shadow-card">
        <div className="border-b border-line px-5 py-3"><h2 className="text-base font-semibold">Commande fournisseur directe</h2><p className="text-xs text-ink-soft">Le plus souvent, les commandes naissent d’une demande d’achat validée. Une commande directe reste possible (urgence, réassort). Numéro PO-AAAA-xxxxx généré.</p></div>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <FormField id="supplier_id" label="Fournisseur *" errors={errs.supplier_id}><Select id="supplier_id" name="supplier_id" defaultValue={v('supplier_id')}><option value="">— Choisir —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></FormField>
          <FormField id="expected_date" label="Livraison attendue le" errors={errs.expected_date}><Input id="expected_date" name="expected_date" type="date" defaultValue={v('expected_date')} /></FormField>
          <div className="sm:col-span-2"><FormField id="notes" label="Notes" errors={errs.notes}><Textarea id="notes" name="notes" rows={2} maxLength={1000} defaultValue={v('notes')} /></FormField></div>
        </div>
      </section>
      <div className="flex justify-end gap-2"><Link href="/purchases/orders" className={buttonVariants({ variant: 'secondary' })}>Annuler</Link><SubmitButton pendingText="Création…">Créer la commande</SubmitButton></div>
    </form>
  )
}

export function HeaderForm({ id, expected, notes }: { id: string; expected: string | null; notes: string | null }) {
  const [state, action] = useActionState(updateOrderHeaderAction, null)
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
      <input type="hidden" name="id" value={id} />
      <div><label htmlFor="h-exp" className="mb-1 block text-xs font-semibold">Livraison attendue</label><Input id="h-exp" name="expected_date" type="date" defaultValue={expected?.slice(0, 10) ?? ''} className="w-44" /></div>
      <div className="min-w-48 flex-1"><label htmlFor="h-notes" className="mb-1 block text-xs font-semibold">Notes</label><Input id="h-notes" name="notes" maxLength={1000} defaultValue={notes ?? ''} /></div>
      <SubmitButton variant="secondary" pendingText="Enregistrement…"><Save className="h-4 w-4" /> Enregistrer</SubmitButton>
      {state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-xs text-success-text' : 'text-xs text-danger-text'}>{state.message}</p>}
    </form>
  )
}

function LineEditRow({ l, editable }: { l: OrderLine; editable: boolean }) {
  const [state, action] = useActionState(updateOrderLineAction, null)
  const formId = `pol-${l.id}`
  const open = l.qty_ordered - (l.qty_received - l.qty_returned)
  return (
    <tr className="align-top">
      <td className="px-4 py-2"><span className="font-medium">{l.material_name}</span><span className="ml-2 font-mono text-xs text-ink-faint">{l.material_code}</span>{l.note && <span className="block text-xs text-ink-soft">{l.note}</span>}</td>
      {editable ? (<>
        <td className="px-2 py-2"><form id={formId} action={action}><input type="hidden" name="id" value={l.id} /></form><div className="flex items-center gap-1"><Input form={formId} name="qty_ordered" inputMode="decimal" defaultValue={dec(l.qty_ordered)} aria-label={`Quantité ${l.material_name}`} className="h-8 w-24" /><span className="text-xs text-ink-soft">{unitLabel(l.unit)}</span></div></td>
        <td className="px-2 py-2"><Input form={formId} name="unit_price" inputMode="decimal" defaultValue={dec(l.unit_price)} aria-label={`Prix unitaire ${l.material_name}`} className="h-8 w-24" /></td>
        <td className="px-2 py-2"><Input form={formId} name="expected_date" type="date" defaultValue={l.expected_date?.slice(0, 10) ?? ''} aria-label="Échéance" className="h-8 w-36" />{state?.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'text-xs text-success-text' : 'text-xs text-danger-text'}>{state.message}</p>}</td>
      </>) : (<>
        <td className="px-2 py-2 tabular-nums">{formatQty(l.qty_ordered)} {unitLabel(l.unit)}</td><td className="px-2 py-2 tabular-nums">{formatMoney(l.unit_price)}</td>
        <td className="whitespace-nowrap px-2 py-2">{l.expected_date ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${l.expected_date.slice(0, 10)}T00:00:00Z`)) : '—'}</td>
      </>)}
      <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty_received)}{l.qty_returned > 0 && <span className="block text-xs text-danger-text">− {formatQty(l.qty_returned)} retourné</span>}</td>
      <td className={`px-2 py-2 text-right tabular-nums ${open > 0 ? '' : 'text-success-text'}`}>{open > 0 ? formatQty(open) : 'Soldé'}</td>
      <td className="px-2 py-2 text-right tabular-nums">{formatMoney(l.qty_ordered * l.unit_price)}</td>
      <td className="px-4 py-2 text-right">{editable && <div className="flex justify-end gap-1"><Button type="submit" form={formId} variant="ghost" size="sm" aria-label="Enregistrer la ligne" title="Enregistrer"><Save className="h-4 w-4" /></Button>
        <RpcButton action={deleteOrderLineAction} fields={{ id: l.id }} variant="ghost" size="sm" aria-label="Supprimer la ligne" confirm="Supprimer cette ligne ?">×</RpcButton></div>}</td>
    </tr>
  )
}

export function LinesTable({ lines, editable }: { lines: OrderLine[]; editable: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[54rem] text-sm">
        <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Quantité</th><th className="px-2 py-2 font-semibold">Prix unit. (€)</th><th className="px-2 py-2 font-semibold">Échéance</th><th className="px-2 py-2 text-right font-semibold">Reçu</th><th className="px-2 py-2 text-right font-semibold">Reste</th><th className="px-2 py-2 text-right font-semibold">Montant</th><th className="w-24 px-4 py-2" /></tr></thead>
        <tbody className="divide-y divide-line">
          {lines.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-ink-soft">Aucune ligne.</td></tr>}
          {lines.map((l) => <LineEditRow key={l.id} l={l} editable={editable} />)}
        </tbody>
      </table>
    </div>
  )
}

export function AddPoLine({ poId, materials }: { poId: string; materials: { id: string; code: string; name: string; unit: string; price: number | null }[] }) {
  const [state, action] = useActionState(addOrderLineAction, null)
  const errs = state?.fieldErrors ?? {}
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form action={action} className="space-y-3 border-t border-line bg-canvas/50 p-4" noValidate>
      <input type="hidden" name="po_id" value={poId} />
      <p className="text-sm font-semibold">Ajouter une ligne</p>
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_7rem_8rem_9.5rem_auto] md:items-end">
        <FormField id="pl-mat" label="Composant *" errors={errs.material_id}><Select id="pl-mat" name="material_id" defaultValue={v('material_id')}><option value="">— Choisir —</option>{materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code}){m.price !== null ? ` — ${formatMoney(m.price)}/${unitLabel(m.unit)}` : ''}</option>)}</Select></FormField>
        <FormField id="pl-qty" label="Quantité *" errors={errs.qty_ordered}><Input id="pl-qty" name="qty_ordered" inputMode="decimal" defaultValue={v('qty_ordered')} /></FormField>
        <FormField id="pl-price" label="Prix unitaire (€)" errors={errs.unit_price}><Input id="pl-price" name="unit_price" inputMode="decimal" defaultValue={v('unit_price')} placeholder="0" /></FormField>
        <FormField id="pl-date" label="Échéance" errors={errs.expected_date}><Input id="pl-date" name="expected_date" type="date" defaultValue={v('expected_date')} /></FormField>
        <SubmitButton pendingText="Ajout…"><Plus className="h-4 w-4" /> Ajouter</SubmitButton>
      </div>
    </form>
  )
}

/** Réception : saisie des quantités reçues par ligne ; l'entrée en stock (lot FIFO au prix de la commande) est automatique. */
export function ReceiveDialog({ poId, poNo, lines, warehouses }: { poId: string; poNo: string; lines: OrderLine[]; warehouses: WarehouseWithLocations[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="command" size="sm" onClick={() => setOpen(true)}><PackageCheck className="h-4 w-4" /> Réceptionner</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Réception de ${poNo}`} className="max-w-2xl"><ReceiveForm poId={poId} lines={lines} warehouses={warehouses.filter((w) => !w.archived_at)} onCancel={() => setOpen(false)} /></Dialog>
    </>
  )
}
function ReceiveForm({ poId, lines, warehouses, onCancel }: { poId: string; lines: OrderLine[]; warehouses: WarehouseWithLocations[]; onCancel: () => void }) {
  const [state, action, pending] = useManualAction(receiveAction, null)
  const [wh, setWh] = useState(warehouses[0]?.id ?? '')
  const locs = (warehouses.find((w) => w.id === wh)?.locations ?? []).filter((l) => !l.archived_at)
  const defLoc = locs.find((l) => l.kind === 'receiving') ?? locs[0]
  const v = (k: string) => state?.values?.[k] ?? ''
  const open = lines.filter((l) => l.qty_ordered - (l.qty_received - l.qty_returned) > 0)
  return (
    <form onSubmit={action} className="space-y-3" noValidate>
      <input type="hidden" name="po_id" value={poId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField id="rc-wh" label="Entrepôt *" errors={state?.fieldErrors?.warehouse_id}><Select id="rc-wh" name="warehouse_id" value={wh} onChange={(e) => setWh(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></FormField>
        <FormField id="rc-loc" label="Emplacement *" errors={state?.fieldErrors?.location_id}><Select id="rc-loc" name="location_id" key={wh} defaultValue={v('location_id') || defLoc?.id || ''}>{locs.map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` — ${l.name}` : ''}</option>)}</Select></FormField>
        <FormField id="rc-bl" label="N° de bon de livraison" errors={state?.fieldErrors?.delivery_note}><Input id="rc-bl" name="delivery_note" maxLength={80} defaultValue={v('delivery_note')} /></FormField>
      </div>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Commandé</th><th className="px-2 py-2 text-right font-semibold">Reste</th><th className="w-32 px-3 py-2 font-semibold">Reçu maintenant</th></tr></thead>
          <tbody className="divide-y divide-line">
            {open.map((l) => { const rest = l.qty_ordered - (l.qty_received - l.qty_returned); return (
              <tr key={l.id}><td className="px-3 py-2">{l.material_name}<span className="ml-2 font-mono text-xs text-ink-faint">{l.material_code}</span></td>
                <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty_ordered)}</td><td className="px-2 py-2 text-right tabular-nums">{formatQty(rest)} {unitLabel(l.unit)}</td>
                <td className="px-3 py-2"><Input name={`qty_${l.id}`} inputMode="decimal" defaultValue={v(`qty_${l.id}`) || String(rest).replace('.', ',')} aria-label={`Quantité reçue ${l.material_name}`} className="h-8" /></td></tr>
            ) })}
          </tbody>
        </table>
      </div>
      <FormField id="rc-notes" label="Remarques"><Input id="rc-notes" name="notes" maxLength={300} defaultValue={v('notes')} placeholder="Colis abîmé, écart de métrage…" /></FormField>
      <p className="text-xs text-ink-soft">Mettez 0 (ou videz) pour une ligne non livrée. Chaque quantité crée un lot de stock au prix de la commande.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onCancel}>Annuler</Button><SubmitButton disabled={pending}>{pending ? 'Enregistrement…' : 'Enregistrer la réception'}</SubmitButton></div>
    </form>
  )
}

export function ReturnDialog({ receiptId, code, lines }: { receiptId: string; code: string; lines: { id: string; material_name: string; material_code: string; unit: string; qty: number; qty_returned: number }[] }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="command" size="sm" onClick={() => setOpen(true)}><Undo2 className="h-4 w-4" /> Retour fournisseur</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Retour sur ${code}`} className="max-w-2xl"><ReturnForm receiptId={receiptId} lines={lines} onCancel={() => setOpen(false)} /></Dialog>
    </>
  )
}
function ReturnForm({ receiptId, lines, onCancel }: { receiptId: string; lines: { id: string; material_name: string; material_code: string; unit: string; qty: number; qty_returned: number }[]; onCancel: () => void }) {
  const [state, action, pending] = useManualAction(returnAction, null)
  const v = (k: string) => state?.values?.[k] ?? ''
  return (
    <form onSubmit={action} className="space-y-3" noValidate>
      <input type="hidden" name="receipt_id" value={receiptId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-2 font-semibold">Composant</th><th className="px-2 py-2 text-right font-semibold">Reçu</th><th className="px-2 py-2 text-right font-semibold">Déjà retourné</th><th className="w-32 px-3 py-2 font-semibold">À retourner</th></tr></thead>
          <tbody className="divide-y divide-line">
            {lines.map((l) => (
              <tr key={l.id}><td className="px-3 py-2">{l.material_name}<span className="ml-2 font-mono text-xs text-ink-faint">{l.material_code}</span></td>
                <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty)} {unitLabel(l.unit)}</td><td className="px-2 py-2 text-right tabular-nums">{formatQty(l.qty_returned)}</td>
                <td className="px-3 py-2"><Input name={`qty_${l.id}`} inputMode="decimal" defaultValue={v(`qty_${l.id}`)} disabled={l.qty - l.qty_returned <= 0} placeholder="0" aria-label={`Quantité à retourner ${l.material_name}`} className="h-8" /></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <FormField id="rt-reason" label="Motif du retour *" errors={state?.fieldErrors?.reason}><Input id="rt-reason" name="reason" maxLength={300} defaultValue={v('reason')} placeholder="Défaut de teinte, non conforme à la commande…" /></FormField>
      <p className="text-xs text-ink-soft">Le stock est diminué (FIFO sur l’emplacement de réception) et la commande est rouverte pour la quantité retournée.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onCancel}>Annuler</Button><SubmitButton variant="danger" disabled={pending}>{pending ? 'Enregistrement…' : 'Enregistrer le retour'}</SubmitButton></div>
    </form>
  )
}

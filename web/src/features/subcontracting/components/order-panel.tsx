'use client'

import { useActionState, useState } from 'react'
import { CheckCircle2, Flag, PackageCheck, Send, Truck, XCircle } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { QC_STATUS, today } from '@/lib/subcontracting/options'
import { fmtDay } from '@/features/orders/status'
import { cn } from '@/lib/utils'
import { addReceiptAction, addShipmentAction, cancelOrderAction, closeOrderAction, qualityAction, sendOrderAction, stockAction } from '../actions'
import type { ReceiptRow, ShipmentRow } from '../services/subcontracting.service'

type Ctx = { status: string; qty: number; qty_shipped: number; qty_received: number; due_date: string | null; sent_on: string | null }

/** Barre d'actions de la commande : selon l'état, envoi, cancel, saisie des envois, réceptions, contrôle, stock, clôture. */
export function OrderActions({ id, o, shipments, receipts, variants, warehouses, canWrite, canQc }: {
  id: string; o: Ctx; shipments: ShipmentRow[]; receipts: ReceiptRow[]; variants: { id: string; sku: string }[]; warehouses: { id: string; name: string }[]; canWrite: boolean; canQc: boolean
}) {
  const [close, closeAction] = useActionState(closeOrderAction, null)
  const open = o.status === 'sent' || o.status === 'partially_received'
  const shippedLeft = o.qty - o.qty_shipped
  const receivableMax = o.qty_shipped - o.qty_received
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && o.status === 'draft' && (
          <ActionDialog trigger={<><Send className="h-4 w-4" /> Envoyer au sous-traitant</>} triggerVariant="primary" title="Envoyer la commande" action={sendOrderAction} hidden={{ id }} submit="Envoyer">
            {() => <div className="space-y-3"><p className="text-sm text-ink-soft">La commande passe à « Envoyée ». L’échéance de retour est obligatoire pour suivre les délais.</p>
              <FormField id="send-due" label="Retour attendu le *"><Input id="send-due" name="due_date" type="date" defaultValue={o.due_date ?? ''} /></FormField></div>}
          </ActionDialog>
        )}
        {canWrite && (o.status === 'draft' || o.status === 'sent') && o.qty_shipped === 0 && (
          <ActionDialog trigger={<><XCircle className="h-4 w-4" /> Annuler</>} triggerVariant="command" triggerClassName="text-danger-text" title="Annuler la commande" action={cancelOrderAction} hidden={{ id }} submit="Annuler la commande" submitVariant="danger">
            {(st) => <FormField id="cancel-reason" label="Motif *" errors={st?.fieldErrors?.reason}><Textarea id="cancel-reason" name="reason" rows={3} maxLength={300} /></FormField>}
          </ActionDialog>
        )}
        {canWrite && open && shippedLeft > 0 && (
          <ActionDialog trigger={<><Truck className="h-4 w-4" /> Enregistrer un envoi</>} triggerVariant="primary" title="Envoi au sous-traitant" action={addShipmentAction} hidden={{ id }} submit="Enregistrer l’envoi">
            {(st) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField id="sh-qty" label={`Quantité (reste ${shippedLeft}) *`} errors={st?.fieldErrors?.qty}><Input id="sh-qty" name="qty" inputMode="numeric" defaultValue={String(shippedLeft)} /></FormField>
                <FormField id="sh-date" label="Date d’envoi"><Input id="sh-date" name="shipped_on" type="date" defaultValue={today()} /></FormField>
                <FormField id="sh-carrier" label="Transporteur"><Input id="sh-carrier" name="carrier" maxLength={80} placeholder="DHL, coursier…" /></FormField>
                <FormField id="sh-track" label="N° de suivi"><Input id="sh-track" name="tracking" maxLength={80} /></FormField>
              </div>
            )}
          </ActionDialog>
        )}
        {canWrite && open && receivableMax > 0 && (
          <ActionDialog trigger={<><PackageCheck className="h-4 w-4" /> Enregistrer un retour</>} triggerVariant="primary" title="Réception du sous-traitant" action={addReceiptAction} hidden={{ id }} submit="Enregistrer la réception"
            description={`Au plus ${receivableMax} pièce(s) : le retour ne peut pas dépasser ce qui a été envoyé.`}>
            {(st) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField id="rc-qty" label="Quantité reçue *" errors={st?.fieldErrors?.qty}><Input id="rc-qty" name="qty" inputMode="numeric" defaultValue={String(Math.min(receivableMax, shippedLeft || receivableMax))} /></FormField>
                <FormField id="rc-date" label="Date de réception"><Input id="rc-date" name="received_on" type="date" defaultValue={today()} /></FormField>
                <div className="sm:col-span-2"><FormField id="rc-ship" label="Envoi d’origine (facultatif)"><Select id="rc-ship" name="shipment_id" defaultValue=""><option value="">— Non précisé —</option>{shipments.map((s) => <option key={s.id} value={s.id}>Envoi {s.number} · {s.qty} pièce(s) · {fmtDay(s.shipped_on)}</option>)}</Select></FormField></div>
              </div>
            )}
          </ActionDialog>
        )}
        {canWrite && o.status === 'received' && (
          <form action={closeAction}><input type="hidden" name="id" value={id} /><SubmitButton variant="command" size="sm" pendingText="Clôture…"><CheckCircle2 className="h-4 w-4" /> Clôturer la commande</SubmitButton></form>
        )}
      </div>
      {close && !close.ok && <Alert tone="error">{close.message}</Alert>}
      {receipts.some((r) => r.qc_status === 'pending') && canQc && <p className="text-xs text-warn-text">Un retour attend son contrôle qualité : il est traité dans le tableau des retours ci-dessous.</p>}
    </div>
  )
}

export function ShipmentsTable({ shipments }: { shipments: ShipmentRow[] }) {
  if (shipments.length === 0) return <p className="p-6 text-center text-sm text-ink-soft">Aucun envoi enregistré.</p>
  return (
    <table className="w-full min-w-[32rem] text-sm">
      <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Envoi</th><th className="px-2 py-2 font-semibold">Date</th><th className="px-2 py-2 text-right font-semibold">Pièces</th><th className="px-2 py-2 font-semibold">Transporteur / suivi</th></tr></thead>
      <tbody className="divide-y divide-line">{shipments.map((s) => <tr key={s.id}><td className="px-4 py-1.5 font-semibold">#{s.number}</td><td className="px-2 py-1.5">{fmtDay(s.shipped_on)}</td><td className="px-2 py-1.5 text-right tabular-nums">{s.qty}</td><td className="px-2 py-1.5 text-ink-soft">{[s.carrier, s.tracking].filter(Boolean).join(' · ') || '—'}</td></tr>)}</tbody>
    </table>
  )
}

/** Retours : contrôle qualité (accepté / rejeté) puis entrée en stock de la part acceptée. */
export function ReceiptsTable({ orderId, receipts, variants, warehouses, canQc, canStock }: {
  orderId: string; receipts: ReceiptRow[]; variants: { id: string; sku: string }[]; warehouses: { id: string; name: string }[]; canQc: boolean; canStock: boolean
}) {
  if (receipts.length === 0) return <p className="p-6 text-center text-sm text-ink-soft">Aucun retour réceptionné.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Retour</th><th className="px-2 py-2 font-semibold">Reçu le</th><th className="px-2 py-2 text-right font-semibold">Reçu</th><th className="px-2 py-2 font-semibold">Contrôle</th><th className="px-2 py-2 text-right font-semibold">Acceptées</th><th className="px-2 py-2 text-right font-semibold">Rejetées</th><th className="px-2 py-2 font-semibold">Stock</th><th className="px-2 py-2" /></tr></thead>
        <tbody className="divide-y divide-line">
          {receipts.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="px-4 py-2 font-semibold">#{r.number}</td>
              <td className="px-2 py-2">{fmtDay(r.received_on)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.qty_received}</td>
              <td className="px-2 py-2"><Badge tone={QC_STATUS[r.qc_status as keyof typeof QC_STATUS].tone}>{QC_STATUS[r.qc_status as keyof typeof QC_STATUS].label}</Badge>{r.qc_notes && <span className="mt-1 block text-xs text-ink-soft">{r.qc_notes}</span>}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.qc_status === 'pending' ? '—' : r.qty_accepted}</td>
              <td className={cn('px-2 py-2 text-right tabular-nums', r.qty_rejected > 0 && 'font-semibold text-danger-text')}>{r.qc_status === 'pending' ? '—' : r.qty_rejected}</td>
              <td className="px-2 py-2">{r.stock_posted ? <span className="text-success-text">En stock · {r.variant_sku} ({r.warehouse})</span> : r.qc_status !== 'pending' && r.qty_accepted > 0 ? <span className="text-warn-text">À faire entrer en stock</span> : <span className="text-ink-faint">—</span>}</td>
              <td className="px-2 py-2 text-right">
                <div className="flex flex-col items-end gap-1">
                  {canQc && r.qc_status === 'pending' && (
                    <ActionDialog trigger={<><Flag className="h-3.5 w-3.5" /> Contrôler</>} triggerVariant="primary" triggerSize="sm" title={`Contrôle qualité — retour #${r.number}`} action={qualityAction} hidden={{ receipt_id: r.id, order_id: orderId }} submit="Valider le contrôle"
                      description={`${r.qty_received} pièce(s) reçues. Ventilez-les en acceptées et rejetées.`}>
                      {(st) => (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <FormField id={`qa-${r.id}`} label="Acceptées *" errors={st?.fieldErrors?.accepted}><Input id={`qa-${r.id}`} name="accepted" inputMode="numeric" defaultValue={st?.values?.accepted ?? String(r.qty_received)} /></FormField>
                          <FormField id={`qr-${r.id}`} label="Rejetées *" errors={st?.fieldErrors?.rejected}><Input id={`qr-${r.id}`} name="rejected" inputMode="numeric" defaultValue={st?.values?.rejected ?? '0'} /></FormField>
                          <div className="sm:col-span-2"><FormField id={`qn-${r.id}`} label="Constats (défauts, écarts)"><Textarea id={`qn-${r.id}`} name="notes" rows={3} maxLength={500} defaultValue={st?.values?.notes} /></FormField></div>
                        </div>
                      )}
                    </ActionDialog>
                  )}
                  {canStock && r.qc_status !== 'pending' && r.qty_accepted > 0 && !r.stock_posted && (
                    <ActionDialog trigger={<><PackageCheck className="h-3.5 w-3.5" /> Entrer en stock</>} triggerVariant="primary" triggerSize="sm" title={`Entrée en stock — retour #${r.number}`} action={stockAction} hidden={{ receipt_id: r.id, order_id: orderId }} submit="Entrer en stock"
                      description={`${r.qty_accepted} pièce(s) acceptée(s) seront ajoutées au stock fini de la variante choisie.`}>
                      {(st) => (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <FormField id={`sv-${r.id}`} label="Variante *" errors={st?.fieldErrors?.variant_id}><Select id={`sv-${r.id}`} name="variant_id" defaultValue=""><option value="">— Choisir —</option>{variants.map((v) => <option key={v.id} value={v.id}>{v.sku}</option>)}</Select></FormField>
                          <FormField id={`sw-${r.id}`} label="Entrepôt *" errors={st?.fieldErrors?.warehouse_id}><Select id={`sw-${r.id}`} name="warehouse_id" defaultValue=""><option value="">— Choisir —</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></FormField>
                        </div>
                      )}
                    </ActionDialog>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}


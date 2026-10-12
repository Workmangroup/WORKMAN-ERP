'use client'

import { Trash2 } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { formatMoney } from '@/lib/bom/options'
import { COST_KINDS, today } from '@/lib/subcontracting/options'
import { fmtDay } from '@/features/orders/status'
import { addCostAction, deleteCostAction } from '../actions'
import type { CostRow, ShipmentRow } from '../services/subcontracting.service'

/** Coûts de la commande (prestation, transport, autres) : visible seulement avec subcontract.costs ou costs.read. */
export function CostsPanel({ orderId, costs, shipments, canWrite }: { orderId: string; costs: CostRow[]; shipments: ShipmentRow[]; canWrite: boolean }) {
  const total = costs.reduce((a, c) => a + c.amount, 0)
  const service = costs.filter((c) => c.kind === 'service').reduce((a, c) => a + c.amount, 0)
  const hasService = costs.some((c) => c.kind === 'service')
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">Total <strong className="tabular-nums text-ink">{formatMoney(total)}</strong>{hasService && <> · prestation {formatMoney(service)}</>}</p>
        {canWrite && (
          <ActionDialog trigger="Ajouter un coût" triggerVariant="secondary" title="Ajouter un coût" action={addCostAction} hidden={{ order_id: orderId }} submit="Ajouter">
            {(st) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField id="ck-kind" label="Type *" errors={st?.fieldErrors?.kind}><Select id="ck-kind" name="kind" defaultValue={st?.values?.kind ?? (hasService ? 'shipping' : 'service')}>{COST_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></FormField>
                <FormField id="ck-ship" label="Envoi concerné" errors={st?.fieldErrors?.shipment_id}><Select id="ck-ship" name="shipment_id" defaultValue=""><option value="">— Commande entière —</option>{shipments.map((s) => <option key={s.id} value={s.id}>Envoi {s.number} · {s.qty} pièce(s)</option>)}</Select></FormField>
                <div className="sm:col-span-2"><FormField id="ck-desc" label="Description *" errors={st?.fieldErrors?.description}><Input id="ck-desc" name="description" maxLength={200} defaultValue={st?.values?.description} placeholder="Broderie 20 pièces, transport DHL…" /></FormField></div>
                <FormField id="ck-qty" label="Quantité *" errors={st?.fieldErrors?.quantity}><Input id="ck-qty" name="quantity" inputMode="decimal" defaultValue={st?.values?.quantity ?? '1'} /></FormField>
                <FormField id="ck-unit" label="Montant unitaire HT *" errors={st?.fieldErrors?.unit_cost}><Input id="ck-unit" name="unit_cost" inputMode="decimal" defaultValue={st?.values?.unit_cost} placeholder="0,00" /></FormField>
                <FormField id="ck-date" label="Date" errors={st?.fieldErrors?.incurred_on}><Input id="ck-date" name="incurred_on" type="date" defaultValue={st?.values?.incurred_on ?? today()} /></FormField>
              </div>
            )}
          </ActionDialog>
        )}
      </div>
      {costs.length === 0 ? <p className="text-sm text-ink-soft">Aucun coût saisi.</p> : (
        <table className="w-full min-w-[30rem] text-sm">
          <tbody className="divide-y divide-line">
            {costs.map((c) => (
              <tr key={c.id}>
                <td className="py-1.5 pr-2 text-ink-soft">{fmtDay(c.incurred_on)}</td>
                <td className="py-1.5 pr-2">{COST_KINDS.find((k) => k.value === c.kind)?.label}</td>
                <td className="py-1.5 pr-2">{c.description}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-ink-soft">{c.quantity} × {formatMoney(c.unit_cost)}</td>
                <td className="py-1.5 pr-2 text-right font-medium tabular-nums">{formatMoney(c.amount)}</td>
                {canWrite && <td className="w-8 py-1.5 text-right"><form action={deleteCostAction} onSubmit={(e) => { if (!window.confirm('Supprimer ce coût ?')) e.preventDefault() }}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="order_id" value={orderId} /><Button type="submit" variant="ghost" size="sm" aria-label="Supprimer le coût"><Trash2 className="h-3.5 w-3.5 text-danger-text" /></Button></form></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

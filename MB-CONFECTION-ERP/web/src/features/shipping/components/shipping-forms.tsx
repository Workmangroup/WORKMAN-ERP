'use client'

import { FileText, PackagePlus, Plus, Printer, Truck } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { FormField } from '@/components/auth/form-field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { RpcButton } from '@/features/stock/components/rpc-button'
import {
  addShipmentLineAction, cancelShipmentAction, createShipmentAction, deliverShipmentAction, exportInvoiceAction, packShipmentAction,
  pickLineAction, shipShipmentAction, trackShipmentAction,
} from '../actions'

const INCOTERMS = ['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']

export function NewShipmentDialog({ orders, warehouses }: { orders: { id: string; code: string }[]; warehouses: { id: string; code: string; name: string }[] }) {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Préparer une expédition</>} triggerVariant="primary" title="Préparer une expédition" action={createShipmentAction} submit="Préparer" wide
      description="La commande doit être confirmée. Les lignes s’ajoutent ensuite, dans la limite de ce qui reste à expédier.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="ns-order" label="Commande confirmée *" errors={st?.fieldErrors?.order_id}>
            <Select id="ns-order" name="order_id" defaultValue=""><option value="">— Choisir —</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.code}</option>)}</Select>
          </FormField>
          <FormField id="ns-wh" label="Entrepôt de départ *" errors={st?.fieldErrors?.warehouse_id}>
            <Select id="ns-wh" name="warehouse_id" defaultValue=""><option value="">— Choisir —</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select>
          </FormField>
          <FormField id="ns-inc" label="Incoterm (export)" errors={st?.fieldErrors?.incoterm}>
            <Select id="ns-inc" name="incoterm" defaultValue=""><option value="">— Aucun —</option>{INCOTERMS.map((i) => <option key={i} value={i}>{i}</option>)}</Select>
          </FormField>
          <FormField id="ns-country" label="Pays de destination" hint="Code ISO, ex. FR" errors={st?.fieldErrors?.country}><Input id="ns-country" name="country" maxLength={2} /></FormField>
          <FormField id="ns-cur" label="Devise" errors={st?.fieldErrors?.currency}><Input id="ns-cur" name="currency" defaultValue="EUR" maxLength={3} /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function AddLineDialog({ shipmentId, variants }: { shipmentId: string; variants: { id: string; label: string; price: number }[] }) {
  return (
    <ActionDialog trigger={<><PackagePlus className="h-4 w-4" /> Ajouter une ligne</>} triggerVariant="secondary" title="Ajouter une ligne" action={addShipmentLineAction} hidden={{ shipment_id: shipmentId }} submit="Ajouter"
      description="Le prix unitaire est repris de la variante et figé sur la ligne. La quantité ne peut pas dépasser ce qui reste sur la commande pour l’article.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField id={`al-v-${shipmentId}`} label="Variante (taille × couleur) *" errors={st?.fieldErrors?.variant_id}>
            <Select id={`al-v-${shipmentId}`} name="variant_id" defaultValue=""><option value="">— Choisir —</option>{variants.map((v) => <option key={v.id} value={v.id}>{v.label} · {v.price} €</option>)}</Select>
          </FormField></div>
          <FormField id={`al-q-${shipmentId}`} label="Quantité *" errors={st?.fieldErrors?.qty}><Input id={`al-q-${shipmentId}`} name="qty" inputMode="numeric" /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function PickDialog({ lineId, remaining }: { lineId: string; remaining: number }) {
  return (
    <ActionDialog trigger="Prélever" triggerVariant="primary" triggerSize="sm" title="Prélever" action={pickLineAction} hidden={{ line_id: lineId }} submit="Réserver le stock"
      description={`Reste à prélever : ${remaining} pièce(s). Le stock disponible (en stock − réservé) est vérifié.`}>
      {(st) => <FormField id={`pk-${lineId}`} label="Quantité prélevée *" errors={st?.fieldErrors?.qty}><Input id={`pk-${lineId}`} name="qty" inputMode="numeric" defaultValue={String(remaining)} /></FormField>}
    </ActionDialog>
  )
}

export function PackDialog({ shipmentId }: { shipmentId: string }) {
  return (
    <ActionDialog trigger={<><PackagePlus className="h-4 w-4" /> Colisage</>} triggerVariant="secondary" title="Colisage" action={packShipmentAction} hidden={{ shipment_id: shipmentId }} submit="Enregistrer le colisage">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField id={`pa-n-${shipmentId}`} label="Colis *" errors={st?.fieldErrors?.packages}><Input id={`pa-n-${shipmentId}`} name="packages" inputMode="numeric" /></FormField>
          <FormField id={`pa-g-${shipmentId}`} label="Poids brut (kg)" errors={st?.fieldErrors?.gross}><Input id={`pa-g-${shipmentId}`} name="gross" inputMode="decimal" /></FormField>
          <FormField id={`pa-t-${shipmentId}`} label="Poids net (kg)" errors={st?.fieldErrors?.net}><Input id={`pa-t-${shipmentId}`} name="net" inputMode="decimal" /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function ShipDialog({ shipmentId }: { shipmentId: string }) {
  return (
    <ActionDialog trigger={<><Truck className="h-4 w-4" /> Expédier</>} triggerVariant="primary" title="Expédier" action={shipShipmentAction} hidden={{ shipment_id: shipmentId }} submit="Expédier"
      description="L’expédition sort le stock et délivre le bon de livraison. Cette étape est irréversible.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id={`sh-c-${shipmentId}`} label="Transporteur" errors={st?.fieldErrors?.carrier}><Input id={`sh-c-${shipmentId}`} name="carrier" maxLength={80} /></FormField>
          <FormField id={`sh-t-${shipmentId}`} label="N° de suivi" errors={st?.fieldErrors?.tracking}><Input id={`sh-t-${shipmentId}`} name="tracking" maxLength={80} /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function DeliverButton({ shipmentId }: { shipmentId: string }) {
  return <RpcButton action={deliverShipmentAction} fields={{ shipment_id: shipmentId }} variant="primary" size="sm" confirm="Confirmer la livraison au client ?">Confirmer la livraison</RpcButton>
}

export function ExportInvoiceButton({ shipmentId }: { shipmentId: string }) {
  return <RpcButton action={exportInvoiceAction} fields={{ shipment_id: shipmentId }} variant="secondary" size="sm" confirm="Émettre la facture export pour cette expédition ?"><FileText className="h-4 w-4" /> Émettre la facture export</RpcButton>
}

export function CancelShipmentDialog({ shipmentId }: { shipmentId: string }) {
  return (
    <ActionDialog trigger="Annuler l’expédition" triggerVariant="ghost" triggerSize="sm" title="Annuler l’expédition" action={cancelShipmentAction} hidden={{ shipment_id: shipmentId }} submit="Annuler l’expédition"
      description="Les quantités réservées sont libérées. Une expédition déjà expédiée ne peut plus être annulée.">
      {(st) => <FormField id={`cs-${shipmentId}`} label="Motif *" errors={st?.fieldErrors?.reason}><Input id={`cs-${shipmentId}`} name="reason" maxLength={300} /></FormField>}
    </ActionDialog>
  )
}

export function TrackDialog({ shipmentId }: { shipmentId: string }) {
  return (
    <ActionDialog trigger="Ajouter un suivi" triggerVariant="secondary" triggerSize="sm" title="Évènement de transport" action={trackShipmentAction} hidden={{ shipment_id: shipmentId }} submit="Enregistrer">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id={`tr-e-${shipmentId}`} label="Évènement *" errors={st?.fieldErrors?.event}><Select id={`tr-e-${shipmentId}`} name="event" defaultValue="in_transit"><option value="in_transit">En transit</option><option value="exception">Incident</option></Select></FormField>
          <FormField id={`tr-l-${shipmentId}`} label="Lieu" errors={st?.fieldErrors?.location}><Input id={`tr-l-${shipmentId}`} name="location" maxLength={120} /></FormField>
          <div className="sm:col-span-2"><FormField id={`tr-n-${shipmentId}`} label="Note" errors={st?.fieldErrors?.note}><Input id={`tr-n-${shipmentId}`} name="note" maxLength={300} /></FormField></div>
        </div>
      )}
    </ActionDialog>
  )
}

export function PrintButton() {
  return (
    <Button type="button" variant="command" size="sm" onClick={() => window.print()}><Printer className="h-4 w-4" /> Imprimer</Button>
  )
}

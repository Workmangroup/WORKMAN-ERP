'use client'

import { Check, Plus, Undo2, X } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { FormField } from '@/components/auth/form-field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { REQUEST_KINDS } from '@/lib/stock/movement-kinds'
import { cancelMovementAction, cancelRequestAction, approveRequestAction, createMovementRequestAction, rejectRequestAction } from '../requests-actions'

type Option = { id: string; code: string; name: string; unit?: string }
type Loc = { id: string; warehouse_id: string; code: string; name: string | null }

/** Nouveau mouvement : publié si la règle le permet, sinon envoyé à la validation. */
export function NewRequestDialog({ materials, warehouses, locations }: { materials: Option[]; warehouses: Option[]; locations: Loc[] }) {
  const locLabel = (l: Loc) => `${l.code}${l.name ? ` — ${l.name}` : ''} (${warehouses.find((w) => w.id === l.warehouse_id)?.code ?? '?'})`
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouveau mouvement</>} triggerVariant="primary" title="Nouveau mouvement de stock" action={createMovementRequestAction}
      submit="Enregistrer le mouvement" wide
      description="Les mouvements au-dessus du seuil ou de type sensible (ajustement, rebut, retour fournisseur) sont envoyés à la validation.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="rq-kind" label="Type *" errors={st?.fieldErrors?.kind}>
            <Select id="rq-kind" name="kind" defaultValue="entree_achat">{REQUEST_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}{k.reason ? ' (motif obligatoire)' : ''}</option>)}</Select>
          </FormField>
          <FormField id="rq-material" label="Composant *" errors={st?.fieldErrors?.material_id}>
            <Select id="rq-material" name="material_id" defaultValue=""><option value="">— Choisir —</option>{materials.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}</Select>
          </FormField>
          <FormField id="rq-qty" label="Quantité *" hint="Négative seulement pour un ajustement" errors={st?.fieldErrors?.qty}>
            <Input id="rq-qty" name="qty" inputMode="decimal" placeholder="0" />
          </FormField>
          <FormField id="rq-cost" label="Coût unitaire" hint="Sert à la valeur et aux seuils de validation" errors={st?.fieldErrors?.unit_cost}>
            <Input id="rq-cost" name="unit_cost" inputMode="decimal" placeholder="0,00" />
          </FormField>
          <FormField id="rq-wh" label="Entrepôt *" errors={st?.fieldErrors?.warehouse_id}>
            <Select id="rq-wh" name="warehouse_id" defaultValue=""><option value="">— Choisir —</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select>
          </FormField>
          <FormField id="rq-loc" label="Emplacement source" errors={st?.fieldErrors?.location_id}>
            <Select id="rq-loc" name="location_id" defaultValue=""><option value="">— Aucun —</option>{locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}</Select>
          </FormField>
          <FormField id="rq-to-wh" label="Entrepôt de destination (transfert)" errors={st?.fieldErrors?.to_warehouse_id}>
            <Select id="rq-to-wh" name="to_warehouse_id" defaultValue=""><option value="">— Aucun —</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select>
          </FormField>
          <FormField id="rq-to-loc" label="Emplacement de destination (transfert)" errors={st?.fieldErrors?.to_location_id}>
            <Select id="rq-to-loc" name="to_location_id" defaultValue=""><option value="">— Aucun —</option>{locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}</Select>
          </FormField>
          <FormField id="rq-ref" label="Référence" hint="OF, bon de livraison, commande…" errors={st?.fieldErrors?.reference}>
            <Input id="rq-ref" name="reference" maxLength={120} />
          </FormField>
          <FormField id="rq-reason" label="Motif" hint="Obligatoire pour ajustement, rebut et retour fournisseur" errors={st?.fieldErrors?.reason}>
            <Input id="rq-reason" name="reason" maxLength={300} />
          </FormField>
        </div>
      )}
    </ActionDialog>
  )
}

/** Actions sur une demande en attente : validation, refus, annulation. Les droits et l'auto-validation sont contrôlés en base. */
export function RequestActions({ id, status, requestedByMe, canApprove, canApproveHigh, awaitingLevel2 }: {
  id: string; status: string; requestedByMe: boolean; canApprove: boolean; canApproveHigh: boolean; awaitingLevel2: boolean
}) {
  if (status !== 'pending') return null
  const mayValidate = !requestedByMe && (awaitingLevel2 ? canApproveHigh : canApprove)
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {mayValidate && (
        <RpcButton action={approveRequestAction} fields={{ request_id: id }} variant="primary" size="sm"><Check className="h-4 w-4" /> {awaitingLevel2 ? 'Valider (niveau 2)' : 'Valider'}</RpcButton>
      )}
      {mayValidate && (
        <ActionDialog trigger={<><X className="h-4 w-4" /> Refuser</>} triggerVariant="secondary" title="Refuser la demande" action={rejectRequestAction} hidden={{ request_id: id }} submit="Refuser" submitVariant="danger"
          description="Le motif est conservé dans la traçabilité.">
          {(st) => (
            <FormField id={`rj-${id}`} label="Motif du refus *" errors={st?.fieldErrors?.reason}>
              <Input id={`rj-${id}`} name="reason" maxLength={300} />
            </FormField>
          )}
        </ActionDialog>
      )}
      {(requestedByMe || canApproveHigh) && (
        <RpcButton action={cancelRequestAction} fields={{ request_id: id }} variant="ghost" size="sm" confirm="Annuler cette demande ?"><Undo2 className="h-4 w-4" /> Retirer</RpcButton>
      )}
    </div>
  )
}

/** Annulation contrôlée d'un mouvement posté : crée une réversion soumise à validation. */
export function CancelMovementDialog({ movementId, number }: { movementId: string; number: string }) {
  return (
    <ActionDialog trigger={<><Undo2 className="h-4 w-4" /> Annuler</>} triggerVariant="secondary" triggerSize="sm" title={`Annuler le mouvement ${number}`} action={cancelMovementAction}
      hidden={{ movement_id: movementId }} submit="Demander l’annulation"
      description="Un mouvement annulé n’est pas effacé : une réversion est ajoutée au journal, après validation si la règle l’exige.">
      {(st) => (
        <FormField id={`cm-${movementId}`} label="Motif de l’annulation *" errors={st?.fieldErrors?.reason}>
          <Input id={`cm-${movementId}`} name="reason" maxLength={300} />
        </FormField>
      )}
    </ActionDialog>
  )
}

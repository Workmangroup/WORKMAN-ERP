'use client'

import { Plus, RefreshCw, Send } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { FormField } from '@/components/auth/form-field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { RpcButton } from '@/features/stock/components/rpc-button'
import {
  cashMovementAction, createCashAccountAction, createSupplierInvoiceAction, disputeInvoiceAction, generateRemindersAction,
  markReminderSentAction, recordReceiptAction, recordSupplierPaymentAction, resolveInvoiceAction,
} from '../actions'

const METHODS = [['transfer', 'Virement'], ['cheque', 'Chèque'], ['lc', 'Lettre de change'], ['cash', 'Espèces'], ['card', 'Carte'], ['other', 'Autre']]

const today = () => new Date().toISOString().slice(0, 10)

export function ReceiptDialog({ clients }: { clients: { id: string; name: string }[] }) {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Encaisser un client</>} triggerVariant="primary" title="Encaissement client" action={recordReceiptAction} submit="Enregistrer l’encaissement"
      description="Le montant est affecté aux factures les plus anciennes. Il ne peut pas dépasser le solde ouvert du client.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField id="rc-c" label="Client *" errors={st?.fieldErrors?.client_id}>
            <Select id="rc-c" name="client_id" defaultValue=""><option value="">— Choisir —</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          </FormField></div>
          <FormField id="rc-a" label="Montant *" errors={st?.fieldErrors?.amount}><Input id="rc-a" name="amount" inputMode="decimal" /></FormField>
          <FormField id="rc-d" label="Date *" errors={st?.fieldErrors?.paid_on}><Input id="rc-d" name="paid_on" type="date" defaultValue={today()} /></FormField>
          <FormField id="rc-m" label="Mode" errors={st?.fieldErrors?.method}><Select id="rc-m" name="method" defaultValue="transfer">{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></FormField>
          <FormField id="rc-r" label="Référence" errors={st?.fieldErrors?.reference}><Input id="rc-r" name="reference" maxLength={120} /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function SupplierPaymentDialog({ suppliers }: { suppliers: { id: string; name: string }[] }) {
  return (
    <ActionDialog trigger={<><Send className="h-4 w-4" /> Régler un fournisseur</>} triggerVariant="primary" title="Règlement fournisseur" action={recordSupplierPaymentAction} submit="Enregistrer le règlement"
      description="Le règlement est affecté aux factures échues les plus anciennes. Les factures en litige ne sont pas réglables. Pas d’avance.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField id="rs-s" label="Fournisseur *" errors={st?.fieldErrors?.supplier_id}>
            <Select id="rs-s" name="supplier_id" defaultValue=""><option value="">— Choisir —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </FormField></div>
          <FormField id="rs-a" label="Montant *" errors={st?.fieldErrors?.amount}><Input id="rs-a" name="amount" inputMode="decimal" /></FormField>
          <FormField id="rs-d" label="Date *" errors={st?.fieldErrors?.paid_on}><Input id="rs-d" name="paid_on" type="date" defaultValue={today()} /></FormField>
          <FormField id="rs-m" label="Mode" errors={st?.fieldErrors?.method}><Select id="rs-m" name="method" defaultValue="transfer">{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></FormField>
          <FormField id="rs-r" label="Référence" errors={st?.fieldErrors?.reference}><Input id="rs-r" name="reference" maxLength={120} /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function SupplierInvoiceDialog({ suppliers }: { suppliers: { id: string; name: string }[] }) {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Facture fournisseur</>} triggerVariant="secondary" title="Facture fournisseur" action={createSupplierInvoiceAction} submit="Enregistrer la facture" wide
      description="La référence fournisseur est unique par fournisseur.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField id="si-s" label="Fournisseur *" errors={st?.fieldErrors?.supplier_id}>
            <Select id="si-s" name="supplier_id" defaultValue=""><option value="">— Choisir —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </FormField></div>
          <FormField id="si-r" label="N° de facture fournisseur *" errors={st?.fieldErrors?.supplier_ref}><Input id="si-r" name="supplier_ref" maxLength={60} /></FormField>
          <FormField id="si-t" label="Montant TTC *" errors={st?.fieldErrors?.total}><Input id="si-t" name="total" inputMode="decimal" /></FormField>
          <FormField id="si-d" label="Date de facture *" errors={st?.fieldErrors?.invoice_date}><Input id="si-d" name="invoice_date" type="date" defaultValue={today()} /></FormField>
          <FormField id="si-e" label="Échéance *" errors={st?.fieldErrors?.due_date}><Input id="si-e" name="due_date" type="date" /></FormField>
          <FormField id="si-c" label="Devise" errors={st?.fieldErrors?.currency}><Input id="si-c" name="currency" defaultValue="EUR" maxLength={3} /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function DisputeDialog({ invoiceId }: { invoiceId: string }) {
  return (
    <ActionDialog trigger="Mettre en litige" triggerVariant="ghost" triggerSize="sm" title="Mettre la facture en litige" action={disputeInvoiceAction} hidden={{ invoice_id: invoiceId }} submit="Mettre en litige"
      description="Une facture en litige n’est pas réglable tant qu’elle n’est pas résolue.">
      {(st) => <FormField id={`dp-${invoiceId}`} label="Motif *" errors={st?.fieldErrors?.reason}><Input id={`dp-${invoiceId}`} name="reason" maxLength={300} /></FormField>}
    </ActionDialog>
  )
}

export function ResolveButton({ invoiceId }: { invoiceId: string }) {
  return <RpcButton action={resolveInvoiceAction} fields={{ invoice_id: invoiceId }} variant="secondary" size="sm" confirm="Résoudre le litige ? La facture redevient réglable.">Résoudre le litige</RpcButton>
}

export function GenerateRemindersButton() {
  return <RpcButton action={generateRemindersAction} fields={{}} variant="primary" size="sm"><RefreshCw className="h-4 w-4" /> Générer les relances</RpcButton>
}

export function MarkSentButton({ reminderId }: { reminderId: string }) {
  return <RpcButton action={markReminderSentAction} fields={{ reminder_id: reminderId }} variant="secondary" size="sm">Marquer envoyée</RpcButton>
}

export function CashAccountDialog() {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Compte de trésorerie</>} triggerVariant="secondary" title="Compte de trésorerie" action={createCashAccountAction} submit="Créer le compte"
      description="Le solde d’ouverture est retenu à la date d’ouverture ; les mouvements antérieurs ne sont pas acceptés.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField id="ca-n" label="Nom *" errors={st?.fieldErrors?.name}><Input id="ca-n" name="name" maxLength={80} /></FormField>
          <FormField id="ca-o" label="Solde d’ouverture" errors={st?.fieldErrors?.opening}><Input id="ca-o" name="opening" defaultValue="0" inputMode="decimal" /></FormField>
          <FormField id="ca-d" label="Date d’ouverture *" errors={st?.fieldErrors?.opening_date}><Input id="ca-d" name="opening_date" type="date" defaultValue={today()} /></FormField>
        </div>
      )}
    </ActionDialog>
  )
}

export function CashMovementDialog({ accounts }: { accounts: { id: string; name: string }[] }) {
  return (
    <ActionDialog trigger={<><Plus className="h-4 w-4" /> Mouvement de trésorerie</>} triggerVariant="secondary" title="Mouvement de trésorerie" action={cashMovementAction} submit="Enregistrer" wide
      description="Frais bancaires, virements internes, autres flux hors clients et fournisseurs. Un mouvement ne se modifie pas.">
      {(st) => (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="cm-a" label="Compte *" errors={st?.fieldErrors?.account_id}>
            <Select id="cm-a" name="account_id" defaultValue=""><option value="">— Choisir —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
          </FormField>
          <FormField id="cm-s" label="Sens *" errors={st?.fieldErrors?.direction}><Select id="cm-s" name="direction" defaultValue="out"><option value="in">Entrée</option><option value="out">Sortie</option></Select></FormField>
          <FormField id="cm-m" label="Montant *" errors={st?.fieldErrors?.amount}><Input id="cm-m" name="amount" inputMode="decimal" /></FormField>
          <FormField id="cm-d" label="Date *" errors={st?.fieldErrors?.moved_on}><Input id="cm-d" name="moved_on" type="date" defaultValue={today()} /></FormField>
          <div className="sm:col-span-2"><FormField id="cm-l" label="Libellé *" errors={st?.fieldErrors?.label}><Input id="cm-l" name="label" maxLength={160} /></FormField></div>
        </div>
      )}
    </ActionDialog>
  )
}

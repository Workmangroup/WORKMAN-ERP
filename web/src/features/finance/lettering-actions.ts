'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Lettrage, litiges et soldes des tiers : règles dans les fonctions SQL (0086). Affectations saisies « id:montant ; id:montant ». */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant pour cette action.'],
  ['SOD_SELF_APPROVAL', 'Action refusée : la résolution doit être faite par une autre personne que l’ouvreur.'],
  ['LETTERING_UNBALANCED', 'La somme des affectations doit être égale au montant du règlement.'],
  ['LETTERING_OVERPAYMENT', 'Une affectation dépasse le solde de la pièce.'],
  ['LETTERING_CURRENCY_MISMATCH', 'Un même règlement ne peut couvrir que des pièces d’une seule devise.'],
  ['LETTERING_TIER_MISMATCH', 'Une pièce n’appartient pas à ce tiers.'],
  ['LETTERING_DUPLICATE_LINE', 'La même pièce apparaît deux fois dans les affectations.'],
  ['LETTERING_EMPTY', 'Indiquer au moins une affectation.'],
  ['LETTERING_BAD_STATUS', 'Pièce non lettrable dans son état actuel (soldée, litigieuse ou annulée).'],
  ['LETTERING_FX_MISSING', 'Pièce en devise sans taux figé : lettrage refusé.'],
  ['LETTERING_NOT_FOUND', 'Tiers ou pièce introuvable.'],
  ['INVOICE_OVERPAYMENT', 'Une affectation dépasse le solde de la facture.'],
  ['FX_RATE_MISSING', 'Taux de change absent à la date du règlement : le règlement ne peut pas être comptabilisé.'],
  ['DISPUTE_ALREADY_OPEN', 'Un litige est déjà ouvert sur cette pièce.'],
  ['DISPUTE_BAD_AMOUNT', 'Montant ou motif de litige invalide (montant au plus égal au solde ; motif de 5 caractères min.).'],
  ['DISPUTE_BAD_STATUS', 'Litige déjà résolu : modification refusée.'],
  ['FINANCE_BAD_STATUS', 'Pièce fournisseur non litigable dans son état actuel.'],
  ['FINANCE_REASON_REQUIRED', 'Motif de litige d’au moins 5 caractères obligatoire.'],
  ['duplicate key', 'Un litige est déjà ouvert sur cette pièce.'],
]

async function run(fn: string, args: Record<string, unknown>, okMessage: string): Promise<FormState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Action impossible.' }
  }
  revalidatePath('/finance/lettrage')
  return { ok: true, message: okMessage }
}

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const method = z.enum(['transfer', 'cheque', 'lc', 'cash', 'card', 'other']).catch('transfer')

/** « uuid:montant ; uuid:montant » → tableau d'affectations ; null si la saisie est invalide. */
function parseAllocations(raw: FormDataEntryValue | null, key: 'invoice_id' | 'supplier_invoice_id') {
  const parts = String(raw ?? '').split(';').map((x) => x.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const out: Record<string, unknown>[] = []
  for (const part of parts) {
    const [id, amount] = part.split(':').map((x) => x.trim())
    if (!uuid.safeParse(id).success || !z.coerce.number().positive().safeParse(amount).success) return null
    out.push({ [key]: id, amount: Number(amount) })
  }
  return out
}

export async function clientLetteringAction(_p: FormState, fd: FormData): Promise<FormState> {
  const client = uuid.safeParse(fd.get('client'))
  const amount = z.coerce.number().positive().safeParse(fd.get('amount'))
  const paidOn = date.safeParse(fd.get('paid_on'))
  const allocations = parseAllocations(fd.get('allocations'), 'invoice_id')
  if (!client.success || !amount.success || !paidOn.success || !allocations) {
    return { ok: false, message: 'Tiers, montant, date et affectations « id:montant ; id:montant » obligatoires.' }
  }
  return run('client_lettering_apply', {
    p_client: client.data, p_amount: amount.data, p_paid_on: paidOn.data, p_method: method.parse(fd.get('method')),
    p_reference: String(fd.get('reference') ?? '') || null, p_allocations: allocations,
  }, 'Règlement lettré et affecté aux pièces.')
}

export async function supplierLetteringAction(_p: FormState, fd: FormData): Promise<FormState> {
  const supplier = uuid.safeParse(fd.get('supplier'))
  const amount = z.coerce.number().positive().safeParse(fd.get('amount'))
  const paidOn = date.safeParse(fd.get('paid_on'))
  const allocations = parseAllocations(fd.get('allocations'), 'supplier_invoice_id')
  if (!supplier.success || !amount.success || !paidOn.success || !allocations) {
    return { ok: false, message: 'Fournisseur, montant, date et affectations « id:montant ; id:montant » obligatoires.' }
  }
  return run('supplier_lettering_apply', {
    p_supplier: supplier.data, p_amount: amount.data, p_paid_on: paidOn.data, p_method: method.parse(fd.get('method')),
    p_reference: String(fd.get('reference') ?? '') || null, p_allocations: allocations,
  }, 'Règlement fournisseur lettré et affecté.')
}

export async function clientDisputeOpenAction(_p: FormState, fd: FormData): Promise<FormState> {
  const invoice = uuid.safeParse(fd.get('invoice'))
  const amount = z.coerce.number().positive().safeParse(fd.get('amount'))
  const reason = z.string().trim().min(5).max(300).safeParse(fd.get('reason'))
  if (!invoice.success || !amount.success || !reason.success) return { ok: false, message: 'Pièce, montant et motif obligatoires.' }
  return run('client_dispute_open', { p_invoice: invoice.data, p_amount: amount.data, p_reason: reason.data }, 'Litige ouvert : le montant contesté sort de l’exigible.')
}

export async function clientDisputeResolveAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const resolution = z.string().trim().min(5).max(300).safeParse(fd.get('resolution'))
  if (!id.success || !resolution.success) return { ok: false, message: 'Résolution d’au moins 5 caractères obligatoire.' }
  return run('client_dispute_resolve', { p_dispute: id.data, p_resolution: resolution.data }, 'Litige résolu.')
}

export async function supplierDisputeAction(_p: FormState, fd: FormData): Promise<FormState> {
  const invoice = uuid.safeParse(fd.get('invoice'))
  const reason = z.string().trim().min(5).max(300).safeParse(fd.get('reason'))
  if (!invoice.success || !reason.success) return { ok: false, message: 'Facture fournisseur et motif obligatoires.' }
  return run('supplier_invoice_dispute', { p_invoice: invoice.data, p_reason: reason.data }, 'Facture fournisseur contestée.')
}

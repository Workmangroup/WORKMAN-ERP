'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Banques : comptes, relevés, rapprochements, exceptions, coordonnées fournisseur, lot de transmission (0087). Aucune transmission réelle. */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant pour cette action.'],
  ['SOD_SELF_APPROVAL', 'Action refusée : elle doit être faite par une autre personne que l’auteur.'],
  ['BANK_STATEMENT_DUPLICATE', 'Relevé déjà importé (même référence ou même contenu) : import bloqué.'],
  ['BANK_LINE_DUPLICATE', 'Une ligne du relevé existe déjà pour ce compte : import bloqué.'],
  ['BANK_BALANCE_MISMATCH', 'Solde d’ouverture + lignes ≠ solde de clôture : import refusé.'],
  ['BANK_LINE_OUT_OF_PERIOD', 'Une ligne est hors de la période du relevé.'],
  ['BANK_CURRENCY_MISMATCH', 'Compte en devise différente de la devise de base : non rapprochable dans cette version.'],
  ['BANK_TARGET_MISMATCH', 'Montant ou sens différent du règlement choisi.'],
  ['BANK_TARGET_ALREADY_MATCHED', 'Ce règlement est déjà rapproché à une autre ligne.'],
  ['BANK_BAD_STATUS', 'Ligne ou élément non modifiable dans son état actuel.'],
  ['BANK_REASON_REQUIRED', 'Motif d’au moins 5 caractères obligatoire.'],
  ['BANK_IBAN_INVALID', 'IBAN invalide.'],
  ['BANK_ORDER_NOT_APPROVED', 'Ordre non approuvé : transmission refusée.'],
  ['BANK_DETAIL_NOT_VALIDATED', 'Coordonnées bancaires du fournisseur non validées.'],
  ['BANK_ALREADY_TRANSMITTED', 'Ordre déjà transmis.'],
  ['BANK_ACK_REQUIRED', 'Référence d’accusé bancaire obligatoire.'],
  ['duplicate key', 'Valeur déjà utilisée (nom de compte ou référence d’accusé).'],
]

async function run(fn: string, args: Record<string, unknown>, okMessage: string): Promise<FormState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Action impossible.' }
  }
  revalidatePath('/finance/banque')
  return { ok: true, message: okMessage }
}

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export async function bankAccountCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const name = z.string().trim().min(2).max(80).safeParse(fd.get('name'))
  const bank = z.string().trim().min(2).max(80).safeParse(fd.get('bank_label'))
  const cur = z.string().regex(/^[A-Z]{3}$/).safeParse(String(fd.get('currency') ?? '').toUpperCase())
  const last4 = z.string().regex(/^[0-9A-Za-z]{4}$/).safeParse(fd.get('last4'))
  if (!name.success || !bank.success || !cur.success || !last4.success) return { ok: false, message: 'Nom, banque, devise (ISO) et 4 derniers caractères obligatoires.' }
  return run('bank_account_create', { p_name: name.data, p_bank_label: bank.data, p_currency: cur.data, p_last4: last4.data }, 'Compte bancaire créé.')
}

/** Relevé au format canonique interne : JSON [{value_date, amount, label, bank_ref}]. Le format des banques n'est pas encore confirmé. */
export async function bankStatementImportAction(_p: FormState, fd: FormData): Promise<FormState> {
  const account = uuid.safeParse(fd.get('account'))
  const ref = z.string().trim().min(1).max(80).safeParse(fd.get('statement_ref'))
  const from = date.safeParse(fd.get('period_from'))
  const to = date.safeParse(fd.get('period_to'))
  const opening = z.coerce.number().safeParse(fd.get('opening'))
  const closing = z.coerce.number().safeParse(fd.get('closing'))
  let lines: unknown
  try { lines = JSON.parse(String(fd.get('lines') ?? '')) } catch { return { ok: false, message: 'Lignes : JSON invalide.' } }
  if (!account.success || !ref.success || !from.success || !to.success || !opening.success || !closing.success || !Array.isArray(lines)) {
    return { ok: false, message: 'Compte, référence, période, soldes et lignes (JSON) obligatoires.' }
  }
  return run('bank_statement_import', {
    p_account: account.data, p_ref: ref.data, p_from: from.data, p_to: to.data, p_opening: opening.data, p_closing: closing.data, p_lines: lines,
  }, 'Relevé importé (une seule fois).')
}

export async function bankMatchConfirmAction(_p: FormState, fd: FormData): Promise<FormState> {
  const line = uuid.safeParse(fd.get('line')); const target = uuid.safeParse(fd.get('target'))
  const kind = z.enum(['supplier_payment', 'client_payment']).safeParse(fd.get('kind'))
  if (!line.success || !target.success || !kind.success) return { ok: false, message: 'Ligne, règlement et type obligatoires.' }
  return run('bank_match_confirm', { p_line: line.data, p_kind: kind.data, p_target: target.data }, 'Rapprochement confirmé.')
}

export async function bankExceptionRaiseAction(_p: FormState, fd: FormData): Promise<FormState> {
  const line = uuid.safeParse(fd.get('line'))
  const code = z.enum(['no_match', 'amount_mismatch', 'duplicate_candidate', 'unknown_counterparty', 'other']).safeParse(fd.get('reason_code'))
  const note = z.string().trim().min(5).max(300).safeParse(fd.get('note'))
  if (!line.success || !code.success || !note.success) return { ok: false, message: 'Ligne, motif (code) et note obligatoires.' }
  return run('bank_exception_raise', { p_line: line.data, p_reason_code: code.data, p_note: note.data }, 'Exception ouverte.')
}

export async function bankExceptionCloseAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const res = z.string().trim().min(5).max(300).safeParse(fd.get('resolution'))
  if (!id.success || !res.success) return { ok: false, message: 'Résolution d’au moins 5 caractères obligatoire.' }
  return run('bank_exception_close', { p_exception: id.data, p_resolution: res.data }, 'Exception clôturée par une autre personne.')
}

export async function supplierBankDetailSetAction(_p: FormState, fd: FormData): Promise<FormState> {
  const supplier = uuid.safeParse(fd.get('supplier'))
  const label = z.string().trim().min(2).max(80).safeParse(fd.get('bank_label'))
  const iban = z.string().min(15).max(40).safeParse(fd.get('iban'))
  if (!supplier.success || !label.success || !iban.success) return { ok: false, message: 'Fournisseur, banque et IBAN obligatoires.' }
  return run('supplier_bank_detail_set', { p_supplier: supplier.data, p_bank_label: label.data, p_iban: iban.data },
    'Coordonnées enregistrées : à valider par une autre personne.')
}

export async function supplierBankDetailValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Coordonnée invalide.' }
  const validate = fd.get('validate') === 'true'
  return run('supplier_bank_detail_validate', { p_detail: id.data, p_validate: validate }, validate ? 'Coordonnées validées.' : 'Coordonnées rejetées.')
}

export async function paymentTransmissionCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const ids = String(fd.get('orders') ?? '').split(/[\s,;]+/).filter(Boolean)
  if (ids.length === 0 || !ids.every((x) => uuid.safeParse(x).success)) return { ok: false, message: 'Identifiants d’ordres (séparés par des virgules) obligatoires.' }
  return run('payment_transmission_create', { p_orders: ids }, 'Lot constitué (transmis en interne, aucun envoi à la banque).')
}

export async function paymentTransmissionAcknowledgeAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const ref = z.string().trim().min(3).max(80).safeParse(fd.get('bank_ref'))
  if (!id.success || !ref.success) return { ok: false, message: 'Lot et référence d’accusé obligatoires.' }
  return run('payment_transmission_acknowledge', { p_transmission: id.data, p_bank_ref: ref.data }, 'Accusé enregistré : lot accepté (pas encore exécuté).')
}

'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** TVA et retenues : toutes les règles (dates d'effet, validation à deux, verrouillage, dépôt) sont dans les fonctions SQL (0085). */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant pour cette action.'],
  ['SOD_SELF_APPROVAL', 'Action refusée : elle doit être faite par une autre personne que l’auteur.'],
  ['VAT_DECLARATION_LOCKED', 'Période verrouillée : une déclaration est déjà validée, exportée ou déposée.'],
  ['VAT_DECLARATION_IMMUTABLE', 'Déclaration figée : modification refusée.'],
  ['VAT_BAD_STATUS', 'Statut incompatible avec cette action.'],
  ['VAT_RECEIPT_REQUIRED', 'Référence d’accusé et date (dans la période ou après) obligatoires.'],
  ['VAT_CANNOT_CANCEL_DEPOSITED', 'Une déclaration déposée ne peut pas être annulée.'],
  ['VAT_FX_MISSING', 'Facture sans taux de change : la déclaration ne peut pas être calculée.'],
  ['VAT_RATE_NOT_VALIDATED', 'Taux de TVA non validé par l’expert : calcul bloqué.'],
  ['VAT_RATE_MISSING', 'Taux de TVA inconnu.'],
  ['SUPPLIER_VAT_MISMATCH', 'Base + TVA des taux saisis ne correspond pas au total de la facture fournisseur.'],
  ['VAT_CURRENCY_UNSUPPORTED', 'Détail de TVA seulement pour une facture en devise de base.'],
  ['WITHHOLDING_NOT_CONFIGURED', 'Aucune règle de retenue pour ce code à cette date.'],
  ['WITHHOLDING_NOT_VALIDATED', 'Règle de retenue non validée par une autre personne : retenue refusée.'],
  ['WITHHOLDING_OVERLAP', 'Une version de la règle existe déjà sur cette période : fermer la version précédente d’abord.'],
  ['WITHHOLDING_IN_USE', 'Fermeture impossible : une retenue enregistrée postdate la date de fin.'],
  ['WITHHOLDING_IMMUTABLE', 'Règle ou retenue figée : modification refusée.'],
  ['WITHHOLDING_BAD_AMOUNT', 'Base de retenue invalide (positive et au plus égale au total).'],
  ['duplicate key', 'Cet accusé de réception est déjà utilisé pour une autre déclaration.'],
]

async function run(fn: string, args: Record<string, unknown>, path: string, okMessage: string): Promise<FormState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Action impossible.' }
  }
  revalidatePath(path)
  return { ok: true, message: okMessage }
}

const uuid = z.string().uuid()
const period = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) })
const reason = z.string().trim().min(5).max(300)

export async function vatPrepareAction(_p: FormState, fd: FormData): Promise<FormState> {
  const p = period.safeParse({ year: fd.get('year'), month: fd.get('month') })
  if (!p.success) return { ok: false, message: 'Période invalide.' }
  return run('vat_declaration_prepare', { p_year: p.data.year, p_month: p.data.month }, '/finance/tva', 'Déclaration calculée (brouillon).')
}

export async function vatValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id')); if (!id.success) return { ok: false, message: 'Déclaration invalide.' }
  return run('vat_declaration_validate', { p_id: id.data }, '/finance/tva', 'Déclaration validée et figée.')
}

export async function vatExportAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id')); if (!id.success) return { ok: false, message: 'Déclaration invalide.' }
  return run('vat_declaration_export', { p_id: id.data }, '/finance/tva', 'Export interne généré (empreinte enregistrée). Aucun dépôt n’a été fait.')
}

export async function vatFileAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const ref = z.string().trim().min(3).max(80).safeParse(fd.get('receipt_ref'))
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(fd.get('receipt_date'))
  if (!id.success || !ref.success || !date.success) return { ok: false, message: 'Référence d’accusé et date obligatoires.' }
  return run('vat_declaration_file', { p_id: id.data, p_receipt_ref: ref.data, p_receipt_date: date.data }, '/finance/tva',
    'Dépôt enregistré avec la référence d’accusé saisie.')
}

export async function vatCancelAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const r = reason.safeParse(fd.get('reason'))
  if (!id.success || !r.success) return { ok: false, message: 'Motif d’au moins 5 caractères obligatoire.' }
  return run('vat_declaration_cancel', { p_id: id.data, p_reason: r.data }, '/finance/tva', 'Déclaration annulée.')
}

export async function withholdingRuleCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const code = z.string().trim().regex(/^[A-Z0-9_]{3,40}$/).safeParse(fd.get('code'))
  const label = z.string().trim().min(3).max(200).safeParse(fd.get('label'))
  const rate = z.coerce.number().min(0).max(100).safeParse(fd.get('rate_pct'))
  const from = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(fd.get('effective_from'))
  const toRaw = String(fd.get('effective_to') ?? '')
  const to = toRaw === '' ? null : z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(toRaw)
  if (!code.success || !label.success || !rate.success || !from.success || (to && !to.success)) {
    return { ok: false, message: 'Code (A–Z, 0–9, _), libellé, taux et date d’effet obligatoires.' }
  }
  return run('withholding_rule_create', { p_code: code.data, p_label: label.data, p_rate: rate.data, p_from: from.data, p_to: to ? to.data : null },
    '/finance/retenues', 'Version créée : à valider par une autre personne.')
}

export async function withholdingRuleValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id')); if (!id.success) return { ok: false, message: 'Règle invalide.' }
  const validate = fd.get('validate') === 'true'
  return run('withholding_rule_validate', { p_id: id.data, p_validate: validate }, '/finance/retenues',
    validate ? 'Règle validée.' : 'Version non validée supprimée.')
}

export async function withholdingRuleCloseAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const to = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(fd.get('effective_to'))
  if (!id.success || !to.success) return { ok: false, message: 'Date de fin obligatoire.' }
  return run('withholding_rule_close', { p_id: id.data, p_to: to.data }, '/finance/retenues', 'Version fermée à la date indiquée.')
}

export async function withholdingRecordAction(_p: FormState, fd: FormData): Promise<FormState> {
  const inv = uuid.safeParse(fd.get('supplier_invoice_id'))
  const code = z.string().trim().min(3).max(40).safeParse(fd.get('rule_code'))
  const base = z.coerce.number().positive().safeParse(fd.get('base'))
  if (!inv.success || !code.success || !base.success) return { ok: false, message: 'Facture, code de règle et base obligatoires.' }
  return run('supplier_withholding_record', { p_invoice: inv.data, p_rule_code: code.data, p_base: base.data }, '/finance/retenues',
    'Retenue enregistrée au taux de la règle en vigueur.')
}

export async function withholdingCancelAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const r = reason.safeParse(fd.get('reason'))
  if (!id.success || !r.success) return { ok: false, message: 'Motif d’au moins 5 caractères obligatoire.' }
  return run('supplier_withholding_cancel', { p_id: id.data, p_reason: r.data }, '/finance/retenues', 'Retenue annulée.')
}

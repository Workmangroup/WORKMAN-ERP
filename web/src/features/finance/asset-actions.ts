'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Immobilisations : règles, catégories, acquisition, mise en service, dotations, cessions, inventaire (0089). Écritures par le service comptable. */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant pour cette action.'],
  ['SOD_SELF_APPROVAL', 'Action refusée : elle doit être faite par une autre personne que l’auteur.'],
  ['FIXED_ASSET_BAD_AMOUNT', 'Montants invalides : coût positif, valeur résiduelle inférieure au coût, motif et compte de produit requis.'],
  ['FIXED_ASSET_CATEGORY_NOT_VALIDATED', 'Catégorie non signée : acquisition impossible.'],
  ['FIXED_ASSET_CATEGORY_ACCOUNT_MISSING', 'Compte de catégorie absent du plan comptable.'],
  ['FIXED_ASSET_DOCUMENT_REQUIRED', 'Justificatif fournisseur obligatoire avant la mise en service.'],
  ['FIXED_ASSET_RULE_NOT_VALIDATED', 'Règle d’amortissement non signée à cette date.'],
  ['FIXED_ASSET_RULE_MISSING', 'Aucune règle d’amortissement applicable à cette date.'],
  ['FIXED_ASSET_BAD_DATE', 'Date invalide (mise en service après acquisition ; cession après mise en service).'],
  ['FIXED_ASSET_LIFE_TOO_SHORT', 'Durée trop longue pour le montant amortissable.'],
  ['FIXED_ASSET_DEPRECIATION_PENDING', 'Dotations non comptabilisées jusqu’au mois de cession : les comptabiliser d’abord.'],
  ['FIXED_ASSET_BAD_STATUS', 'Statut incompatible avec cette action.'],
  ['FIXED_ASSET_PERIOD_INVALID', 'Période invalide.'],
  ['GL_PERIOD_CLOSED', 'Période close : écriture refusée.'],
  ['GL_ACCOUNT_MISSING', 'Compte absent ou inactif dans le plan comptable.'],
  ['FIXED_ASSET_IMMUTABLE', 'Élément figé : modification refusée.'],
]

async function run(fn: string, args: Record<string, unknown>, okMessage: string): Promise<FormState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Action impossible.' }
  }
  revalidatePath('/finance/immobilisations')
  return { ok: true, message: okMessage }
}

const uuid = z.string().uuid()
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const account = z.string().regex(/^[0-9]{3,8}$/)

export async function assetRuleCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const kind = z.enum(['accounting', 'tax']).safeParse(fd.get('kind'))
  const code = z.string().regex(/^[A-Z0-9_]{3,40}$/).safeParse(fd.get('code'))
  const life = z.coerce.number().int().min(1).max(600).safeParse(fd.get('life_months'))
  const from = date.safeParse(fd.get('effective_from'))
  if (!kind.success || !code.success || !life.success || !from.success) return { ok: false, message: 'Nature, code, durée (mois) et date d’effet obligatoires.' }
  return run('asset_rule_create', { p_kind: kind.data, p_code: code.data, p_life_months: life.data, p_effective_from: from.data }, 'Règle enregistrée : à signer par une autre personne.')
}

export async function assetRuleValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id')); if (!id.success) return { ok: false, message: 'Règle invalide.' }
  return run('asset_rule_validate', { p_id: id.data, p_validate: true }, 'Règle signée.')
}

export async function assetCategoryCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const code = z.string().regex(/^[A-Z0-9_]{2,20}$/).safeParse(fd.get('code'))
  const label = z.string().trim().min(2).max(120).safeParse(fd.get('label'))
  const accs = ['asset_account', 'depreciation_account', 'expense_account', 'gain_account', 'loss_account'].map((k) => account.safeParse(fd.get(k)))
  if (!code.success || !label.success || accs.some((a) => !a.success)) return { ok: false, message: 'Code, libellé et cinq comptes (chiffres) obligatoires.' }
  return run('fixed_asset_category_create', {
    p_code: code.data, p_label: label.data, p_asset_account: accs[0].data, p_depreciation_account: accs[1].data, p_expense_account: accs[2].data,
    p_gain_account: accs[3].data, p_loss_account: accs[4].data,
  }, 'Catégorie enregistrée : à signer par une autre personne.')
}

export async function assetCategoryValidateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id')); if (!id.success) return { ok: false, message: 'Catégorie invalide.' }
  return run('fixed_asset_category_validate', { p_id: id.data, p_validate: true }, 'Catégorie signée.')
}

export async function assetAcquireAction(_p: FormState, fd: FormData): Promise<FormState> {
  const cat = uuid.safeParse(fd.get('category'))
  const label = z.string().trim().min(3).max(160).safeParse(fd.get('label'))
  const d = date.safeParse(fd.get('acquisition_date'))
  const cost = z.coerce.number().positive().safeParse(fd.get('cost'))
  const residual = z.coerce.number().min(0).safeParse(fd.get('residual'))
  const credit = account.safeParse(fd.get('credit_account'))
  if (!cat.success || !label.success || !d.success || !cost.success || !residual.success || !credit.success) {
    return { ok: false, message: 'Catégorie, libellé, date, coût, valeur résiduelle et compte de contrepartie obligatoires.' }
  }
  return run('fixed_asset_acquire', { p_category: cat.data, p_label: label.data, p_date: d.data, p_cost: cost.data, p_residual: residual.data, p_credit_account: credit.data },
    'Immobilisation acquise (écriture comptabilisée).')
}

export async function assetDocumentAddAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const kind = z.enum(['supplier_invoice', 'delivery_note', 'commissioning_report', 'disposal_proof']).safeParse(fd.get('kind'))
  const ref = z.string().trim().min(3).max(80).safeParse(fd.get('reference'))
  const d = date.safeParse(fd.get('document_date'))
  if (!id.success || !kind.success || !ref.success || !d.success) return { ok: false, message: 'Nature, référence et date du justificatif obligatoires.' }
  return run('fixed_asset_document_add', { p_asset: id.data, p_kind: kind.data, p_reference: ref.data, p_date: d.data }, 'Justificatif enregistré.')
}

export async function assetCommissionAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const d = date.safeParse(fd.get('in_service_date'))
  const acc = z.string().regex(/^[A-Z0-9_]{3,40}$/).safeParse(fd.get('acc_rule'))
  const tax = z.string().regex(/^[A-Z0-9_]{3,40}$/).safeParse(fd.get('tax_rule'))
  if (!id.success || !d.success || !acc.success || !tax.success) return { ok: false, message: 'Date de mise en service et deux règles (comptable, fiscale) obligatoires.' }
  return run('fixed_asset_commission', { p_asset: id.data, p_in_service: d.data, p_acc_rule: acc.data, p_tax_rule: tax.data }, 'Immobilisation mise en service.')
}

export async function assetDepreciationPostAction(_p: FormState, fd: FormData): Promise<FormState> {
  const y = z.coerce.number().int().min(2000).max(2100).safeParse(fd.get('year'))
  const m = z.coerce.number().int().min(1).max(12).safeParse(fd.get('month'))
  if (!y.success || !m.success) return { ok: false, message: 'Année et mois obligatoires.' }
  return run('fixed_asset_depreciation_post', { p_year: y.data, p_month: m.data }, 'Dotations du mois comptabilisées (ou déjà comptabilisées).')
}

export async function assetDisposeAction(_p: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(fd.get('id'))
  const d = date.safeParse(fd.get('disposal_date'))
  const proceeds = z.coerce.number().min(0).safeParse(fd.get('proceeds'))
  const pacc = fd.get('proceeds_account') ? account.safeParse(fd.get('proceeds_account')) : null
  const reason = z.string().trim().min(5).max(300).safeParse(fd.get('reason'))
  if (!id.success || !d.success || !proceeds.success || !reason.success || (pacc && !pacc.success)) {
    return { ok: false, message: 'Date, produit, motif (5 caractères min.) et compte du produit (si produit > 0) obligatoires.' }
  }
  return run('fixed_asset_dispose', { p_asset: id.data, p_date: d.data, p_proceeds: proceeds.data, p_proceeds_account: pacc?.success ? pacc.data : null, p_reason: reason.data },
    'Cession comptabilisée.')
}

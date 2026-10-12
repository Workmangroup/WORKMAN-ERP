'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError } from '@/features/stock/errors'

/** Qualité : toute règle (décision, rejet automatique, transitions, clôtures) est appliquée par les fonctions SQL (0020). */

const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null))
const optUuid = z.string().trim().optional().transform((v) => (v ? v : null)).pipe(z.union([z.null(), z.uuid('Valeur invalide')]))
const uuid = (label: string) => z.uuid(`${label} invalide`)
const date = z.string().trim().optional().transform((v) => (v ? v : null)).pipe(z.union([z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide')]))
const qty = (label: string) => z.string().trim().min(1, `${label} requis`)
  .transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
  .refine((n) => Number.isFinite(n) && n > 0, `${label} : supérieur à 0`)
  .refine((n) => n <= 1_000_000, `${label} trop grand`)

const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))
const raw = (fd: FormData): Record<string, string> => Object.fromEntries(Object.entries(obj(fd)).map(([k, v]) => [k, String(v)]))
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => {
  const fe = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>
  return { ok: false, message: Object.values(fe).flat().find(Boolean) ?? 'Veuillez corriger les champs en erreur.', fieldErrors: fe, values }
}
async function requireCtx(): Promise<AuthContextValue> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  return ctx
}
const MESSAGES: [string, string][] = [
  ['QUALITY_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel.'],
  ['QUALITY_CRITICAL_DEFECT', 'Un défaut critique impose le rejet du contrôle.'],
  ['QUALITY_DECISION_NOT_ALLOWED', 'Un défaut majeur interdit l’acceptation pleine : choisissez l’acceptation conditionnelle ou le rejet.'],
  ['QUALITY_DEFECT_CODE_NOT_FOUND', 'Code défaut introuvable ou inactif dans le référentiel.'],
  ['QUALITY_BAD_QTY', 'La quantité doit être supérieure à 0.'],
  ['QUALITY_BAD_SEVERITY', 'Gravité inconnue (mineure, majeure ou critique).'],
  ['QUALITY_BAD_DECISION', 'Décision inconnue.'],
  ['QUALITY_REASON_REQUIRED', 'Motif trop court (5 caractères minimum).'],
  ['QUALITY_JUSTIFICATION_REQUIRED', 'Sans action corrective vérifiée, une justification d’au moins 10 caractères est exigée.'],
  ['QUALITY_ACTIONS_OPEN', 'Des actions restent ouvertes : elles doivent être vérifiées efficaces ou annulées.'],
  ['QUALITY_PLAN_NOT_ACTIVE', 'Le plan d’actions doit être activé avant d’y rattacher une action.'],
  ['QUALITY_SOURCE_NOT_FOUND', 'Source introuvable (article, matière, ordre ou réception).'],
  ['QUALITY_NOT_FOUND', 'Élément introuvable.'],
  ['QUALITY_IMMUTABLE', 'L’historique des défauts ne peut pas être modifié.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
  ['check constraint', 'Une valeur ne respecte pas les règles de saisie.'],
]
const messageOf = (err: { message?: string; code?: string; details?: string | null }) => {
  const text = `${err.message ?? ''} ${err.details ?? ''}`
  for (const [k, m] of MESSAGES) if (text.includes(k)) return m
  if (err.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}
async function dbFail(ctx: AuthContextValue, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, P.QUALITY_WRITE, { via: 'database' })
  return { ok: false, message: messageOf(err), values }
}
const rev = () => revalidatePath('/quality', 'layout')

async function run(fn: string, args: Record<string, unknown>, values: Record<string, string>, success: string): Promise<FormState> {
  const ctx = await requireCtx()
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: success }
}

export async function saveDefectCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,19}$/, 'Code : lettres et chiffres (20 max)'),
    label: z.string().trim().min(2, 'Libellé : 2 caractères minimum').max(120),
    category: z.enum(['matiere', 'coupe', 'couture', 'finition', 'dimension', 'etiquetage', 'autre'], { message: 'Famille inconnue' }),
    severity: z.enum(['minor', 'major', 'critical'], { message: 'Gravité inconnue' }),
  }).safeParse({ code: fd.get('code'), label: fd.get('label'), category: fd.get('category'), severity: fd.get('severity') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('quality_defect_code_save', { p_code: parsed.data.code, p_label: parsed.data.label, p_category: parsed.data.category, p_severity: parsed.data.severity }, values, `Défaut ${parsed.data.code} enregistré.`)
}

export async function openInspectionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    kind: z.enum(['reception', 'production', 'final'], { message: 'Type de contrôle inconnu' }),
    material_id: optUuid, article_id: optUuid, production_order_id: optUuid,
    receipt_ref: optText(60), sample: qty('Taille de l’échantillon'), note: optText(500),
  }).safeParse({ kind: fd.get('kind'), material_id: fd.get('material_id'), article_id: fd.get('article_id'), production_order_id: fd.get('production_order_id'),
    receipt_ref: fd.get('receipt_ref'), sample: fd.get('sample'), note: fd.get('note') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('quality_inspection_open', { p_kind: d.kind, p_material: d.material_id, p_article: d.article_id, p_production_order: d.production_order_id,
    p_purchase_receipt: null, p_receipt_ref: d.receipt_ref, p_sample: d.sample, p_note: d.note }, values, 'Contrôle ouvert.')
}

export async function addDefectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    inspection_id: uuid('Contrôle'), code: z.string().trim().min(1, 'Code défaut requis').transform((v) => v.toUpperCase()),
    qty: qty('Nombre de défauts'), severity: z.string().trim().optional().transform((v) => (v ? v : null)), note: optText(300),
  }).safeParse({ inspection_id: fd.get('inspection_id'), code: fd.get('code'), qty: fd.get('qty'), severity: fd.get('severity'), note: fd.get('note') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('quality_defect_add', { p_inspection: d.inspection_id, p_code: d.code, p_qty: d.qty, p_severity: d.severity, p_note: d.note }, values, 'Défaut constaté.')
}

export async function decideInspectionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ inspection_id: uuid('Contrôle'), decision: z.enum(['accepted', 'conditional', 'rejected'], { message: 'Décision inconnue' }), note: optText(500) })
    .safeParse({ inspection_id: fd.get('inspection_id'), decision: fd.get('decision'), note: fd.get('note') })
  if (!parsed.success) return invalid(parsed.error, values)
  const ctx = await requireCtx()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('quality_inspection_decide', { p_inspection: parsed.data.inspection_id, p_decision: parsed.data.decision, p_note: parsed.data.note })
  if (error) return dbFail(ctx, error, values)
  rev()
  const r = data as { nc_number: string | null }
  return { ok: true, message: r.nc_number ? `Contrôle rejeté : non-conformité ${r.nc_number} ouverte.` : 'Décision enregistrée.' }
}

export async function openNcAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    title: z.string().trim().min(3, 'Titre : 3 caractères minimum').max(160),
    description: optText(1000),
    severity: z.enum(['minor', 'major', 'critical'], { message: 'Gravité inconnue' }),
    due: date,
  }).safeParse({ title: fd.get('title'), description: fd.get('description'), severity: fd.get('severity'), due: fd.get('due') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('quality_nc_open', { p_title: d.title, p_description: d.description, p_severity: d.severity, p_due: d.due }, values, 'Non-conformité ouverte.')
}

export async function containNcAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ nc_id: uuid('Non-conformité'), containment: z.string().trim().min(5, 'Confinement : 5 caractères minimum').max(500), root_cause: optText(500) })
    .safeParse({ nc_id: fd.get('nc_id'), containment: fd.get('containment'), root_cause: fd.get('root_cause') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('quality_nc_contain', { p_nc: parsed.data.nc_id, p_containment: parsed.data.containment, p_root_cause: parsed.data.root_cause }, values, 'Non-conformité contenue.')
}

export async function closeNcAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ nc_id: uuid('Non-conformité'), note: optText(500) }).safeParse({ nc_id: fd.get('nc_id'), note: fd.get('note') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('quality_nc_close', { p_nc: parsed.data.nc_id, p_note: parsed.data.note }, values, 'Non-conformité clôturée.')
}

export async function addActionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    nc_id: uuid('Non-conformité'), kind: z.enum(['corrective', 'preventive'], { message: 'Type inconnu' }),
    action: z.string().trim().min(3, 'Action : 3 caractères minimum').max(500), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Échéance requise'),
    plan_id: optUuid,
  }).safeParse({ nc_id: fd.get('nc_id'), kind: fd.get('kind'), action: fd.get('action'), due: fd.get('due'), plan_id: fd.get('plan_id') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('quality_ca_add', { p_nc: d.nc_id, p_kind: d.kind, p_action: d.action, p_owner: null, p_due: d.due, p_plan: d.plan_id }, values, 'Action ajoutée.')
}

/** Actions à un seul bouton : avancement, vérification, clôture de plan et d'action. */
export async function progressActionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = z.object({ ca_id: uuid('Action'), status: z.enum(['in_progress', 'done']) }).safeParse({ ca_id: fd.get('ca_id'), status: fd.get('status') })
  if (!parsed.success) return { ok: false, message: 'Action invalide.' }
  return run('quality_ca_progress', { p_ca: parsed.data.ca_id, p_status: parsed.data.status }, {}, 'Avancement enregistré.')
}

export async function verifyActionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = z.object({ ca_id: uuid('Action'), effective: z.enum(['true', 'false']) }).safeParse({ ca_id: fd.get('ca_id'), effective: fd.get('effective') })
  if (!parsed.success) return { ok: false, message: 'Vérification invalide.' }
  return run('quality_ca_verify', { p_ca: parsed.data.ca_id, p_effective: parsed.data.effective === 'true' }, {}, 'Action vérifiée.')
}

export async function cancelActionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ ca_id: uuid('Action'), reason: z.string().trim().min(5, 'Motif : 5 caractères minimum').max(300) })
    .safeParse({ ca_id: fd.get('ca_id'), reason: fd.get('reason') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('quality_ca_cancel', { p_ca: parsed.data.ca_id, p_reason: parsed.data.reason }, values, 'Action annulée.')
}

export async function createPlanAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    title: z.string().trim().min(3, 'Titre : 3 caractères minimum').max(160), objective: optText(500),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date de début requise'), target: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Échéance requise'),
  }).safeParse({ title: fd.get('title'), objective: fd.get('objective'), start: fd.get('start'), target: fd.get('target') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('quality_plan_create', { p_title: d.title, p_objective: d.objective, p_owner: null, p_start: d.start, p_target: d.target }, values, 'Plan créé en brouillon.')
}

export async function planStepAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = z.object({ plan_id: uuid('Plan'), step: z.enum(['activate', 'close']) }).safeParse({ plan_id: fd.get('plan_id'), step: fd.get('step') })
  if (!parsed.success) return { ok: false, message: 'Action invalide.' }
  const fn = parsed.data.step === 'activate' ? 'quality_plan_activate' : 'quality_plan_close'
  return run(fn, { p_plan: parsed.data.plan_id }, {}, parsed.data.step === 'activate' ? 'Plan activé.' : 'Plan clôturé.')
}

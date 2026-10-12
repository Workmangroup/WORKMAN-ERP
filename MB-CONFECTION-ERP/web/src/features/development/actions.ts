'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { devErrorMessage, isPermissionError } from './errors'
import { costSchema, docKindSchema, exchangeSchema, industrializationSchema, projectEditSchema, projectSchema, prototypeSchema, sampleSchema, validationSchema } from './schemas'

/** Écritures via la session de l'utilisateur : RLS et RPC (development.*) font autorité. */

const uuid = z.uuid()

async function authorize(permission: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(permission)) {
    await logAccessDenied(ctx, permission, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}
async function dbFail(ctx: AuthContextValue, permission: string, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, permission, { via: 'database' })
  return { ok: false, message: devErrorMessage(err), values }
}
const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}
const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => {
  const fe = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>
  return { ok: false, message: Object.values(fe).flat().find(Boolean) ?? 'Veuillez corriger les champs en erreur.', fieldErrors: fe, values }
}
const rev = (id?: string) => { revalidatePath('/development', 'layout'); if (id) revalidatePath(`/development/projects/${id}`, 'layout') }
const text = (fd: FormData, k: string, max: number) => String(fd.get(k) ?? '').trim().slice(0, max)

// ---------------------------------------------------------------------
// Projet
// ---------------------------------------------------------------------
export async function createProjectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = projectSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('development_projects').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error, values)
  rev()
  redirect(`/development/projects/${data.id}?created=1`)
}

export async function updateProjectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.', values }
  const parsed = projectEditSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('development_projects').update(parsed.data).eq('id', id.data).select('id')
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Projet introuvable ou modification non autorisée.', values }
  rev(id.data)
  redirect(`/development/projects/${id.data}?updated=1`)
}

async function advance(id: string, to: string, reason: string | null): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  if (!uuid.safeParse(id).success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('dev_project_advance', { p_project: id, p_to: to, p_reason: reason })
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error)
  rev(id)
  return { ok: true, message: 'Étape mise à jour.' }
}
/** Appel direct depuis le Kanban (glisser-déposer). */
export async function moveProjectAction(id: string, to: string, reason?: string): Promise<FormState> {
  return advance(id, String(to), reason?.trim().slice(0, 300) || null)
}
export async function advanceProjectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return advance(String(fd.get('id') ?? ''), String(fd.get('to') ?? ''), text(fd, 'reason', 300) || null)
}

export async function setProjectStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const status = z.enum(['active', 'on_hold', 'cancelled', 'completed']).safeParse(fd.get('status'))
  if (!id.success || !status.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('dev_project_set_status', { p_project: id.data, p_status: status.data, p_reason: text(fd, 'reason', 300) || null })
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error)
  rev(id.data)
  return { ok: true, message: 'Statut du projet mis à jour.' }
}

// ---------------------------------------------------------------------
// Prototypes et coûts
// ---------------------------------------------------------------------
export async function addPrototypeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = prototypeSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('prototypes').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error, values)
  rev(parsed.data.project_id)
  return { ok: true, message: 'Prototype ajouté.' }
}

export async function prototypeStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('project_id'))
  const status = z.enum(['in_progress', 'ready', 'approved', 'rejected']).safeParse(fd.get('status'))
  if (!id.success || !pid.success || !status.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('dev_prototype_set_status', { p_prototype: id.data, p_status: status.data, p_feedback: text(fd, 'feedback', 1000) || null })
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error)
  rev(pid.data)
  return { ok: true, message: 'Prototype mis à jour.' }
}

export async function addCostAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_COSTS)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const pid = uuid.safeParse(fd.get('project_id'))
  const parsed = costSchema.safeParse(obj(fd))
  if (!pid.success) return { ok: false, message: 'Données invalides.', values }
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('prototype_costs').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_COSTS, error, values)
  rev(pid.data)
  return { ok: true, message: 'Coût ajouté.' }
}

export async function deleteCostAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.DEVELOPMENT_COSTS)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('project_id'))
  if (!id.success || !pid.success) return
  const supabase = await createClient()
  await supabase.from('prototype_costs').delete().eq('id', id.data)
  rev(pid.data)
}

// ---------------------------------------------------------------------
// Échantillons
// ---------------------------------------------------------------------
export async function addSampleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = sampleSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('samples').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error, values)
  rev(parsed.data.project_id)
  return { ok: true, message: 'Échantillon ajouté.' }
}

export async function sampleStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('project_id'))
  const status = z.enum(['in_progress', 'sent']).safeParse(fd.get('status'))
  if (!id.success || !pid.success || !status.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('dev_sample_set_status', { p_sample: id.data, p_status: status.data, p_tracking: text(fd, 'tracking', 80) || null })
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error)
  rev(pid.data)
  return { ok: true, message: 'Échantillon mis à jour.' }
}

// ---------------------------------------------------------------------
// Validations client (échantillons, BAT)
// ---------------------------------------------------------------------
export async function submitValidationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = validationSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  if (parsed.data.kind === 'bat') parsed.data.sample_id = null
  else if (!parsed.data.sample_id) return { ok: false, message: 'Choisissez l’échantillon à soumettre.', values, fieldErrors: { sample_id: ['Échantillon requis'] } }
  const supabase = await createClient()
  const { error } = await supabase.from('customer_validations').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error, values)
  rev(parsed.data.project_id)
  return { ok: true, message: 'Soumis à la validation du client.' }
}

export async function decideValidationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('project_id'))
  const decision = z.enum(['approved', 'rejected', 'changes_requested']).safeParse(fd.get('decision'))
  if (!id.success || !pid.success || !decision.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('dev_validation_decide', { p_validation: id.data, p_decision: decision.data, p_comment: text(fd, 'comment', 1000) || null, p_contact: text(fd, 'contact', 120) || null })
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error)
  rev(pid.data)
  return { ok: true, message: 'Décision du client enregistrée.' }
}

export async function remindValidationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('project_id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('dev_validation_remind', { p_validation: id.data, p_note: text(fd, 'note', 300) || null })
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error)
  rev(pid.success ? pid.data : undefined)
  revalidatePath('/development/validations')
  return { ok: true, message: 'Relance enregistrée.' }
}

// ---------------------------------------------------------------------
// Échanges, pièces jointes GED
// ---------------------------------------------------------------------
export async function addExchangeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = exchangeSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('development_exchanges').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error, values)
  rev(parsed.data.project_id)
  return { ok: true, message: 'Échange enregistré.' }
}

export async function linkDocumentsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const pid = uuid.safeParse(fd.get('project_id'))
  const kind = docKindSchema.safeParse(fd.get('kind'))
  const ids = z.array(uuid).max(100).safeParse(fd.getAll('doc').map(String))
  if (!pid.success || !kind.success || !ids.success || ids.data.length === 0) return { ok: false, message: 'Sélectionnez au moins un document.' }
  const supabase = await createClient()
  const { data, error } = await supabase.from('development_documents').insert(ids.data.map((d) => ({ project_id: pid.data, ged_document_id: d, kind: kind.data }))).select('id')
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error)
  rev(pid.data)
  return { ok: true, message: `${data?.length ?? 0} document(s) rattaché(s).` }
}

export async function unlinkDocumentAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const pid = uuid.safeParse(fd.get('project_id'))
  if (!id.success || !pid.success) return
  const supabase = await createClient()
  await supabase.from('development_documents').delete().eq('id', id.data).eq('project_id', pid.data)
  rev(pid.data)
}

// ---------------------------------------------------------------------
// Industrialisation
// ---------------------------------------------------------------------
export async function saveIndustrializationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const pid = uuid.safeParse(fd.get('project_id'))
  if (!pid.success) return { ok: false, message: 'Données invalides.', values }
  const parsed = industrializationSchema.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const done = new Set(fd.getAll('done').map(String))
  const supabase = await createClient()
  const { data: cur } = await supabase.from('industrialization').select('checklist').eq('project_id', pid.data).maybeSingle()
  const checklist = ((cur?.checklist as { key: string; label: string; done: boolean }[] | undefined) ?? []).map((c) => ({ ...c, done: done.has(c.key) }))
  const { data, error } = await supabase.from('industrialization').update({ ...parsed.data, checklist }).eq('project_id', pid.data).select('project_id')
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Modification non autorisée.', values }
  rev(pid.data)
  return { ok: true, message: 'Industrialisation enregistrée.' }
}

export async function industrializationStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.DEVELOPMENT_WRITE)
  if ('error' in auth) return auth.error
  const pid = uuid.safeParse(fd.get('project_id'))
  const status = z.enum(['not_started', 'in_progress', 'ready']).safeParse(fd.get('status'))
  if (!pid.success || !status.success) return { ok: false, message: 'Données invalides.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('dev_industrialization_set_status', { p_project: pid.data, p_status: status.data })
  if (error) return dbFail(auth.ctx, P.DEVELOPMENT_WRITE, error)
  rev(pid.data)
  return { ok: true, message: status.data === 'ready' ? 'Industrialisation déclarée prête.' : 'Statut mis à jour.' }
}

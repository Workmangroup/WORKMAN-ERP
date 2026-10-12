'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'

/** Écritures via la session de l'utilisateur : les fonctions SQL import_* font autorité (droits, séparation des tâches, état du lot). */

export type ImportResult<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; message: string }

const KINDS = ['sites', 'warehouse_locations', 'cost_centers', 'calendars'] as const

const MESSAGES: Record<string, string> = {
  RBAC_FORBIDDEN: 'Vous n’avez pas la permission d’effectuer cette action.',
  SOD_SELF_APPROVAL: 'La validation doit être faite par une autre personne que celle qui a chargé le lot.',
  IMPORT_KEY_CONFLICT: 'Ce fichier ne correspond pas au lot déjà enregistré pour cette clé.',
  IMPORT_NOT_OWNER: 'Ce lot appartient à une autre personne.',
  IMPORT_BAD_STATUS: 'Cette étape n’est pas possible pour ce lot dans son état actuel.',
  IMPORT_ALREADY_LOADED: 'Ce lot contient déjà ses lignes : aucune ligne n’a été ajoutée deux fois.',
  IMPORT_EMPTY: 'Le fichier ne contient aucune ligne exploitable.',
  IMPORT_TOO_MANY_ROWS: 'Trop de lignes dans un seul lot (5 000 maximum).',
  IMPORT_NOT_FOUND: 'Lot introuvable.',
  OWNER_INVALID: 'Le responsable doit être un profil actif de la société.',
}
const messageOf = (err: { message?: string }) => MESSAGES[err.message ?? ''] ?? 'L’opération a échoué. Vérifiez les données et réessayez.'

async function authorize(permission: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(permission)) {
    await logAccessDenied(ctx, permission, { via: 'server-action' })
    return { ok: false, message: MESSAGES.RBAC_FORBIDDEN }
  }
  return { ok: true }
}

const prepareSchema = z.object({
  kind: z.enum(KINDS),
  fileName: z.string().trim().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().min(8).max(120),
  rows: z.array(z.record(z.string(), z.string())).min(1).max(5000),
})

/** Prépare un lot : création (ou reprise par clé) puis chargement des lignes. Une reprise ne duplique rien. */
export async function prepareImportAction(input: unknown): Promise<ImportResult<{ batchId: string; loaded: unknown; resumed: boolean }>> {
  const auth = await authorize(P.IMPORTS_WRITE)
  if (!auth.ok) return auth
  const parsed = prepareSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'Le fichier ou son type est invalide.' }
  const { kind, fileName, sha256, key, rows } = parsed.data
  const supabase = await createClient()
  const { data: batchId, error: e1 } = await supabase.rpc('import_batch_create', { p_kind: kind, p_file_name: fileName, p_sha256: sha256, p_key: key })
  if (e1) return { ok: false, message: messageOf(e1) }
  const { data: loaded, error: e2 } = await supabase.rpc('import_rows_load', { p_batch: batchId, p_rows: rows })
  if (e2) {
    // Lot déjà chargé (reprise) : on continue avec le lot existant, sans recharger
    if (e2.message === 'IMPORT_ALREADY_LOADED') return { ok: true, data: { batchId: batchId as string, loaded: null, resumed: true } }
    return { ok: false, message: messageOf(e2) }
  }
  return { ok: true, data: { batchId: batchId as string, loaded, resumed: false } }
}

export async function simulateImportAction(batchId: string): Promise<ImportResult> {
  const auth = await authorize(P.IMPORTS_WRITE)
  if (!auth.ok) return auth
  if (!z.uuid().safeParse(batchId).success) return { ok: false, message: 'Lot invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('import_simulate', { p_batch: batchId })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath('/admin/imports')
  return { ok: true, data: data as Record<string, unknown> }
}

export async function commitImportAction(batchId: string): Promise<ImportResult> {
  const auth = await authorize(P.IMPORTS_COMMIT)
  if (!auth.ok) return auth
  if (!z.uuid().safeParse(batchId).success) return { ok: false, message: 'Lot invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('import_commit', { p_batch: batchId })
  if (error) return { ok: false, message: messageOf(error) }
  revalidatePath('/admin/imports')
  return { ok: true, data: data as Record<string, unknown> }
}

export async function rejectsAction(batchId: string): Promise<ImportResult<{ line_no: number; raw: Record<string, string>; errors: { code: string; field?: string }[] }[]>> {
  const auth = await authorize(P.IMPORTS_READ)
  if (!auth.ok) return auth
  if (!z.uuid().safeParse(batchId).success) return { ok: false, message: 'Lot invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('import_rejects_export', { p_batch: batchId })
  if (error) return { ok: false, message: messageOf(error) }
  return { ok: true, data: (data ?? []) as never }
}

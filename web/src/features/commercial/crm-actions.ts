'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { commercialErrorMessage, isPermissionError } from './errors'

/** Contrats, objectifs et visites : les règles (dates, pièces, périmètre, GPS, propriétaire) sont appliquées par les fonctions SQL de 0050. Ici : forme des saisies et messages. */

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const num = (fd: FormData, k: string) => {
  const v = str(fd, k).replace(',', '.')
  return v === '' ? null : Number(v)
}
const nullable = (fd: FormData, k: string) => str(fd, k) || null
const day = (fd: FormData, k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(str(fd, k)) ? str(fd, k) : null)
const currency = (fd: FormData) => (/^[A-Z]{3}$/.test(str(fd, 'currency')) ? str(fd, 'currency') : null)
const uuid = (fd: FormData, k: string) => (/^[0-9a-f-]{36}$/i.test(str(fd, k)) ? str(fd, k) : null)

async function authorize(perm: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(perm)) {
    await logAccessDenied(ctx, perm, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}

async function run(perm: string, fn: string, args: Record<string, unknown>, done: string): Promise<FormState> {
  const auth = await authorize(perm)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    if (isPermissionError(error)) await logAccessDenied(auth.ctx, perm, { via: 'database' })
    return { ok: false, message: commercialErrorMessage(error) }
  }
  revalidatePath('/commercial', 'layout')
  return { ok: true, message: done }
}

const invalid = (message: string): FormState => ({ ok: false, message })

// ---------------------------------------------------------------------
// Contrats
// ---------------------------------------------------------------------
export async function contractCreateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const client = uuid(fd, 'client_id')
  const start = day(fd, 'start_on')
  const end = day(fd, 'end_on')
  if (!client) return invalid('Choisissez le client.')
  if (!start || !end) return invalid('Dates de début et de fin requises.')
  return run(P.CONTRACTS_WRITE, 'contract_create', {
    p_client: client, p_kind: str(fd, 'kind'), p_start: start, p_end: end,
    p_auto_renew: fd.get('auto_renew') === 'on', p_notice_days: num(fd, 'renew_notice_days') ?? 30,
    p_currency: currency(fd), p_payment_terms: nullable(fd, 'payment_terms'),
    p_discount_pct: num(fd, 'discount_pct'), p_price_conditions: nullable(fd, 'price_conditions'),
  }, 'Contrat créé en brouillon. Il ne vaut qu’une fois signé avec la pièce signée.')
}

export async function contractSignAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid(fd, 'contract_id')
  const doc = uuid(fd, 'document_id')
  if (!id) return invalid('Contrat introuvable.')
  if (!doc) return invalid('Choisissez la pièce signée dans la GED du client.')
  return run(P.CONTRACTS_WRITE, 'contract_sign', { p_contract: id, p_document: doc, p_signed_by: str(fd, 'signed_by') }, 'Contrat signé : ses conditions sont valides à partir de la date de début.')
}

export async function contractRenewAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid(fd, 'contract_id')
  const start = day(fd, 'start_on')
  const end = day(fd, 'end_on')
  if (!id || !start || !end) return invalid('Contrat et dates requis.')
  return run(P.CONTRACTS_WRITE, 'contract_renew', {
    p_contract: id, p_start: start, p_end: end, p_currency: currency(fd),
    p_payment_terms: nullable(fd, 'payment_terms'), p_discount_pct: num(fd, 'discount_pct'), p_price_conditions: nullable(fd, 'price_conditions'),
  }, 'Renouvellement créé en brouillon : signez-le avec sa pièce signée.')
}

export async function contractTerminateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid(fd, 'contract_id')
  const on = day(fd, 'terminated_on')
  if (!id || !on) return invalid('Contrat et date de résiliation requis.')
  return run(P.CONTRACTS_WRITE, 'contract_terminate', { p_contract: id, p_on: on, p_reason: str(fd, 'reason') }, 'Contrat résilié à la date indiquée.')
}

// ---------------------------------------------------------------------
// Objectifs
// ---------------------------------------------------------------------
export async function objectiveCreateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const start = day(fd, 'period_start')
  const end = day(fd, 'period_end')
  const target = num(fd, 'target')
  if (!start || !end) return invalid('Période requise.')
  if (target === null || !Number.isFinite(target)) return invalid('Montant cible requis.')
  const scope = str(fd, 'scope')
  return run(P.OBJECTIVES_WRITE, 'objective_create', {
    p_scope: scope, p_client: scope === 'client' ? uuid(fd, 'client_id') : null,
    p_label: str(fd, 'label'), p_start: start, p_end: end, p_target: target,
  }, 'Objectif enregistré en devise de base, comparé au CA de même périmètre.')
}

// ---------------------------------------------------------------------
// Visites
// ---------------------------------------------------------------------
/** Date saisie en heure locale du navigateur (tz_min = minutes à l'est de UTC) convertie en instant absolu. */
export async function visitPlanCreateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const local = str(fd, 'planned_local')
  const tz = num(fd, 'tz_min')
  const client = uuid(fd, 'client_id')
  if (!client) return invalid('Choisissez le client.')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || tz === null) return invalid('Date et heure de la visite requises.')
  const sign = tz >= 0 ? '+' : '-'
  const abs = Math.abs(tz)
  const at = new Date(`${local}:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`)
  if (Number.isNaN(at.getTime())) return invalid('Date et heure de la visite invalides.')
  return run(P.VISITS_WRITE, 'visit_plan_create', {
    p_client: client, p_contact: uuid(fd, 'contact_id'), p_planned_at: at.toISOString(),
    p_duration: num(fd, 'duration_min') ?? 30, p_purpose: str(fd, 'purpose'),
  }, 'Visite planifiée.')
}

export async function visitCancelAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid(fd, 'plan_id')
  if (!id) return invalid('Visite introuvable.')
  return run(P.VISITS_WRITE, 'visit_plan_cancel', { p_plan: id, p_reason: str(fd, 'reason') }, 'Visite annulée.')
}

/** Pointage : la position n'est enregistrée que si elle est capturée ; sinon le motif est seul conservé. */
export async function visitCheckinAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid(fd, 'plan_id')
  if (!id) return invalid('Visite introuvable.')
  const status = str(fd, 'gps_status')
  if (!['captured', 'unavailable', 'denied'].includes(status)) return invalid('Statut GPS invalide.')
  return run(P.VISITS_WRITE, 'visit_checkin', {
    p_plan: id, p_gps_status: status,
    p_latitude: num(fd, 'latitude'), p_longitude: num(fd, 'longitude'), p_accuracy_m: num(fd, 'accuracy_m'),
    p_reason: nullable(fd, 'reason'),
  }, status === 'captured' ? 'Pointage enregistré avec la position.' : 'Pointage enregistré sans position (motif conservé).')
}

export async function visitPhotoAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid(fd, 'plan_id')
  const doc = uuid(fd, 'document_id')
  if (!id || !doc) return invalid('Visite et photo requises.')
  return run(P.VISITS_WRITE, 'visit_photo_add', { p_plan: id, p_document: doc, p_caption: nullable(fd, 'caption') }, 'Photo rattachée à la visite.')
}

/** Compte rendu : une dictée n'est acceptée qu'après relecture (case cochée) ; une dictée vide est traitée comme absente. */
export async function visitReportAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid(fd, 'plan_id')
  if (!id) return invalid('Visite introuvable.')
  return run(P.VISITS_WRITE, 'visit_report_finalize', {
    p_plan: id, p_report: str(fd, 'report'), p_dictation: nullable(fd, 'dictation'), p_reviewed: fd.get('reviewed') === 'on',
  }, 'Compte rendu enregistré : la visite est marquée réalisée.')
}

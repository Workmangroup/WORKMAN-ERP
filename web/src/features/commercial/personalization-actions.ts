'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError } from '@/features/mrp/errors'
import { orderErrorMessage } from '@/features/orders/order-errors'

/** Logos, personnalisations et BAT : les règles (version exacte, contact habilité, empreinte, droits, séparation des tâches) sont dans 0054. */

const uuid = z.uuid()
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const num = (fd: FormData, k: string) => {
  const v = str(fd, k).replace(',', '.')
  return v === '' ? null : Number(v)
}
const day = (fd: FormData, k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(str(fd, k)) ? str(fd, k) : null)

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
    return { ok: false, message: orderErrorMessage(error) }
  }
  revalidatePath('/commercial/personalization')
  return { ok: true, message: done }
}

const bad = (message: string): FormState => ({ ok: false, message })

export async function logoRegisterAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const client = uuid.safeParse(str(fd, 'client_id'))
  const doc = uuid.safeParse(str(fd, 'document_id'))
  if (!client.success || !doc.success) return bad('Client et logo (pièce du dossier « logos ») requis.')
  const kind = str(fd, 'rights_kind')
  if (!['owned', 'licensed', 'client_provided'].includes(kind)) return bad('Nature des droits invalide.')
  return run(P.PERSONALIZATION_WRITE, 'logo_register', { p_client: client.data, p_document: doc.data, p_name: str(fd, 'name'), p_rights_kind: kind,
    p_proof: str(fd, 'rights_proof'), p_valid_until: day(fd, 'rights_valid_until') }, 'Logo enregistré avec ses droits.')
}

export async function logoWithdrawAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(str(fd, 'logo_id'))
  if (!id.success) return bad('Logo introuvable.')
  return run(P.PERSONALIZATION_WRITE, 'logo_withdraw', { p_logo: id.data, p_reason: str(fd, 'reason') }, 'Droits retirés : les BAT en cours sur ce logo ne sont plus valides.')
}

export async function personalizationSpecAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const line = uuid.safeParse(str(fd, 'order_line_id'))
  const logo = uuid.safeParse(str(fd, 'logo_id'))
  if (!line.success || !logo.success) return bad('Ligne de commande et logo requis.')
  const w = num(fd, 'width_mm')
  const h = num(fd, 'height_mm')
  if (w === null || h === null) return bad('Dimensions en millimètres requises.')
  const colors = str(fd, 'colors').split(/[,;\s]+/).map((c) => c.trim()).filter(Boolean)
  return run(P.PERSONALIZATION_WRITE, 'personalization_spec_set', { p_order_line: line.data, p_logo: logo.data, p_technique: str(fd, 'technique'),
    p_placement: str(fd, 'placement'), p_width: w, p_height: h, p_colors: colors, p_notes: str(fd, 'notes') || null },
    'Spécification enregistrée. Tout BAT antérieur pour cette ligne n’est plus valide.')
}

export async function batIssueAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const spec = uuid.safeParse(str(fd, 'spec_id'))
  const doc = uuid.safeParse(str(fd, 'document_id'))
  if (!spec.success || !doc.success) return bad('Spécification et PDF du BAT requis.')
  return run(P.PERSONALIZATION_WRITE, 'bat_issue', { p_spec: spec.data, p_document: doc.data }, 'BAT émis : il attend l’accord écrit du client.')
}

/** Accord : l'empreinte du PDF doit être celle saisie (version exacte). Aucun accord n'est déduit d'un silence. */
export async function batAcceptAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const bat = uuid.safeParse(str(fd, 'bat_id'))
  const contact = uuid.safeParse(str(fd, 'contact_id'))
  const on = day(fd, 'accepted_on')
  if (!bat.success || !contact.success) return bad('BAT et contact habilité requis.')
  if (!on) return bad('Date de l’accord requise.')
  return run(P.PERSONALIZATION_WRITE, 'bat_record_acceptance', { p_bat: bat.data, p_contact: contact.data, p_channel: str(fd, 'channel'),
    p_proof: str(fd, 'proof'), p_accepted_on: on, p_pdf_sha256: str(fd, 'pdf_sha256') }, 'Accord enregistré avec sa preuve, la version et la date.')
}

export async function batRejectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const bat = uuid.safeParse(str(fd, 'bat_id'))
  const contact = uuid.safeParse(str(fd, 'contact_id'))
  if (!bat.success || !contact.success) return bad('BAT et contact requis.')
  return run(P.PERSONALIZATION_WRITE, 'bat_record_rejection', { p_bat: bat.data, p_contact: contact.data, p_note: str(fd, 'note') }, 'Refus du BAT enregistré.')
}

export async function personalizationOperationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const spec = uuid.safeParse(str(fd, 'spec_id'))
  if (!spec.success) return bad('Spécification introuvable.')
  return run(P.PERSONALIZATION_OPERATE, 'personalization_operation_start', { p_spec: spec.data }, 'Opération de personnalisation lancée (BAT approuvé et version courante).')
}

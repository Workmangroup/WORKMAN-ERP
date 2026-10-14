'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { commercialErrorMessage, isPermissionError } from './errors'

/** Marketing : les règles (lien de désinscription, séparation des tâches, consentement, refus d'envoi) sont appliquées par 0051. */

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const uuid = z.uuid()
const channel = (fd: FormData) => (['email', 'sms', 'whatsapp'].includes(str(fd, 'channel')) ? str(fd, 'channel') : null)

async function authorize(perm: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(perm)) {
    await logAccessDenied(ctx, perm, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}

async function call(perm: string, fn: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; state: FormState }> {
  const auth = await authorize(perm)
  if ('error' in auth) return { ok: false, state: auth.error }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc(fn, args)
  if (error) {
    if (isPermissionError(error)) await logAccessDenied(auth.ctx, perm, { via: 'database' })
    return { ok: false, state: { ok: false, message: commercialErrorMessage(error) } }
  }
  revalidatePath('/commercial/marketing')
  return { ok: true, data }
}

const done = (message: string): FormState => ({ ok: true, message })
const bad = (message: string): FormState => ({ ok: false, message })

export async function marketingPolicySetAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const channels = fd.getAll('channels').map(String).filter((c) => ['email', 'sms', 'whatsapp'].includes(c))
  const r = await call(P.MARKETING_CONFIGURE, 'marketing_policy_set', { p_send_enabled: fd.get('send_enabled') === 'on', p_channels: channels, p_connector: null })
  return r.ok ? done('Politique enregistrée. Aucun connecteur n’est homologué : l’envoi reste refusé.') : r.state
}

export async function marketingPriceSetAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ch = channel(fd)
  const price = Number(str(fd, 'unit_price').replace(',', '.'))
  const currency = str(fd, 'currency').toUpperCase()
  if (!ch) return bad('Canal invalide.')
  if (!/^[A-Z]{3}$/.test(currency)) return bad('Devise invalide (code à 3 lettres).')
  if (!Number.isFinite(price)) return bad('Tarif invalide.')
  const r = await call(P.MARKETING_CONFIGURE, 'marketing_price_set', { p_channel: ch, p_currency: currency, p_unit_price: price })
  return r.ok ? done('Tarif enregistré (il ne s’applique qu’aux estimations, pas à un envoi).') : r.state
}

export async function marketingTemplateCreateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ch = channel(fd)
  if (!ch) return bad('Canal invalide.')
  const r = await call(P.MARKETING_WRITE, 'marketing_template_create', { p_channel: ch, p_name: str(fd, 'name'), p_subject: str(fd, 'subject') || null, p_body: str(fd, 'body') })
  return r.ok ? done('Modèle créé en brouillon. Il doit être approuvé par une autre personne avant usage.') : r.state
}

export async function marketingTemplateApproveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(str(fd, 'id'))
  if (!id.success) return bad('Modèle introuvable.')
  const r = await call(P.MARKETING_WRITE, 'marketing_template_approve', { p_template: id.data })
  return r.ok ? done('Modèle approuvé.') : r.state
}

export async function marketingSegmentCreateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ch = channel(fd)
  if (!ch) return bad('Canal invalide.')
  const ids = fd.getAll('client_ids').map(String).filter((v) => uuid.safeParse(v).success)
  const country = str(fd, 'country').toUpperCase()
  const r = await call(P.MARKETING_WRITE, 'marketing_segment_create', {
    p_name: str(fd, 'name'), p_channel: ch, p_country: country || null, p_client_ids: ids.length ? ids : null,
  })
  return r.ok ? done('Segment enregistré.') : r.state
}

export async function marketingCampaignCreateAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const t = uuid.safeParse(str(fd, 'template_id'))
  const s = uuid.safeParse(str(fd, 'segment_id'))
  if (!t.success || !s.success) return bad('Choisissez un modèle approuvé et un segment.')
  const r = await call(P.MARKETING_WRITE, 'marketing_campaign_create', { p_name: str(fd, 'name'), p_template: t.data, p_segment: s.data })
  return r.ok ? done('Campagne créée en brouillon.') : r.state
}

export async function marketingCampaignPrepareAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(str(fd, 'id'))
  if (!id.success) return bad('Campagne introuvable.')
  const r = await call(P.MARKETING_WRITE, 'marketing_campaign_prepare', { p_campaign: id.data })
  if (!r.ok) return r.state
  const s = r.data as { eligible: number; excluded: Record<string, number> }
  const excl = Object.entries(s.excluded ?? {}).map(([k, v]) => `${v} ${k}`).join(', ')
  return done(`Préparée : ${s.eligible} destinataire(s) éligible(s)${excl ? `, exclus : ${excl}` : ''}. Aucun message n’a été envoyé.`)
}

/** Demande d'envoi : la base renvoie toujours un refus journalisé dans cette version. */
export async function marketingCampaignSendAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = uuid.safeParse(str(fd, 'id'))
  if (!id.success) return bad('Campagne introuvable.')
  const r = await call(P.MARKETING_SEND, 'marketing_campaign_send', { p_campaign: id.data })
  if (!r.ok) return r.state
  const d = r.data as { sent: boolean; reason: string }
  return d.sent ? done('Envoi lancé.') : bad(`Envoi refusé (${d.reason}). Aucun message n’a été envoyé : la politique ou un connecteur homologué manque.`)
}

export async function marketingPhoneAuthorizeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ch = str(fd, 'channel')
  const client = uuid.safeParse(str(fd, 'client_id'))
  if (!client.success) return bad('Choisissez le client.')
  if (ch !== 'sms' && ch !== 'whatsapp') return bad('Canal invalide.')
  const r = await call(P.MARKETING_WRITE, 'marketing_phone_authorize', { p_client: client.data, p_channel: ch, p_phone: str(fd, 'phone'), p_proof: str(fd, 'proof') })
  return r.ok ? done('Consentement enregistré avec sa preuve.') : r.state
}

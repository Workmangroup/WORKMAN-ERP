'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError, purchaseErrorMessage } from '@/features/purchases/errors'

/** Consultations et comparatifs (P033, migration 0058). Les règles (statuts, comparabilité, séparation des tâches) sont appliquées par la base. */

const rev = () => revalidatePath('/purchases', 'layout')
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const numOf = (v: string) => (v === '' ? null : Number(v.replace(',', '.').replace(/\s/g, '')))
const uuid = z.uuid()

async function authorize(perm: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(perm)) {
    await logAccessDenied(ctx, perm, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}
async function dbFail(ctx: AuthContextValue, perm: string, err: { message?: string; code?: string; details?: string | null }): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, perm, { via: 'database' })
  return { ok: false, message: purchaseErrorMessage(err) }
}

export async function createSourcingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({
    title: z.string().trim().min(3, 'Titre : 3 caractères minimum').max(160),
    needed_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date requise').or(z.literal('')).transform((v) => v || null),
  }).safeParse({ title: str(fd, 'title'), needed_date: str(fd, 'needed_date') })
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Saisie invalide.' }
  const lines: { material_id: string; qty: number }[] = []
  for (let i = 0; i < 6; i++) {
    const m = str(fd, `material_${i}`)
    const q = numOf(str(fd, `qty_${i}`))
    if (!m) continue
    if (!uuid.safeParse(m).success || q === null || !Number.isFinite(q) || q <= 0) return { ok: false, message: `Ligne ${i + 1} : composant et quantité positive requis.` }
    lines.push({ material_id: m, qty: q })
  }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('sourcing_event_create', { p_title: parsed.data.title, p_needed: parsed.data.needed_date, p_request: null, p_lines: lines })
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error)
  rev()
  redirect(`/purchases/sourcing/${String(data)}`)
}

export async function openSourcingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(str(fd, 'event_id'))
  const w = [numOf(str(fd, 'weight_price')), numOf(str(fd, 'weight_lead')), numOf(str(fd, 'weight_quality'))]
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  if (w.some((x) => x === null || !Number.isInteger(x))) return { ok: false, message: 'Pondérations : trois nombres entiers requis (total 100).' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('sourcing_event_open', { p_event: id.data, p_wp: w[0], p_wl: w[1], p_wq: w[2] })
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error)
  rev()
  return { ok: true, message: 'Consultation ouverte : les offres peuvent être saisies.' }
}

export async function closeSourcingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(str(fd, 'event_id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('sourcing_event_close', { p_event: id.data })
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error)
  rev()
  return { ok: true, message: 'Consultation clôturée : le comparatif est disponible.' }
}

export async function submitOfferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const ev = uuid.safeParse(str(fd, 'event_id'))
  const sup = uuid.safeParse(str(fd, 'supplier_id'))
  if (!ev.success || !sup.success) return { ok: false, message: 'Choisissez la consultation et le fournisseur.' }
  const lead = numOf(str(fd, 'lead_time_days'))
  const transport = numOf(str(fd, 'transport_amount')) ?? 0
  const duties = numOf(str(fd, 'duties_amount')) ?? 0
  if (lead === null || !Number.isInteger(lead)) return { ok: false, message: 'Délai de livraison : nombre entier de jours requis.' }
  const lines: { event_line_id: string; unit_price: number }[] = []
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith('price_') || typeof v !== 'string') continue
    const p = numOf(v.trim())
    if (p === null) return { ok: false, message: 'Prix unitaire manquant : toutes les lignes de la consultation doivent être chiffrées.' }
    lines.push({ event_line_id: k.slice('price_'.length), unit_price: p })
  }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('sourcing_offer_submit', {
    p_event: ev.data, p_supplier: sup.data, p_currency: str(fd, 'currency').toUpperCase(), p_incoterm: str(fd, 'incoterm') || null,
    p_lead: lead, p_transport: transport, p_duties: duties, p_valid_until: str(fd, 'valid_until') || null,
    p_reference: str(fd, 'source_reference'), p_sha256: str(fd, 'source_sha256').toLowerCase() || null, p_lines: lines,
  })
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error)
  rev()
  return { ok: true, message: `Offre enregistrée : version ${String(data)}. Les versions précédentes sont conservées.` }
}

export async function requestAwardAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PURCHASES_WRITE)
  if ('error' in auth) return auth.error
  const ev = uuid.safeParse(str(fd, 'event_id'))
  const ver = uuid.safeParse(str(fd, 'version_id'))
  if (!ev.success || !ver.success) return { ok: false, message: 'Choisissez l’offre retenue.' }
  const rationale = str(fd, 'rationale')
  const supabase = await createClient()
  const { error } = await supabase.rpc('sourcing_award_request', { p_event: ev.data, p_version: ver.data, p_rationale: rationale })
  if (error) return dbFail(auth.ctx, P.PURCHASES_WRITE, error)
  rev()
  return { ok: true, message: 'Demande d’attribution créée. Elle doit être approuvée par un autre approbateur ; rien n’est attribué avant.' }
}

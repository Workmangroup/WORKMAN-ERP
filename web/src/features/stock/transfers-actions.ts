'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'

/** Transferts inter-entrepôts et stock en transit (P040, migration 0065). Périmètre, quantités, doublons, écarts et séparation des tâches sont appliqués en base ; ici seulement la traduction des erreurs. */
const uuid = z.uuid()
const rev = () => revalidatePath('/stock', 'layout')
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const numOf = (v: string) => (v === '' ? null : Number(v.replace(',', '.').replace(/\s/g, '')))

async function authorize(perm: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(perm)) {
    await logAccessDenied(ctx, perm, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}

const TRANSFER_ERRORS: [string, string][] = [
  ['TRANSFER_SAME_WAREHOUSE', 'Le départ et la destination doivent être deux entrepôts différents.'],
  ['TRANSFER_TRANSIT_RESERVED', 'L’entrepôt transit est réservé au stock en route.'],
  ['TRANSFER_SOURCE_BLOCKED', 'L’emplacement source est en quarantaine : sortie refusée.'],
  ['TRANSFER_EMPTY', 'Aucune ligne de transfert.'],
  ['TRANSFER_BAD_QTY', 'Quantité invalide (positive, et jamais au-delà de la demande).'],
  ['TRANSFER_NOT_FOUND', 'Transfert introuvable.'],
  ['TRANSFER_LINE_NOT_FOUND', 'Ligne de transfert introuvable.'],
  ['TRANSFER_BAD_STATUS', 'Action impossible dans l’état actuel du transfert.'],
  ['TRANSFER_NOTHING_PREPARED', 'Préparez au moins une quantité avant l’expédition.'],
  ['TRANSFER_KEY_REQUIRED', 'Clé de réception invalide : rechargez le formulaire.'],
  ['TRANSFER_PROOF_REQUIRED', 'Référence du bon de transport requise (3 caractères minimum).'],
  ['TRANSFER_DUPLICATE_RECEIPT', 'Cette réception a déjà été enregistrée : aucun mouvement en double.'],
  ['TRANSFER_OVER_RECEIPT', 'Quantité supérieure à ce qui reste en transit (écarts en attente exclus).'],
  ['TRANSFER_REASON_REQUIRED', 'Motif de l’écart requis (5 caractères minimum).'],
  ['TRANSFER_NO_LOSS_PENDING', 'Cet écart a déjà été tranché.'],
  ['SOD_SELF_APPROVAL', 'Vous ne pouvez pas trancher un écart que vous avez déclaré.'],
  ['STOCK_INSUFFICIENT', 'Stock insuffisant au départ pour cette quantité.'],
  ['STOCK_RESERVED', 'Quantité réservée à une commande : expédition refusée.'],
  ['STOCK_WAREHOUSE_NOT_FOUND', 'Entrepôt introuvable (les flux entre sociétés ne sont pas gérés).'],
  ['STOCK_LOCATION_NOT_FOUND', 'Emplacement introuvable dans cet entrepôt.'],
  ['STOCK_LOCATION_ARCHIVED', 'Emplacement archivé.'],
  ['STOCK_MATERIAL_NOT_FOUND', 'Composant introuvable.'],
  ['WAREHOUSE_FORBIDDEN', 'Cet entrepôt ne vous est pas affecté pour cette action.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]
function transferError(err: { message?: string; code?: string }): string {
  const text = `${err.message ?? ''}`
  for (const [k, m] of TRANSFER_ERRORS) if (text.includes(k)) return m
  if (err.code === '42501') return 'Vous n’avez pas la permission d’effectuer cette action.'
  if (err.code === '23505') return 'Cette réception a déjà été enregistrée : aucun mouvement en double.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export async function createTransferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ from_wh: uuid, from_loc: uuid, to_wh: uuid, to_loc: uuid, material_id: uuid }).safeParse({
    from_wh: str(fd, 'from_wh'), from_loc: str(fd, 'from_loc'), to_wh: str(fd, 'to_wh'), to_loc: str(fd, 'to_loc'), material_id: str(fd, 'material_id'),
  })
  if (!parsed.success) return { ok: false, message: 'Entrepôts, emplacements et composant requis.' }
  const qty = numOf(str(fd, 'qty'))
  if (qty == null || !(qty > 0)) return { ok: false, message: 'Quantité positive requise.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_transfer_create', {
    p_from_wh: parsed.data.from_wh, p_from_loc: parsed.data.from_loc, p_to_wh: parsed.data.to_wh, p_to_loc: parsed.data.to_loc,
    p_note: str(fd, 'note') || null, p_lines: [{ material_id: parsed.data.material_id, qty }],
  })
  if (error) return { ok: false, message: transferError(error) }
  rev()
  return { ok: true, message: `Transfert créé (${data ? String(data).slice(0, 8) : 'ok'}). Préparez puis expédiez-le.` }
}

export async function prepareTransferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ transfer_id: uuid }).safeParse({ transfer_id: str(fd, 'transfer_id') })
  if (!parsed.success) return { ok: false, message: 'Transfert introuvable.' }
  let lines: unknown
  try { lines = JSON.parse(str(fd, 'lines')) } catch { return { ok: false, message: 'Lignes de préparation invalides.' } }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_transfer_prepare', { p_transfer: parsed.data.transfer_id, p_lines: lines })
  if (error) return { ok: false, message: transferError(error) }
  rev()
  return { ok: true, message: 'Quantités préparées.' }
}

export async function shipTransferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ transfer_id: uuid }).safeParse({ transfer_id: str(fd, 'transfer_id') })
  if (!parsed.success) return { ok: false, message: 'Transfert introuvable.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_transfer_ship', { p_transfer: parsed.data.transfer_id })
  if (error) return { ok: false, message: transferError(error) }
  rev()
  const res = data as { number: string; qty: number }
  return { ok: true, message: `${res.number} expédié : ${res.qty} en transit.` }
}

export async function receiveTransferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ transfer_id: uuid, line_id: uuid }).safeParse({ transfer_id: str(fd, 'transfer_id'), line_id: str(fd, 'line_id') })
  if (!parsed.success) return { ok: false, message: 'Ligne de transfert introuvable.' }
  const qty = numOf(str(fd, 'qty'))
  if (qty == null || !(qty > 0)) return { ok: false, message: 'Quantité reçue positive requise.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_transfer_receive', {
    p_transfer: parsed.data.transfer_id, p_key: str(fd, 'idem_key'), p_proof: str(fd, 'proof'),
    p_lines: [{ line_id: parsed.data.line_id, qty }],
  })
  if (error) return { ok: false, message: transferError(error) }
  rev()
  const res = data as { status: string; qty: number }
  return { ok: true, message: `${res.qty} reçu(s). Statut : ${res.status === 'received' ? 'reçu' : 'partiellement reçu'}.` }
}

export async function declareLossAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ transfer_id: uuid, line_id: uuid }).safeParse({ transfer_id: str(fd, 'transfer_id'), line_id: str(fd, 'line_id') })
  if (!parsed.success) return { ok: false, message: 'Ligne de transfert introuvable.' }
  const qty = numOf(str(fd, 'qty'))
  if (qty == null || !(qty > 0)) return { ok: false, message: 'Quantité de l’écart positive requise.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_transfer_declare_loss', { p_transfer: parsed.data.transfer_id, p_line: parsed.data.line_id, p_qty: qty, p_reason: str(fd, 'reason') })
  if (error) return { ok: false, message: transferError(error) }
  rev()
  return { ok: true, message: 'Écart déclaré : il sort du transit après accord d’un autre utilisateur.' }
}

export async function decideLossAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_ADJUST)
  if ('error' in auth) return auth.error
  const parsed = z.object({ loss_id: uuid }).safeParse({ loss_id: str(fd, 'loss_id') })
  if (!parsed.success) return { ok: false, message: 'Écart introuvable.' }
  const approve = str(fd, 'approve') === 'true'
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_transfer_decide_loss', { p_loss: parsed.data.loss_id, p_approve: approve })
  if (error) return { ok: false, message: transferError(error) }
  rev()
  return { ok: true, message: approve ? 'Écart approuvé : sorti du transit.' : 'Écart refusé : la marchandise reste en transit.' }
}

export async function cancelTransferAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ transfer_id: uuid }).safeParse({ transfer_id: str(fd, 'transfer_id') })
  if (!parsed.success) return { ok: false, message: 'Transfert introuvable.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_transfer_cancel', { p_transfer: parsed.data.transfer_id })
  if (error) return { ok: false, message: transferError(error) }
  rev()
  return { ok: true, message: 'Transfert annulé : aucun stock sorti.' }
}

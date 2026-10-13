'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'

/** Préparation : règle FIFO/FEFO, listes de prélèvement, scan de lot, substitution soumise à accord (P039, migration 0064).
 *  Les règles (échéance, quarantaine, quantité, séparation des tâches, scope entrepôt) sont appliquées en base ; ici seulement la traduction des erreurs. */
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

const PICK_ERRORS: [string, string][] = [
  ['PICK_SHORT', 'Disponible insuffisant : les lots échus, bloqués ou réservés ne sont pas comptés.'],
  ['PICK_BAD_QTY', 'Quantité à préparer invalide.'],
  ['PICK_NOT_SCANNED', 'Scannez le code de chaque lot avant de confirmer la liste.'],
  ['PICK_SUBSTITUTION_PENDING', 'Une substitution attend un accord : tranchez-la avant de continuer.'],
  ['PICK_NO_SUBSTITUTION', 'Aucune substitution en attente sur cette ligne.'],
  ['PICK_REASON_REQUIRED', 'Motif de substitution : 5 caractères minimum.'],
  ['PICK_SUBSTITUTE_INVALID', 'Lot de remplacement invalide (identique au lot prévu).'],
  ['PICK_BAD_STATUS', 'Cette liste est déjà confirmée ou annulée.'],
  ['PICK_NOT_FOUND', 'Liste de prélèvement introuvable.'],
  ['PICK_LINE_NOT_FOUND', 'Ligne de prélèvement introuvable.'],
  ['PICK_LOT_NOT_FOUND', 'Lot introuvable.'],
  ['PICK_LOT_MISMATCH', 'Ce lot n’appartient pas à la matière ou à l’entrepôt de la liste.'],
  ['LOT_EXPIRED_AT_RECEIPT', 'Lot déjà échu : réception refusée.'],
  ['LOT_EXPIRY_MISMATCH', 'Ce code de lot existe déjà avec une autre date d’expiration.'],
  ['LOT_CODE_REQUIRED', 'Code de lot requis (2 caractères minimum).'],
  ['LOT_EXPIRED', 'Lot échu : sortie refusée.'],
  ['LOT_BLOCKED', 'Lot en quarantaine (bloqué qualité) : sortie refusée.'],
  ['STOCK_INSUFFICIENT', 'Quantité insuffisante dans le lot.'],
  ['STOCK_RESERVED', 'Quantité réservée à une commande : sortie refusée.'],
  ['STOCK_EXIT_RULE_INVALID', 'Règle de sortie invalide (fifo ou fefo).'],
  ['SOD_SELF_APPROVAL', 'Vous ne pouvez pas approuver votre propre demande de substitution.'],
  ['WAREHOUSE_FORBIDDEN', 'Cet entrepôt ne vous est pas affecté.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]
function pickError(err: { message?: string; code?: string }): string {
  const text = `${err.message ?? ''}`
  for (const [k, m] of PICK_ERRORS) if (text.includes(k)) return m
  if (err.code === '42501') return 'Vous n’avez pas la permission d’effectuer cette action.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export async function setExitRuleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_ADJUST)
  if ('error' in auth) return auth.error
  const rule = str(fd, 'rule')
  if (rule !== 'fifo' && rule !== 'fefo') return { ok: false, message: 'Règle invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_exit_policy_set', { p_rule: rule })
  if (error) return { ok: false, message: pickError(error) }
  rev()
  return { ok: true, message: rule === 'fefo' ? 'Sortie au plus tôt à échéance (FEFO) activée.' : 'Sortie première entrée (FIFO) activée.' }
}

export async function createPickAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ material_id: uuid, warehouse_id: uuid }).safeParse({ material_id: str(fd, 'material_id'), warehouse_id: str(fd, 'warehouse_id') })
  if (!parsed.success) return { ok: false, message: 'Composant et entrepôt requis.' }
  const qty = numOf(str(fd, 'qty'))
  if (qty == null || !(qty > 0)) return { ok: false, message: 'Quantité positive requise.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_pick_create', {
    p_material: parsed.data.material_id, p_warehouse: parsed.data.warehouse_id, p_qty: qty, p_note: str(fd, 'note') || null,
  })
  if (error) return { ok: false, message: pickError(error) }
  rev()
  return { ok: true, message: `Liste de prélèvement créée (${data ? 'identifiant ' + String(data).slice(0, 8) : 'ok'}). Scannez chaque lot avant confirmation.` }
}

export async function scanLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ line_id: uuid }).safeParse({ line_id: str(fd, 'line_id') })
  if (!parsed.success) return { ok: false, message: 'Ligne introuvable.' }
  const code = str(fd, 'code')
  if (!code) return { ok: false, message: 'Scannez ou saisissez le code du lot.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_pick_scan', { p_line: parsed.data.line_id, p_code: code })
  if (error) return { ok: false, message: pickError(error) }
  rev()
  const res = data as { ok: boolean; expected?: string; scanned?: string }
  if (!res.ok) return { ok: false, message: `Scan erroné : attendu « ${res.expected ?? '—'} », scanné « ${res.scanned ?? ''} ». L’erreur est enregistrée.` }
  return { ok: true, message: 'Lot confirmé.' }
}

export async function requestSubstitutionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ line_id: uuid, lot_id: uuid }).safeParse({ line_id: str(fd, 'line_id'), lot_id: str(fd, 'lot_id') })
  if (!parsed.success) return { ok: false, message: 'Ligne et lot de remplacement requis.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_pick_request_substitution', { p_line: parsed.data.line_id, p_lot: parsed.data.lot_id, p_reason: str(fd, 'reason') })
  if (error) return { ok: false, message: pickError(error) }
  rev()
  return { ok: true, message: 'Substitution soumise à accord. Un autre utilisateur doit l’approuver.' }
}

export async function decideSubstitutionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_ADJUST)
  if ('error' in auth) return auth.error
  const parsed = z.object({ line_id: uuid }).safeParse({ line_id: str(fd, 'line_id') })
  if (!parsed.success) return { ok: false, message: 'Ligne introuvable.' }
  const approve = str(fd, 'approve') === 'true'
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_pick_decide_substitution', { p_line: parsed.data.line_id, p_approve: approve })
  if (error) return { ok: false, message: pickError(error) }
  rev()
  return { ok: true, message: approve ? 'Substitution approuvée : scannez le nouveau lot.' : 'Substitution refusée : le lot prévu reste à sortir.' }
}

export async function confirmPickAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ pick_id: uuid }).safeParse({ pick_id: str(fd, 'pick_id') })
  if (!parsed.success) return { ok: false, message: 'Liste introuvable.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_pick_confirm', { p_pick: parsed.data.pick_id })
  if (error) return { ok: false, message: pickError(error) }
  rev()
  const res = data as { pick: string; lines: number; qty: number }
  return { ok: true, message: `${res.pick} confirmée : ${res.lines} lot(s), ${res.qty} sorti(s).` }
}

export async function cancelPickAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ pick_id: uuid }).safeParse({ pick_id: str(fd, 'pick_id') })
  if (!parsed.success) return { ok: false, message: 'Liste introuvable.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('stock_pick_cancel', { p_pick: parsed.data.pick_id })
  if (error) return { ok: false, message: pickError(error) }
  rev()
  return { ok: true, message: 'Liste annulée : aucun stock sorti.' }
}

const SCAN_MESSAGES: Record<string, string> = {
  SCAN_WRONG_LOT: 'Mauvais lot pour cette ligne.', SCAN_WRONG_LOCATION: 'Mauvais emplacement pour cette ligne.',
  SCAN_KEY_REQUIRED: 'Scan incomplet : rechargez la ligne et recommencez.', PICK_SUBSTITUTION_PENDING: 'Une substitution attend un accord : scan impossible.',
  PICK_BAD_STATUS: 'Cette liste n’est plus ouverte.', PICK_LINE_NOT_FOUND: 'Ligne de prélèvement introuvable.',
}

/** Picking mobile : lot ET emplacement scannés ; mauvais lot ou emplacement refusés ; rejeu de la même clé sans effet (0067). */
export async function mobilePickScanAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ line_id: uuid }).safeParse({ line_id: str(fd, 'line_id') })
  if (!parsed.success) return { ok: false, message: 'Ligne introuvable.' }
  const lot = str(fd, 'lot_code')
  const loc = str(fd, 'location_code')
  if (!lot || !loc) return { ok: false, message: 'Scannez le lot ET l’emplacement.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('mob_pick_scan', { p_line: parsed.data.line_id, p_lot_code: lot, p_location_code: loc, p_scan_key: str(fd, 'scan_key') })
  if (error) return { ok: false, message: SCAN_MESSAGES[error.message.trim()] ?? pickError(error) }
  rev()
  const res = data as { ok: boolean; message?: string; expected?: string | null }
  if (!res.ok) return { ok: false, message: res.expected ? `${res.message ?? 'Refusé.'} Attendu : « ${res.expected} ».` : (res.message ?? 'Refusé.') }
  return { ok: true, message: res.message ?? 'Enregistré.' }
}

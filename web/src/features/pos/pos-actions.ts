'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/** Point de vente (0092) : chaque action appelle une fonction SQL qui revérifie droits, état et montants. */

const MESSAGES: [string, string][] = [
  ['RBAC_FORBIDDEN', 'Droit insuffisant pour cette action.'],
  ['SOD_SELF_APPROVAL', 'Action refusée : elle doit être faite par une autre personne que le clôturant.'],
  ['POS_BAD_WAREHOUSE', 'La caisse doit être rattachée à un entrepôt de type boutique.'],
  ['POS_FLOAT_REQUIRED', 'Le fonds de caisse est obligatoire à l’ouverture.'],
  ['POS_SESSION_ALREADY_OPEN', 'Cette caisse a déjà une session ouverte.'],
  ['POS_SESSION_CLOSED', 'Session close : aucune écriture possible.'],
  ['POS_PAYMENT_MISMATCH', 'La somme des paiements doit égaler le total du ticket.'],
  ['POS_VARIANT_NOT_SALEABLE', 'Article non vendable : inactif ou sans prix.'],
  ['POS_CURRENCY_NOT_BASE', 'Article dans une devise autre que la devise de base : non vendable en caisse.'],
  ['POS_BAD_VAT', 'Code de TVA inconnu ou non validé à la date.'],
  ['POS_BAD_METHOD', 'Mode de paiement inconnu ou inactif.'],
  ['POS_REFUND_NOT_ALLOWED', 'Ce ticket contient un mode de paiement non remboursable.'],
  ['POS_ALREADY_REVERSED', 'Ce ticket a déjà été annulé.'],
  ['POS_REASON_REQUIRED', 'Motif obligatoire (5 caractères minimum).'],
  ['POS_COUNT_MISSING', 'Chaque mode de paiement concerné doit être compté.'],
  ['POS_COUNT_UNKNOWN_METHOD', 'Un mode compté ne fait pas partie de la session.'],
  ['POS_VISA_NOT_REQUIRED', 'Visa inutile : aucun écart sur cette session, ou déjà visée.'],
  ['POS_DEPOSIT_EXCEEDS_CASH', 'Dépôt supérieur aux espèces comptées.'],
  ['POS_NOT_FOUND', 'Élément introuvable dans cette société.'],
  ['VARIANT_STOCK_INSUFFICIENT', 'Stock magasin insuffisant pour cette vente.'],
  ['WAREHOUSE_FORBIDDEN', 'Accès refusé à cet entrepôt.'],
  ['check constraint', 'Valeur hors des bornes autorisées.'],
  ['duplicate key', 'Valeur déjà utilisée.'],
]

async function run(fn: string, args: Record<string, unknown>, okMessage: string): Promise<FormState> {
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) {
    const hit = MESSAGES.find(([code]) => error.message.includes(code))
    return { ok: false, message: hit?.[1] ?? 'Action impossible.' }
  }
  revalidatePath('/stock/caisse')
  return { ok: true, message: okMessage }
}

const uuid = z.string().uuid()
const money = z.coerce.number().min(0)

export async function posRegisterCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const wh = uuid.safeParse(fd.get('warehouse'))
  const code = z.string().regex(/^[A-Z0-9_-]{2,20}$/).safeParse(fd.get('code'))
  const label = z.string().trim().min(2).max(80).safeParse(fd.get('label'))
  if (!wh.success || !code.success || !label.success) return { ok: false, message: 'Boutique, code et libellé obligatoires.' }
  return run('pos_register_create', { p_warehouse: wh.data, p_code: code.data, p_label: label.data }, 'Caisse créée.')
}

export async function posMethodCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const code = z.string().regex(/^[A-Z0-9_]{2,20}$/).safeParse(fd.get('code'))
  const label = z.string().trim().min(2).max(60).safeParse(fd.get('label'))
  const kind = z.enum(['cash', 'card', 'cheque', 'transfer', 'other']).safeParse(fd.get('kind'))
  if (!code.success || !label.success || !kind.success) return { ok: false, message: 'Code, libellé et nature obligatoires.' }
  return run('pos_payment_method_create', { p_code: code.data, p_label: label.data, p_kind: kind.data, p_refund_allowed: fd.get('refund') === 'on' },
    'Mode de paiement créé.')
}

export async function posSessionOpenAction(_p: FormState, fd: FormData): Promise<FormState> {
  const reg = uuid.safeParse(fd.get('register'))
  const float = money.safeParse(fd.get('float'))
  if (!reg.success || !float.success) return { ok: false, message: 'Caisse et fonds de caisse obligatoires.' }
  return run('pos_session_open', { p_register: reg.data, p_float: float.data }, 'Session ouverte.')
}

export async function posTicketCreateAction(_p: FormState, fd: FormData): Promise<FormState> {
  const session = uuid.safeParse(fd.get('session'))
  let lines: unknown
  let payments: unknown
  try { lines = JSON.parse(String(fd.get('lines') ?? '')); payments = JSON.parse(String(fd.get('payments') ?? '')) }
  catch { return { ok: false, message: 'Lignes ou paiements : JSON invalide.' } }
  const L = z.array(z.object({ variant: uuid, qty: z.coerce.number().int().positive(), vat_code: z.string().min(3).max(30) })).min(1).safeParse(lines)
  const P = z.array(z.object({ method: uuid, amount: z.coerce.number().positive() })).min(1).safeParse(payments)
  if (!session.success || !L.success || !P.success) return { ok: false, message: 'Session, lignes [{variant, qty, vat_code}] et paiements [{method, amount}] obligatoires.' }
  return run('pos_ticket_create', { p_session: session.data, p_lines: L.data, p_payments: P.data }, 'Ticket enregistré : stock magasin sorti.')
}

export async function posTicketReverseAction(_p: FormState, fd: FormData): Promise<FormState> {
  const t = uuid.safeParse(fd.get('ticket'))
  const reason = z.string().trim().min(5).max(300).safeParse(fd.get('reason'))
  if (!t.success || !reason.success) return { ok: false, message: 'Ticket et motif (5 caractères minimum) obligatoires.' }
  return run('pos_ticket_reverse', { p_ticket: t.data, p_reason: reason.data }, 'Ticket annulé par contre-passation ; stock rendu.')
}

export async function posSessionCloseAction(_p: FormState, fd: FormData): Promise<FormState> {
  const session = uuid.safeParse(fd.get('session'))
  let counts: unknown
  try { counts = JSON.parse(String(fd.get('counts') ?? '')) } catch { return { ok: false, message: 'Comptage : JSON invalide.' } }
  const C = z.array(z.object({ method: uuid, counted: money })).min(1).safeParse(counts)
  if (!session.success || !C.success) return { ok: false, message: 'Session et comptage [{method, counted}] obligatoires.' }
  return run('pos_session_close', { p_session: session.data, p_counts: C.data }, 'Session clôturée : écart affiché.')
}

export async function posSessionVisaAction(_p: FormState, fd: FormData): Promise<FormState> {
  const session = uuid.safeParse(fd.get('session'))
  const note = z.string().trim().min(5).max(300).safeParse(fd.get('note'))
  if (!session.success || !note.success) return { ok: false, message: 'Session et motif du visa (5 caractères minimum) obligatoires.' }
  return run('pos_session_visa', { p_session: session.data, p_note: note.data }, 'Visa enregistré.')
}

export async function posDepositAction(_p: FormState, fd: FormData): Promise<FormState> {
  const session = uuid.safeParse(fd.get('session'))
  const amount = z.coerce.number().positive().safeParse(fd.get('amount'))
  const ref = z.string().trim().min(3).max(80).safeParse(fd.get('reference'))
  if (!session.success || !amount.success || !ref.success) return { ok: false, message: 'Session, montant et référence du dépôt obligatoires.' }
  return run('pos_deposit_record', { p_session: session.data, p_amount: amount.data, p_reference: ref.data }, 'Dépôt enregistré.')
}

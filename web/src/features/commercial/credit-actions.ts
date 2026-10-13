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

/** Crédit, marge et stock : les règles (plafond, dérogation bornée, prix sous coût, séparation des tâches, stock libre) sont dans 0053. */

const uuid = z.uuid()
const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const num = (fd: FormData, k: string) => {
  const v = str(fd, k).replace(',', '.')
  return v === '' ? null : Number(v)
}

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
  revalidatePath('/commercial/credit')
  return { ok: true, message: done }
}

const bad = (message: string): FormState => ({ ok: false, message })

export async function marginPolicySetAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const raw = str(fd, 'min_margin_pct')
  const v = raw === '' ? null : num(fd, 'min_margin_pct')
  if (v !== null && (!Number.isFinite(v) || v < 0 || v > 99.99)) return bad('Minimum de marge : entre 0 et 99,99 %, ou vide pour ne pas contrôler.')
  return run(P.FINANCE_WRITE, 'margin_policy_set', { p_min_margin_pct: v }, v === null ? 'Contrôle de marge désactivé.' : `Marge minimale enregistrée : ${v} %.`)
}

export async function variantCostSetAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = uuid.safeParse(str(fd, 'variant_id'))
  const cost = num(fd, 'unit_cost')
  const currency = str(fd, 'currency').toUpperCase()
  if (!v.success) return bad('Variante introuvable.')
  if (cost === null || !Number.isFinite(cost) || cost < 0) return bad('Coût unitaire positif ou nul requis.')
  if (!/^[A-Z]{3}$/.test(currency)) return bad('Devise invalide.')
  return run(P.COSTS_READ, 'variant_cost_set', { p_variant: v.data, p_unit_cost: cost, p_currency: currency }, 'Coût enregistré (ajout daté).')
}

export async function stockBlockAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = uuid.safeParse(str(fd, 'variant_id'))
  const w = uuid.safeParse(str(fd, 'warehouse_id'))
  const qty = Math.trunc(num(fd, 'qty') ?? 0)
  if (!v.success || !w.success) return bad('Variante et entrepôt requis.')
  return run(P.QUALITY_WRITE, 'stock_block', { p_variant: v.data, p_warehouse: w.data, p_qty: qty, p_reason: str(fd, 'reason') }, 'Stock bloqué : il n’est plus promis.')
}

export async function stockBlockReleaseAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const b = uuid.safeParse(str(fd, 'block_id'))
  if (!b.success) return bad('Blocage introuvable.')
  return run(P.QUALITY_APPROVE, 'stock_block_release', { p_block: b.data, p_reason: str(fd, 'reason') }, 'Blocage levé (par une autre personne que son auteur).')
}

export async function creditDerogationRequestAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const c = uuid.safeParse(str(fd, 'client_id'))
  const max = num(fd, 'max_amount')
  const until = str(fd, 'valid_until')
  if (!c.success) return bad('Client introuvable.')
  if (max === null || !Number.isFinite(max) || max <= 0) return bad('Dépassement autorisé : montant positif requis.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return bad('Date de fin de validité requise.')
  return run(P.DEROGATIONS_REQUEST, 'credit_derogation_request', { p_client: c.data, p_max_amount: max, p_motive: str(fd, 'motive'), p_valid_until: until },
    'Dérogation demandée : elle doit être approuvée puis contrôlée par deux autres personnes.')
}

'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getAuthContext } from '@/features/auth/services/access.service'
import { classifyCode } from '@/lib/field/logic'

/** Actions terrain : une seule action par geste, appels directs aux fonctions SQL existantes (droits contrôlés en base). */

export type FieldResult = { ok: true; message?: string; href?: string } | { ok: false; message: string }

const MSG: [string, string][] = [
  ['PRODUCTION_BAD_STATUS', 'Cet ordre n’est pas dans un état qui permet cette action.'],
  ['PRODUCTION_QTY_EXCEEDED', 'Le total saisi dépasse la quantité de l’ordre.'],
  ['PRODUCTION_BAD_DATE', 'Date de saisie non valable.'],
  ['PRODUCTION_NO_LOG', 'Saisissez d’abord le suivi avant de terminer.'],
  ['PRODUCTION_WORK_CENTER_REQUIRED', 'Affectez d’abord un poste à l’ordre.'],
  ['PRODUCTION_REASON_REQUIRED', 'Indiquez la raison de la suspension.'],
  ['QUALITY_BAD_STATUS', 'Ce contrôle est déjà décidé.'],
  ['QUALITY_DEFECT_CODE_NOT_FOUND', 'Ce défaut n’existe pas dans le référentiel.'],
  ['QUALITY_DECISION_NOT_ALLOWED', 'Un défaut majeur interdit l’acceptation pleine.'],
  ['QUALITY_CRITICAL_DEFECT', 'Un défaut critique impose le rejet.'],
  ['SHIPPING_QTY_EXCEEDS_LINE', 'Quantité supérieure à celle demandée.'],
  ['SHIPPING_STOCK_INSUFFICIENT', 'Stock disponible insuffisant pour ce prélèvement.'],
  ['SHIPPING_BAD_STATUS', 'Cette expédition n’est plus en préparation.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission pour cette action.'],
]
const msg = (e: { message?: string; details?: string | null }) => {
  const t = `${e.message ?? ''} ${e.details ?? ''}`
  return MSG.find(([k]) => t.includes(k))?.[1] ?? 'Action impossible. Réessayez dans un instant.'
}

async function auth() {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  return ctx
}
const today = () => new Date().toISOString().slice(0, 10)
const uuid = z.uuid()

/** Scan : résout un code vers l'écran qui le concerne (OF, contrôle, expédition, variante). */
export async function resolveCodeAction(raw: string): Promise<FieldResult> {
  await auth()
  const code = raw.trim().toUpperCase()
  const kind = classifyCode(code)
  const supabase = await createClient()
  if (kind === 'of') {
    const { data } = await supabase.from('production_orders').select('id').eq('number', code).maybeSingle()
    return data ? { ok: true, href: `/atelier/of/${data.id}` } : { ok: false, message: 'OF introuvable pour votre société.' }
  }
  if (kind === 'inspection') {
    const { data } = await supabase.from('quality_inspections').select('id').eq('number', code).maybeSingle()
    return data ? { ok: true, href: `/atelier/controles/${data.id}` } : { ok: false, message: 'Contrôle introuvable.' }
  }
  if (kind === 'shipment') {
    const { data } = await supabase.from('shipments').select('id').or(`number.eq.${code},bl_number.eq.${code}`).maybeSingle()
    return data ? { ok: true, href: `/atelier/picking/${data.id}` } : { ok: false, message: 'Expédition introuvable.' }
  }
  if (kind === 'variant') {
    const { data } = await supabase.from('product_variants').select('product_id').eq('sku', code).maybeSingle()
    return data ? { ok: true, href: `/variants/${(data as { product_id: string }).product_id}` } : { ok: false, message: 'Article introuvable.' }
  }
  return { ok: false, message: 'Code non reconnu. Vérifiez la saisie ou scannez à nouveau.' }
}

export async function logOfAction(orderId: string, good: number, scrap: number, hours: number): Promise<FieldResult> {
  await auth()
  const parsed = z.object({ id: uuid, g: z.number().min(0).max(1e6), s: z.number().min(0).max(1e6), h: z.number().gt(0).max(24) })
    .safeParse({ id: orderId, g: good, s: scrap, h: hours })
  if (!parsed.success || parsed.data.g + parsed.data.s <= 0) return { ok: false, message: 'Saisissez au moins une pièce bonne ou rebutée, et les heures.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('production_order_log', { p_order: orderId, p_date: today(), p_hours: hours, p_good: good, p_scrap: scrap, p_note: null })
  if (error) return { ok: false, message: msg(error) }
  revalidatePath('/atelier', 'layout')
  return { ok: true, message: `Enregistré : ${good} bonne(s), ${scrap} rebut.` }
}

export async function ofStepAction(orderId: string, step: 'launch' | 'resume' | 'finish' | 'suspend', reason?: string): Promise<FieldResult> {
  await auth()
  if (!uuid.safeParse(orderId).success) return { ok: false, message: 'Ordre invalide.' }
  const supabase = await createClient()
  const { error } = step === 'suspend'
    ? await supabase.rpc('production_order_suspend', { p_order: orderId, p_reason: reason ?? 'Arrêt atelier' })
    : await supabase.rpc(`production_order_${step}`, { p_order: orderId })
  if (error) return { ok: false, message: msg(error) }
  revalidatePath('/atelier', 'layout')
  const label = { launch: 'Ordre lancé.', resume: 'Ordre repris.', finish: 'Ordre terminé.', suspend: 'Ordre suspendu.' }[step]
  return { ok: true, message: label }
}

export async function addDefectAction(inspectionId: string, code: string, qty: number): Promise<FieldResult> {
  await auth()
  if (!uuid.safeParse(inspectionId).success || qty <= 0) return { ok: false, message: 'Défaut invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('quality_defect_add', { p_inspection: inspectionId, p_code: code, p_qty: qty, p_severity: null, p_note: null })
  if (error) return { ok: false, message: msg(error) }
  revalidatePath('/atelier', 'layout')
  return { ok: true, message: `${code} : ${qty} enregistré.` }
}

export async function decideAction(inspectionId: string, decision: 'accepted' | 'conditional' | 'rejected'): Promise<FieldResult> {
  await auth()
  if (!uuid.safeParse(inspectionId).success) return { ok: false, message: 'Contrôle invalide.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('quality_inspection_decide', { p_inspection: inspectionId, p_decision: decision, p_note: null })
  if (error) return { ok: false, message: msg(error) }
  revalidatePath('/atelier', 'layout')
  const nc = (data as { nc_number?: string | null } | null)?.nc_number
  return { ok: true, message: nc ? `Rejeté : non-conformité ${nc} ouverte.` : 'Décision enregistrée.' }
}

export async function pickAction(lineId: string, qty: number): Promise<FieldResult> {
  await auth()
  if (!uuid.safeParse(lineId).success || qty <= 0) return { ok: false, message: 'Quantité invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('shipment_pick', { p_line: lineId, p_qty: qty })
  if (error) return { ok: false, message: msg(error) }
  revalidatePath('/atelier', 'layout')
  return { ok: true, message: `${qty} prélevée(s).` }
}

'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'

/** Unités physiques et lots (P037, migration 0062). Périmètre entrepôt et règles de propriété appliqués en base. */
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
const UNIT_ERRORS: [string, string][] = [
  ['WAREHOUSE_FORBIDDEN', 'Cet entrepôt ne vous est pas affecté.'],
  ['UNIT_LENGTH_REQUIRED', 'Un tissu se reçoit avec sa longueur (en mètres).'],
  ['UNIT_LENGTH_NOT_APPLICABLE', 'Une pièce non mesurée se reçoit sans longueur.'],
  ['UNIT_LOT_INVALID', 'Lot introuvable pour cette matière.'],
  ['UNIT_OWNER_MISMATCH', 'Le propriétaire doit être celui du lot.'],
  ['UNIT_NOT_AVAILABLE', 'Unité non disponible : en quarantaine ou déjà consommée.'],
  ['UNIT_DEFECT_LENGTH_INVALID', 'La longueur touchée dépasse la longueur de l’unité.'],
  ['UNIT_DEFECT_INVALID', 'Gravité de défaut invalide.'],
  ['UNIT_NOT_FOUND', 'Unité introuvable.'],
  ['STOCK_LOCATION_NOT_FOUND', 'Emplacement introuvable dans cet entrepôt.'],
  ['STOCK_MATERIAL_NOT_FOUND', 'Composant introuvable.'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]
function unitError(err: { message?: string; code?: string }): string {
  const text = `${err.message ?? ''}`
  for (const [k, m] of UNIT_ERRORS) if (text.includes(k)) return m
  if (err.code === '42501') return 'Vous n’avez pas la permission d’effectuer cette action.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export async function receiveUnitAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ material_id: uuid, lot_id: uuid, warehouse_id: uuid, location_id: uuid }).safeParse({
    material_id: str(fd, 'material_id'), lot_id: str(fd, 'lot_id'), warehouse_id: str(fd, 'warehouse_id'), location_id: str(fd, 'location_id'),
  })
  if (!parsed.success) return { ok: false, message: 'Composant, lot, entrepôt et emplacement requis.' }
  const length = numOf(str(fd, 'length_m'))
  const width = numOf(str(fd, 'width_cm'))
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('material_unit_receive', {
    p_material: parsed.data.material_id, p_lot: parsed.data.lot_id, p_warehouse: parsed.data.warehouse_id, p_location: parsed.data.location_id,
    p_length: length, p_width: width, p_dye_bath: str(fd, 'dye_bath') || null, p_owner: null, p_reference: str(fd, 'reference') || null,
  })
  if (error) return { ok: false, message: unitError(error) }
  rev()
  return { ok: true, message: `Unité reçue : ${String(data).slice(0, 8)}…` }
}

export async function defectUnitAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(str(fd, 'unit_id'))
  if (!id.success) return { ok: false, message: 'Unité invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('material_unit_defect_record', {
    p_unit: id.data, p_code: str(fd, 'code'), p_severity: str(fd, 'severity'), p_description: str(fd, 'description'), p_length_affected: numOf(str(fd, 'length_affected_m')),
  })
  if (error) return { ok: false, message: unitError(error) }
  rev()
  return { ok: true, message: 'Défaut enregistré dans l’historique de l’unité.' }
}

export async function consumeUnitAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.STOCK_WRITE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(str(fd, 'unit_id'))
  if (!id.success) return { ok: false, message: 'Unité invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('material_unit_consume', { p_unit: id.data, p_reference: str(fd, 'reference') || null })
  if (error) return { ok: false, message: unitError(error) }
  rev()
  return { ok: true, message: 'Unité consommée.' }
}

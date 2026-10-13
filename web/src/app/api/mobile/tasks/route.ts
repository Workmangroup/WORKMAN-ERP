import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'

/**
 * API mobile des tâches entrepôt (P042, migration 0067). Authentification par la session Supabase de l'utilisateur (cookies) ;
 * droits et périmètre entrepôt appliqués en base. Les refus métier reviennent en 200 avec ok=false (code, message, sound) ;
 * les refus de droit reviennent en 403. Authentification par jeton « bearer » pour applications natives : non implémentée.
 */
const uuid = z.uuid()
const scanKey = z.string().trim().min(8).max(80)
const body = z.discriminatedUnion('task', [
  z.object({ task: z.literal('resolve'), code: z.string().trim().min(1).max(60) }),
  z.object({ task: z.literal('pick'), line_id: uuid, lot_code: z.string().trim().min(1).max(40), location_code: z.string().trim().min(1).max(30), scan_key: scanKey }),
  z.object({ task: z.literal('receive'), transfer_id: uuid, material_code: z.string().trim().min(1).max(40), location_code: z.string().trim().min(1).max(30),
    qty: z.number().positive(), proof: z.string().trim().max(120).optional(), scan_key: scanKey }),
  z.object({ task: z.literal('count'), line_id: uuid, material_code: z.string().trim().min(1).max(40), location_code: z.string().trim().min(1).max(30),
    qty: z.number().min(0), scan_key: scanKey }),
])

const FORBIDDEN = /RBAC_FORBIDDEN|WAREHOUSE_FORBIDDEN/

export async function POST(req: Request) {
  let json: unknown
  try { json = await req.json() } catch { return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Requête invalide.' }, { status: 400 }) }
  const parsed = body.safeParse(json)
  if (!parsed.success) return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Champs manquants ou invalides.' }, { status: 400 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, code: 'UNAUTHENTICATED', message: 'Session expirée.' }, { status: 401 })
  const b = parsed.data
  const call = b.task === 'resolve'
    ? supabase.rpc('scan_resolve', { p_code: b.code })
    : b.task === 'pick'
      ? supabase.rpc('mob_pick_scan', { p_line: b.line_id, p_lot_code: b.lot_code, p_location_code: b.location_code, p_scan_key: b.scan_key })
      : b.task === 'receive'
        ? supabase.rpc('mob_transfer_receive_scan', { p_transfer: b.transfer_id, p_material_code: b.material_code, p_location_code: b.location_code, p_qty: b.qty, p_proof: b.proof ?? null, p_scan_key: b.scan_key })
        : supabase.rpc('mob_count_scan', { p_line: b.line_id, p_material_code: b.material_code, p_location_code: b.location_code, p_qty: b.qty, p_scan_key: b.scan_key })
  const { data, error } = await call
  if (error) {
    const msg = `${error.message ?? ''}`.trim()
    if (FORBIDDEN.test(msg) || error.code === '42501') return NextResponse.json({ ok: false, code: 'FORBIDDEN', message: 'Droit insuffisant pour cette action.' }, { status: 403 })
    return NextResponse.json({ ok: false, code: msg.split(/\s/)[0] || 'ERROR', message: 'Action refusée.' }, { status: 400 })
  }
  return NextResponse.json(data)
}

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin'
import { verifyCarrierSignature } from '@/lib/carrier/webhook'

export const dynamic = 'force-dynamic'

const event = z.object({
  carrier: z.string().trim().min(2).max(20),
  event_id: z.string().trim().min(1).max(200),
  tracking_number: z.string().trim().min(4).max(80),
  event_code: z.enum(['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned']),
  occurred_at: z.iso.datetime(),
  location: z.string().trim().max(120).nullable().optional(),
  detail: z.string().trim().max(300).nullable().optional(),
})

/**
 * Webhook transporteur. En-têtes : x-timestamp (secondes Unix) et x-signature (sha256=<hex> de « timestamp.corps »).
 * Rejeu : un horodatage hors fenêtre (± 5 min) est refusé ; un même identifiant d'événement renvoie « duplicate » sans effet,
 * un contenu différent sous le même identifiant renvoie « conflict ». Un événement reçu dont l'application échoue reste
 * journalisé « en échec » et est rejoué par le serveur (carrier_events_replay) : la réponse est alors 202.
 * Sans secret, sans société configurée ou sans clé serveur : 503 (aucun traitement).
 */
export async function POST(request: Request) {
  const secret = process.env.CARRIER_WEBHOOK_SECRET
  const companyId = process.env.CARRIER_COMPANY_ID
  if (!secret || !companyId || !hasServiceRole()) return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 })

  const raw = await request.text()
  const check = verifyCarrierSignature({
    secret,
    timestampHeader: request.headers.get('x-timestamp'),
    signatureHeader: request.headers.get('x-signature'),
    raw,
    nowSeconds: Math.floor(Date.now() / 1000),
  })
  if (!check.ok) return NextResponse.json({ error: check.code }, { status: 401 })

  let body: unknown
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 }) }
  const parsed = event.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 })
  const e = parsed.data

  const digest = createHash('sha256').update(raw).digest('hex')
  const { data, error } = await createAdminClient().rpc('carrier_ingest', {
    p_company: companyId, p_carrier_code: e.carrier, p_provider_event_id: e.event_id, p_tracking: e.tracking_number,
    p_event_code: e.event_code, p_occurred_at: e.occurred_at, p_location: e.location ?? null, p_detail: e.detail ?? null,
    p_payload_sha256: digest,
  })
  if (error) return NextResponse.json({ error: 'REJECTED' }, { status: 400 })

  const result = data as { result: 'accepted' | 'duplicate' | 'conflict' | 'refused'; status?: string; code?: string }
  if (result.result === 'conflict') return NextResponse.json({ error: result.code ?? 'CARRIER_EVENT_CONFLICT' }, { status: 409 })
  if (result.result === 'refused') return NextResponse.json({ error: result.code ?? 'REFUSED' }, { status: 422 })
  if (result.result === 'accepted' && result.status === 'failed') return NextResponse.json({ result }, { status: 202 })
  return NextResponse.json({ result }, { status: 200 })
}

import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const event = z.object({
  provider: z.string().trim().min(1).max(40),
  event_id: z.string().trim().min(1).max(200),
  type: z.enum(['delivered', 'bounced', 'complained', 'opened', 'clicked', 'failed']),
  channel: z.enum(['email', 'sms', 'whatsapp']),
  address: z.string().trim().min(3).max(200),
  campaign_id: z.uuid().nullable(),
  occurred_at: z.iso.datetime(),
})

/**
 * Webhook de délivrabilité. Signature HMAC-SHA256 du corps brut (en-tête x-signature : sha256=<hex>).
 * Idempotent : un même (fournisseur, identifiant) renvoie « duplicate » sans nouvel effet.
 * Sans secret, sans identifiant de société ou sans clé serveur : 503 (aucun traitement).
 */
export async function POST(request: Request) {
  const secret = process.env.MARKETING_WEBHOOK_SECRET
  const companyId = process.env.MARKETING_COMPANY_ID
  if (!secret || !companyId || !hasServiceRole()) return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 })

  const raw = await request.text()
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)
  const given = Buffer.from(request.headers.get('x-signature') ?? '')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return NextResponse.json({ error: 'BAD_SIGNATURE' }, { status: 401 })

  let body: unknown
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 }) }
  const parsed = event.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 })
  const e = parsed.data

  const { data, error } = await createAdminClient().rpc('marketing_ingest_event', {
    p_company: companyId, p_provider: e.provider, p_event_id: e.event_id, p_type: e.type, p_channel: e.channel,
    p_address: e.address, p_campaign: e.campaign_id, p_occurred: e.occurred_at,
  })
  if (error) return NextResponse.json({ error: 'REJECTED' }, { status: 422 })
  return NextResponse.json({ result: data }, { status: 200 })
}

import 'server-only'
import { createClient } from '@/lib/supabase/server'

const num = (v: unknown) => Number(v ?? 0)

export type SourcingStatus = 'draft' | 'open' | 'closed' | 'awarded'

export async function listSourcing(): Promise<{ id: string; code: string; title: string; status: SourcingStatus; needed_date: string | null; created_at: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('sourcing_events').select('id,code,title,status,needed_date,created_at').order('created_at', { ascending: false }).limit(200)
  return (data ?? []).map((r) => ({
    id: r.id as string, code: r.code as string, title: r.title as string, status: r.status as SourcingStatus,
    needed_date: (r.needed_date as string | null) ?? null, created_at: r.created_at as string,
  }))
}

export interface SourcingLine { id: string; material_code: string; material_name: string; unit: string; qty: number }
export interface SourcingOffer {
  offer_id: string; supplier_id: string; supplier_name: string; rating: number | null
  version: number; version_id: string; currency: string; incoterm: string | null; lead_time_days: number
  transport_amount: number; duties_amount: number; valid_until: string | null
  source_reference: string; source_sha256: string | null; received_on: string
}
export interface ApprovalSummary { id: string; state: string; refusal_reason: string | null; object_version: number; rationale: string | null }

/** Consultation avec lignes, offres (version courante de chaque offre) et dernière demande d'attribution. */
export async function getSourcing(id: string) {
  const supabase = await createClient()
  const { data: e } = await supabase.from('sourcing_events').select('*').eq('id', id).maybeSingle()
  if (!e) return null
  const { data: ls } = await supabase.from('sourcing_event_lines').select('id,material_id,qty').eq('event_id', id)
  const lines = ls ?? []
  const { data: ms } = lines.length ? await supabase.from('bom_materials').select('id,code,name,unit').in('id', lines.map((l) => l.material_id as string)) : { data: [] }
  const mat = new Map((ms ?? []).map((m) => [m.id as string, m]))
  const { data: offs } = await supabase.from('sourcing_offers').select('id,supplier_id').eq('event_id', id)
  const offers = offs ?? []
  const { data: sups } = offers.length ? await supabase.from('suppliers').select('id,name,rating').in('id', offers.map((o) => o.supplier_id as string)) : { data: [] }
  const sup = new Map((sups ?? []).map((s) => [s.id as string, s]))
  const { data: vs } = await supabase.from('sourcing_offer_versions')
    .select('id,offer_id,version,currency,incoterm,lead_time_days,transport_amount,duties_amount,valid_until,source_reference,source_sha256,received_on')
    .eq('event_id', id).order('version', { ascending: false })
  const latest = new Map<string, Record<string, unknown>>()
  for (const v of vs ?? []) if (!latest.has(v.offer_id as string)) latest.set(v.offer_id as string, v)
  const { data: ap } = await supabase.from('approval_requests').select('id,state,refusal_reason,object_version,snapshot')
    .eq('object_type', 'sourcing_award').eq('object_id', id).order('object_version', { ascending: false }).limit(1).maybeSingle()
  return {
    event: {
      id: e.id as string, code: e.code as string, title: e.title as string, status: e.status as SourcingStatus, needed_date: (e.needed_date as string | null) ?? null,
      weights: e.weight_price == null ? null : { price: num(e.weight_price), lead: num(e.weight_lead), quality: num(e.weight_quality) },
      awarded_version_id: (e.awarded_version_id as string | null) ?? null, award_rationale: (e.award_rationale as string | null) ?? null,
      awarded_at: (e.awarded_at as string | null) ?? null, awarding_request_id: (e.awarding_request_id as string | null) ?? null,
    },
    lines: lines.map((l) => {
      const m = mat.get(l.material_id as string)
      return { id: l.id as string, material_code: (m?.code as string) ?? '?', material_name: (m?.name as string) ?? '—', unit: (m?.unit as string) ?? 'pc', qty: num(l.qty) } satisfies SourcingLine
    }),
    offers: offers.flatMap((o): SourcingOffer[] => {
      const v = latest.get(o.id as string)
      if (!v) return []
      const s = sup.get(o.supplier_id as string)
      return [{
        offer_id: o.id as string, supplier_id: o.supplier_id as string, supplier_name: (s?.name as string) ?? '—', rating: s?.rating == null ? null : num(s.rating),
        version: num(v.version), version_id: v.id as string, currency: v.currency as string, incoterm: (v.incoterm as string | null) ?? null,
        lead_time_days: num(v.lead_time_days), transport_amount: num(v.transport_amount), duties_amount: num(v.duties_amount),
        valid_until: (v.valid_until as string | null) ?? null, source_reference: v.source_reference as string, source_sha256: (v.source_sha256 as string | null) ?? null,
        received_on: v.received_on as string,
      }]
    }).sort((a, b) => a.supplier_name.localeCompare(b.supplier_name)),
    approval: ap ? ({
      id: ap.id as string, state: ap.state as string, refusal_reason: (ap.refusal_reason as string | null) ?? null, object_version: num(ap.object_version),
      rationale: ((ap.snapshot as Record<string, unknown> | null)?.rationale as string | undefined) ?? null,
    } satisfies ApprovalSummary) : null,
  }
}

export interface SourcingCompareOffer {
  offer_id: string; supplier_name: string; version: number; version_id: string; currency: string; incoterm: string | null; lead_time_days: number
  lines_amount_offer: number; transport_offer: number; duties_offer: number; landed_base: number; quality_rating: number
  price_score: number; lead_score: number; quality_score: number; total_score: number; rank: number
  source: { reference: string; sha256: string | null; received_on: string; rate_date: string; rate: number }
}
export interface SourcingCompare {
  event: string; status: string; base_currency: string; rate_date: string
  weights: { price: number; lead: number; quality: number }
  formula: Record<string, string>
  basis: { lines: { material_code: string; material_name: string; unit: string; qty: number }[] }
  offers: SourcingCompareOffer[]
}
/** Comparatif (calcul SQL transparent). Erreur renvoyée telle quelle pour un message explicite. */
export async function compareSourcing(id: string): Promise<{ data: SourcingCompare | null; error: { message?: string; code?: string; details?: string | null } | null }> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('sourcing_compare', { p_event: id })
  return { data: (data as SourcingCompare | null) ?? null, error: error ?? null }
}

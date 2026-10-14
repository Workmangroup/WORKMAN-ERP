import { createClient } from '@/lib/supabase/server'

export type VisitStatus = 'planned' | 'done' | 'cancelled'

export interface VisitRow {
  id: string
  client_id: string
  client: string
  owner_id: string
  planned_at: string
  duration_min: number
  purpose: string
  status: VisitStatus
  checkin: { gps_status: 'captured' | 'unavailable' | 'denied'; latitude: number | null; longitude: number | null; accuracy_m: number | null; reason: string | null; recorded_at: string } | null
  report: { report_text: string; dictation_reviewed: boolean; recorded_at: string } | null
  photos: number
}

/** Agenda de la société (visits.read) : pointage, compte rendu et photos par visite. */
export async function listVisits(): Promise<VisitRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('visit_plans').select('*').order('planned_at', { ascending: false }).limit(200)
  const plans = (data ?? []) as Record<string, unknown>[]
  const ids = plans.map((p) => String(p.id))
  if (!ids.length) return []
  const clientIds = [...new Set(plans.map((p) => String(p.client_id)))]
  const [{ data: cl }, { data: cks }, { data: reps }, { data: pics }] = await Promise.all([
    supabase.from('clients').select('id,name').in('id', clientIds),
    supabase.from('visit_checkins').select('plan_id,gps_status,latitude,longitude,accuracy_m,reason,recorded_at').in('plan_id', ids),
    supabase.from('visit_reports').select('plan_id,report_text,dictation_reviewed,recorded_at').in('plan_id', ids),
    supabase.from('visit_photos').select('plan_id').in('plan_id', ids),
  ])
  const names = new Map((cl ?? []).map((c) => [String(c.id), String(c.name)]))
  const checkins = new Map((cks ?? []).map((c) => [String(c.plan_id), c]))
  const reports = new Map((reps ?? []).map((r) => [String(r.plan_id), r]))
  const photos = new Map<string, number>()
  for (const p of pics ?? []) photos.set(String(p.plan_id), (photos.get(String(p.plan_id)) ?? 0) + 1)
  return plans.map((p) => {
    const id = String(p.id)
    const ck = checkins.get(id)
    const rp = reports.get(id)
    return {
      id, client_id: String(p.client_id), client: names.get(String(p.client_id)) ?? '—', owner_id: String(p.owner_id),
      planned_at: String(p.planned_at), duration_min: Number(p.duration_min), purpose: String(p.purpose), status: p.status as VisitStatus,
      checkin: ck ? { gps_status: ck.gps_status, latitude: ck.latitude === null ? null : Number(ck.latitude), longitude: ck.longitude === null ? null : Number(ck.longitude),
        accuracy_m: ck.accuracy_m === null ? null : Number(ck.accuracy_m), reason: ck.reason, recorded_at: String(ck.recorded_at) } : null,
      report: rp ? { report_text: String(rp.report_text), dictation_reviewed: Boolean(rp.dictation_reviewed), recorded_at: String(rp.recorded_at) } : null,
      photos: photos.get(id) ?? 0,
    } as VisitRow
  })
}

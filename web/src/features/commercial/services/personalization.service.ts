import { createClient } from '@/lib/supabase/server'

export interface Logo { id: string; client_id: string; name: string; rights_kind: string; rights_valid_until: string | null; withdrawn_at: string | null }
export interface Spec { id: string; order_line_id: string; version_no: number; logo_id: string; technique: string; placement: string; width_mm: number; height_mm: number; colors: string[] }
export interface Bat { id: string; spec_id: string; version_no: number; status: 'issued' | 'approved' | 'rejected' | 'superseded'; pdf_sha256: string; contact_name: string | null; acceptance_channel: string | null; accepted_on: string | null; acceptance_proof: string | null; decision_note: string | null }

/** Logos, spécifications courantes et BAT (lecture sous RLS, personalization.read). */
export async function personalizationOverview() {
  const supabase = await createClient()
  const [logos, specs, bats, lines, contacts, docs] = await Promise.all([
    supabase.from('client_logos').select('id,client_id,name,rights_kind,rights_valid_until,withdrawn_at').order('registered_at', { ascending: false }).limit(300),
    supabase.from('personalization_specs').select('id,order_line_id,version_no,logo_id,technique,placement,width_mm,height_mm,colors').eq('status', 'current').limit(300),
    supabase.from('bat_proofs').select('id,spec_id,version_no,status,pdf_sha256,contact_name,acceptance_channel,accepted_on,acceptance_proof,decision_note').order('issued_at', { ascending: false }).limit(300),
    supabase.from('sales_order_lines').select('id,qty,order:sales_orders(code,status,client_id),article:articles(name)').limit(300),
    supabase.from('client_contacts').select('id,client_id,full_name,can_approve_bat').eq('can_approve_bat', true).limit(500),
    supabase.from('ged_documents').select('id,client_id,title,sha256,folder:ged_folders(system_key)').limit(1000),
  ])
  return {
    logos: (logos.data ?? []) as Logo[],
    specs: (specs.data ?? []) as Spec[],
    bats: (bats.data ?? []) as Bat[],
    lines: (lines.data ?? []) as unknown as { id: string; qty: number; order: { code: string; status: string; client_id: string } | null; article: { name: string } | null }[],
    approvers: (contacts.data ?? []) as { id: string; client_id: string; full_name: string }[],
    docs: (docs.data ?? []) as unknown as { id: string; client_id: string; title: string; sha256: string | null; folder: { system_key: string | null } | null }[],
  }
}

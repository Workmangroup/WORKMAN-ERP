import 'server-only'
import { createClient } from '@/lib/supabase/server'

export type Candidate = { party_a: string; party_b: string; match_kind: 'strong' | 'ambiguous'; legal_name_a: string; legal_name_b: string; country: string }
export type Proposal = { id: string; source_party: string; target_party: string; match_kind: string; status: string; reason: string; proposed_by: string; proposed_at: string; decision_comment: string | null }
export type Party = { id: string; legal_name: string; tax_id: string | null; country: string }

/** Doublons candidats et propositions de fusion (lecture filtrée par la base : seuls les tiers visibles apparaissent). */
export async function getTiersData() {
  const supabase = await createClient()
  const [cands, props] = await Promise.all([
    supabase.rpc('party_duplicate_candidates'),
    supabase.from('party_merge_proposals').select('id, source_party, target_party, match_kind, status, reason, proposed_by, proposed_at, decision_comment')
      .order('proposed_at', { ascending: false }).limit(100),
  ])
  if (cands.error) throw new Error(cands.error.message)
  if (props.error) throw new Error(props.error.message)
  const proposals = (props.data ?? []) as Proposal[]
  const ids = [...new Set(proposals.flatMap((p) => [p.source_party, p.target_party]))]
  const { data: parties } = ids.length ? await supabase.from('parties').select('id, legal_name, tax_id, country').in('id', ids) : { data: [] }
  return {
    candidates: (cands.data ?? []) as Candidate[],
    proposals,
    parties: new Map(((parties ?? []) as Party[]).map((p) => [p.id, p])),
  }
}

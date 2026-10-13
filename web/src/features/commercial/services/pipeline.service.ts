import 'server-only'
import { createClient } from '@/lib/supabase/server'

export interface PipelineStage { code: string; label: string; kind: 'open' | 'won' | 'lost'; position: number; probability_pct: number | null }
export interface PipelineOpportunity {
  id: string; name: string; stage: string | null; status: 'open' | 'won' | 'lost'; amount: number; currency: string | null;
  probability_pct: number | null; expected_close: string | null; next_action: string | null; next_action_date: string | null; client_id: string
}
export interface PipelineBoard { stages: PipelineStage[]; opportunities: PipelineOpportunity[] }
export interface PipelineSummary {
  base_currency: string
  pipeline: { weighted: number; gross: number; open_count: number; excluded: { no_probability: number; no_currency: number; no_rate: number } } | null
  orders: { confirmed_count: number; confirmed_qty: number; note: string } | null
  revenue: { net_ht: number; invoices_counted: number; excluded_no_rate: number } | null
}

/** Tableau du pipeline : étapes et opportunités visibles (périmètre commercial appliqué par la base). */
export async function getPipelineBoard(): Promise<PipelineBoard> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('pipeline_board')
  if (error || !data) return { stages: [], opportunities: [] }
  return data as PipelineBoard
}

/** Synthèse : pondéré, commandes (quantités) et CA sont des chiffres distincts ; une section absente = pas de droit. */
export async function getPipelineSummary(from: string | null, to: string | null): Promise<PipelineSummary | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('pipeline_summary', { p_from: from, p_to: to })
  if (error || !data) return null
  return data as PipelineSummary
}

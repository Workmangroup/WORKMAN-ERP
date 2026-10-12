import 'server-only'
import { createClient } from '@/lib/supabase/server'

export interface ImportBatchRow {
  id: string
  kind: string
  file_name: string
  status: 'staged' | 'simulated' | 'committed'
  total_rows: number
  valid_rows: number
  rejected_rows: number
  to_create: number
  already_exist: number
  created_count: number
  created_at: string
  committed_at: string | null
}

export interface IntegrityIssue { ref_kind: string; ref_code: string; issue: string; detail: string }

/** Lots d'import visibles par la politique RLS (société active et imports.read). */
export async function listImportBatches(limit = 50): Promise<ImportBatchRow[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('import_batches')
    .select('id,kind,file_name,status,total_rows,valid_rows,rejected_rows,to_create,already_exist,created_count,created_at,committed_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as ImportBatchRow[]
}

/** Rapport d'intégrité : lecture seule, aucun nettoyage (fonction SQL reference_integrity_report). */
export async function integrityReport(): Promise<{ ok: true; rows: IntegrityIssue[] } | { ok: false }> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('reference_integrity_report')
  if (error) return { ok: false }
  return { ok: true, rows: (data ?? []) as IntegrityIssue[] }
}

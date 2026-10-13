import { createClient } from '@/lib/supabase/server'

export interface RemainingLine { line_id: string; article_id: string | null; description: string; qty: number; delivered: number; cancelled: number; remaining: number; invoiced: number; due_date: string }
export interface Remaining {
  order_id: string; code: string; status: string; state: 'draft' | 'cancelled' | 'confirmed' | 'partially_delivered' | 'delivered' | 'closed_with_cancellation'
  lines: RemainingLine[]; totals: { qty: number; delivered: number; cancelled: number; remaining: number }
}
export interface OrderVersion { seq: number; label: 'confirmed' | 'amended' | 'cancelled'; reason: string | null; content_hash: string; recorded_at: string }

/** Reliquats (fonction order_remaining : commandé − livré − annulé) et historique des engagements (lecture seule). */
export async function getRemaining(orderId: string): Promise<Remaining | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('order_remaining', { p_order: orderId })
  if (error || !data) return null
  return data as Remaining
}

export async function getOrderVersions(orderId: string): Promise<OrderVersion[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('sales_order_versions').select('seq,label,reason,content_hash,recorded_at').eq('order_id', orderId).order('seq')
  return (data ?? []) as OrderVersion[]
}

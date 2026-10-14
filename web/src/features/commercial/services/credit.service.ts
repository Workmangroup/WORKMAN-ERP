import { createClient } from '@/lib/supabase/server'

export interface CreditStatus { client_id: string; credit_limit: number | null; invoices_open: number; orders_open: number; total: number; headroom: number | null; base_currency: string; excluded_no_rate: number }
export interface StockPosition { variant_id: string; on_hand: number; blocked: number; reserved: number; committed_not_picked: number; usable: number; over_committed: boolean; open_order_demand: number; shipped_not_delivered: number }
export interface PromiseCheck { usable_now: number; promisable: boolean; shortage: number; blocked_excluded: number; expected_confirmed_by_date: number; expected_planned_by_date: number; hypotheses: string[] }

export async function listCreditStatus(): Promise<CreditStatus[]> {
  const supabase = await createClient()
  const { data: clients } = await supabase.from('clients').select('id,name').is('archived_at', null).not('credit_limit', 'is', null).order('name').limit(200)
  const rows = await Promise.all((clients ?? []).map((c) => supabase.rpc('client_credit_status', { p_client: String(c.id) })))
  return rows.flatMap(({ data, error }) => (error || !data ? [] : [data as CreditStatus]))
}

export async function getStockPosition(variantId: string): Promise<StockPosition | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('stock_position', { p_variant: variantId })
  return error || !data ? null : (data as StockPosition)
}

export async function getPromise(variantId: string, qty: number, date: string): Promise<PromiseCheck | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('promise_check', { p_variant: variantId, p_qty: qty, p_date: date })
  return error || !data ? null : (data as PromiseCheck)
}

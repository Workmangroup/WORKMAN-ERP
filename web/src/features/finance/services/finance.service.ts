import 'server-only'
import { createClient } from '@/lib/supabase/server'

export interface ReceiptRow { id: string; paid_on: string; amount: number; method: string; reference: string | null; invoice_code: string | null; client_name: string }
export interface SupplierInvoiceRow { id: string; number: string; supplier_id: string; supplier_name: string; supplier_ref: string; invoice_date: string; due_date: string; total: number; paid_amount: number; status: string; dispute_reason: string | null }
export interface SupplierPaymentRow { id: string; number: string; supplier_name: string; amount: number; paid_on: string; method: string; reference: string | null }
export interface AgingClient { cli_id: string; cli_name: string; cur: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; total: number }
export interface AgingSupplier { sup_id: string; sup_name: string; cur: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; total: number; disputed: number }
export interface ReminderRow { id: string; level: number; days_late: number; balance: number; status: string; invoice_code: string | null; client_name: string; sent_at: string | null }
export interface CashAccount { id: string; name: string; opening_balance: number; opening_date: string; active: boolean }
export interface CashMovementRow { id: string; account_name: string; direction: string; amount: number; moved_on: string; label: string }
export interface Position { as_of: string; opening: number; receipts: number; payments: number; manual_in: number; manual_out: number; balance: number }
export interface ForecastRow { week_no: number; week_start: string; receipts: number; payments: number; net: number; projected_balance: number }

const num = (v: unknown) => Number(v ?? 0)

export async function getDashboard() {
  const supabase = await createClient()
  const { data } = await supabase.rpc('finance_dashboard')
  return (data ?? {}) as {
    treasury: Position; receivables: number; receivables_overdue: number; dso_days: number | null; payables: number; payables_due_14d: number
    payables_disputed: number; forecast_4w_net: number; reminders_pending: number; top_overdue_clients: { client: string; overdue: number }[]
  }
}

export async function listReceipts(limit = 200): Promise<ReceiptRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('finance_receipts').select('id,paid_on,amount,method,reference,invoice_code,client_name').order('paid_on', { ascending: false }).limit(limit)
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, amount: num(r.amount) })) as ReceiptRow[]
}

export async function listSupplierInvoices(): Promise<SupplierInvoiceRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('supplier_invoices').select('id,number,supplier_id,supplier_ref,invoice_date,due_date,total,paid_amount,status,dispute_reason')
    .order('due_date').limit(300)
  const rows = (data ?? []) as Record<string, unknown>[]
  const { data: sups } = await supabase.from('suppliers').select('id,name').in('id', [...new Set(rows.map((r) => r.supplier_id as string))])
  const names = new Map((sups ?? []).map((s) => [s.id as string, s.name as string]))
  return rows.map((r) => ({ ...r, total: num(r.total), paid_amount: num(r.paid_amount), supplier_name: names.get(r.supplier_id as string) ?? '—' })) as SupplierInvoiceRow[]
}

export async function listSupplierPayments(limit = 200): Promise<SupplierPaymentRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('supplier_payments').select('id,number,supplier_id,amount,paid_on,method,reference').order('paid_on', { ascending: false }).limit(limit)
  const rows = (data ?? []) as Record<string, unknown>[]
  const { data: sups } = await supabase.from('suppliers').select('id,name').in('id', [...new Set(rows.map((r) => r.supplier_id as string))])
  const names = new Map((sups ?? []).map((s) => [s.id as string, s.name as string]))
  return rows.map((r) => ({ ...r, amount: num(r.amount), supplier_name: names.get(r.supplier_id as string) ?? '—' })) as SupplierPaymentRow[]
}

export async function suppliersOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('suppliers').select('id,name').order('name').limit(500)
  return (data ?? []) as { id: string; name: string }[]
}

export async function clientsOptions(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('clients').select('id,name').order('name').limit(500)
  return (data ?? []) as { id: string; name: string }[]
}

export async function agingClients(asOf: string): Promise<AgingClient[]> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('finance_aging_clients', { p_as_of: asOf })
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    cli_id: r.cli_id as string, cli_name: r.cli_name as string, cur: num(r.cur), d1_30: num(r.d1_30), d31_60: num(r.d31_60),
    d61_90: num(r.d61_90), d90_plus: num(r.d90_plus), total: num(r.total),
  }))
}

export async function agingSuppliers(asOf: string): Promise<AgingSupplier[]> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('finance_aging_suppliers', { p_as_of: asOf })
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    sup_id: r.sup_id as string, sup_name: r.sup_name as string, cur: num(r.cur), d1_30: num(r.d1_30), d31_60: num(r.d31_60),
    d61_90: num(r.d61_90), d90_plus: num(r.d90_plus), total: num(r.total), disputed: num(r.disputed),
  }))
}

export async function listReminders(): Promise<ReminderRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('finance_reminders').select('id,invoice_id,level,days_late,balance,status,sent_at').order('created_at', { ascending: false }).limit(200)
  const rows = (data ?? []) as Record<string, unknown>[]
  const { data: invs } = await supabase.from('invoices').select('id,code,client_id').in('id', [...new Set(rows.map((r) => r.invoice_id as string))])
  const iv = new Map((invs ?? []).map((i) => [i.id as string, i as { code: string | null; client_id: string }]))
  const { data: cls } = await supabase.from('clients').select('id,name').in('id', [...new Set([...iv.values()].map((i) => i.client_id))])
  const cn = new Map((cls ?? []).map((c) => [c.id as string, c.name as string]))
  return rows.map((r) => {
    const i = iv.get(r.invoice_id as string)
    return { id: r.id as string, level: Number(r.level), days_late: Number(r.days_late), balance: num(r.balance), status: r.status as string,
      invoice_code: i?.code ?? null, client_name: i ? cn.get(i.client_id) ?? '—' : '—', sent_at: (r.sent_at as string | null) ?? null }
  })
}

export async function listCashAccounts(): Promise<CashAccount[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('cash_accounts').select('id,name,opening_balance,opening_date,active').order('name')
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, opening_balance: num(r.opening_balance) })) as CashAccount[]
}

export async function listCashMovements(limit = 100): Promise<CashMovementRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('cash_movements').select('id,account_id,direction,amount,moved_on,label').order('moved_on', { ascending: false }).limit(limit)
  const rows = (data ?? []) as Record<string, unknown>[]
  const accounts = await listCashAccounts()
  const an = new Map(accounts.map((a) => [a.id, a.name]))
  return rows.map((r) => ({ id: r.id as string, account_name: an.get(r.account_id as string) ?? '—', direction: r.direction as string,
    amount: num(r.amount), moved_on: r.moved_on as string, label: r.label as string }))
}

export async function treasuryPosition(asOf: string): Promise<Position> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('treasury_position', { p_as_of: asOf })
  const r = (data ?? {}) as Record<string, unknown>
  return { as_of: asOf, opening: num(r.opening), receipts: num(r.receipts), payments: num(r.payments), manual_in: num(r.manual_in), manual_out: num(r.manual_out), balance: num(r.balance) }
}

export async function treasuryForecast(from: string, weeks: number, pct: number): Promise<ForecastRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('treasury_forecast', { p_from: from, p_weeks: weeks, p_collection_pct: pct })
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ week_no: Number(r.week_no), week_start: r.week_start as string, receipts: num(r.receipts),
    payments: num(r.payments), net: num(r.net), projected_balance: num(r.projected_balance) }))
}

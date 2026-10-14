import 'server-only'
import { createClient } from '@/lib/supabase/server'

/** Suivi client : chronologie, visites, adresses courriel autorisées, tâches et encours. Toutes les lectures passent par la session (RLS et droits). */

export interface TimelineRow { kind: string; ref_id: string; at: string; label: string; status: string | null }
export interface VisitRow { id: string; visit_on: string; kind: string; summary: string; created_at: string }
export interface EmailRow { id: string; email: string; purpose: string; authorized_at: string; withdrawn_at: string | null }
export interface TaskRow { id: string; title: string; due_on: string; status: string; owner_id: string; done_at: string | null }
export interface PieceOption { type: string; id: string; label: string }
export interface BalanceRow { currency: string; open_ttc: number; overdue_ttc: number; open_invoices: number }

export async function clientTimeline(clientId: string): Promise<TimelineRow[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('client_timeline', { p_client: clientId, p_limit: 200 })
  if (error) return []
  return (data ?? []) as TimelineRow[]
}

export async function clientVisits(clientId: string): Promise<VisitRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('client_visits').select('id,visit_on,kind,summary,created_at').eq('client_id', clientId).order('visit_on', { ascending: false }).limit(50)
  return (data ?? []) as VisitRow[]
}

export async function clientEmails(clientId: string): Promise<EmailRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('client_email_channels').select('id,email,purpose,authorized_at,withdrawn_at').eq('client_id', clientId).order('authorized_at', { ascending: false })
  return (data ?? []) as EmailRow[]
}

export async function clientTasks(clientId: string): Promise<TaskRow[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('client_tasks').select('id,title,due_on,status,owner_id,done_at').eq('client_id', clientId).order('due_on', { ascending: true }).limit(100)
  return (data ?? []) as TaskRow[]
}

/** Pièces récentes que l'on peut lier à une tâche (seules celles que la personne voit, par RLS). */
export async function linkablePieces(clientId: string): Promise<PieceOption[]> {
  const supabase = await createClient()
  const [orders, invoices, quotes, complaints, shipments] = await Promise.all([
    supabase.from('sales_orders').select('id,code').eq('client_id', clientId).order('order_date', { ascending: false }).limit(10),
    supabase.from('invoices').select('id,code').eq('client_id', clientId).neq('status', 'draft').order('issue_date', { ascending: false, nullsFirst: false }).limit(10),
    supabase.from('quotes').select('id,code').eq('client_id', clientId).order('created_at', { ascending: false }).limit(10),
    supabase.from('client_complaints').select('id,number').eq('client_id', clientId).order('created_at', { ascending: false }).limit(10),
    supabase.from('shipments').select('id,number').eq('client_id', clientId).order('created_at', { ascending: false }).limit(10),
  ])
  return [
    ...((orders.data ?? []) as { id: string; code: string }[]).map((r) => ({ type: 'order', id: r.id, label: `Commande ${r.code}` })),
    ...((invoices.data ?? []) as { id: string; code: string | null }[]).map((r) => ({ type: 'invoice', id: r.id, label: `Facture ${r.code ?? ''}` })),
    ...((quotes.data ?? []) as { id: string; code: string }[]).map((r) => ({ type: 'quote', id: r.id, label: `Devis ${r.code}` })),
    ...((complaints.data ?? []) as { id: string; number: string }[]).map((r) => ({ type: 'complaint', id: r.id, label: `Réclamation ${r.number}` })),
    ...((shipments.data ?? []) as { id: string; number: string }[]).map((r) => ({ type: 'shipment', id: r.id, label: `BL ${r.number}` })),
  ]
}

/** Encours par devise (TTC) ; vide sans droit facturation. */
export async function clientBalance(clientId: string): Promise<BalanceRow[] | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('client_balance', { p_client: clientId })
  if (error) return null
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    currency: String(r.currency), open_ttc: Number(r.open_ttc), overdue_ttc: Number(r.overdue_ttc), open_invoices: Number(r.open_invoices),
  }))
}

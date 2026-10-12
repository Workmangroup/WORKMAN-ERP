import 'server-only'
import { createClient } from '@/lib/supabase/server'
import type {
  PurchaseOrder, PurchaseStats, Supplier, SupplierContact, SupplierDocument, SupplierFilters, SupplierListRow,
} from '../types'

export const PAGE_SIZE = 25
const clean = (v: string | undefined) => (v ?? '').replace(/[%,()*\\:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

export async function listSuppliers(f: SupplierFilters): Promise<{ rows: SupplierListRow[]; total: number }> {
  const supabase = await createClient()
  const page = Math.max(1, f.page ?? 1)
  let q = supabase.from('suppliers').select('*', { count: 'exact' })

  const status = f.status ?? 'active'
  if (status === 'active') q = q.is('archived_at', null)
  else if (status === 'archived') q = q.not('archived_at', 'is', null)

  const term = clean(f.q)
  if (term) q = q.or(['name', 'legal_name', 'code', 'tax_id', 'email', 'phone', 'city'].map((c) => `${c}.ilike.%${term}%`).join(','))
  if (f.category) q = q.eq('category', f.category)
  if (f.country) q = q.eq('country', f.country.toUpperCase().slice(0, 2))
  if (f.qualification) q = q.eq('qualification', f.qualification)
  if (f.buyer === 'none') q = q.is('buyer_id', null)
  else if (f.buyer) q = q.eq('buyer_id', f.buyer)

  switch (f.sort) {
    case 'code': q = q.order('code'); break
    case 'recent': q = q.order('created_at', { ascending: false }); break
    case 'updated': q = q.order('updated_at', { ascending: false }); break
    default: q = q.order('name')
  }
  q = q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  const suppliers = (data ?? []) as Supplier[]

  const primary = new Map<string, SupplierListRow['primary_contact']>()
  if (suppliers.length) {
    const { data: contacts } = await supabase.from('supplier_contacts').select('supplier_id,full_name,email,phone')
      .in('supplier_id', suppliers.map((s) => s.id)).eq('is_primary', true)
    for (const c of contacts ?? []) primary.set(c.supplier_id as string, { full_name: c.full_name, email: c.email, phone: c.phone })
  }
  return { rows: suppliers.map((s) => ({ ...s, primary_contact: primary.get(s.id) ?? null })), total: count ?? 0 }
}

export async function countByStatus(): Promise<{ active: number; archived: number }> {
  const supabase = await createClient()
  const [a, b] = await Promise.all([
    supabase.from('suppliers').select('id', { count: 'exact', head: true }).is('archived_at', null),
    supabase.from('suppliers').select('id', { count: 'exact', head: true }).not('archived_at', 'is', null),
  ])
  return { active: a.count ?? 0, archived: b.count ?? 0 }
}

export async function getFacets(): Promise<{ countries: string[] }> {
  const supabase = await createClient()
  const { data } = await supabase.from('suppliers').select('country').limit(5000)
  return { countries: [...new Set((data ?? []).map((r) => (r.country as string).trim()))].sort() }
}

export async function getSupplier(id: string): Promise<Supplier | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('suppliers').select('*').eq('id', id).maybeSingle()
  return (data as Supplier | null) ?? null
}

export async function listContacts(supplierId: string): Promise<SupplierContact[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('supplier_contacts').select('*').eq('supplier_id', supplierId).order('is_primary', { ascending: false }).order('full_name')
  return (data ?? []) as SupplierContact[]
}

export async function listDocuments(supplierId: string): Promise<SupplierDocument[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('supplier_documents').select('*').eq('supplier_id', supplierId).order('created_at', { ascending: false })
  return (data ?? []) as SupplierDocument[]
}

export async function getDocument(supplierId: string, docId: string): Promise<SupplierDocument | null> {
  const supabase = await createClient()
  const { data } = await supabase.from('supplier_documents').select('*').eq('supplier_id', supplierId).eq('id', docId).maybeSingle()
  return (data as SupplierDocument | null) ?? null
}

export async function listOrders(supplierId: string, limit = 100): Promise<PurchaseOrder[]> {
  const supabase = await createClient()
  const { data } = await supabase.from('purchase_orders').select('*').eq('supplier_id', supplierId).order('order_date', { ascending: false }).limit(limit)
  return (data ?? []) as PurchaseOrder[]
}

export async function getStats(supplierId: string): Promise<PurchaseStats | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('supplier_purchase_stats', { p_supplier: supplierId })
  if (error) return null
  return data as PurchaseStats
}

/** Utilisateurs pouvant être désignés comme acheteur référent (détenteurs de suppliers.write). */
export async function listBuyers(): Promise<{ id: string; full_name: string; email: string }[]> {
  const supabase = await createClient()
  const { data } = await supabase.rpc('supplier_buyers')
  return (data ?? []) as { id: string; full_name: string; email: string }[]
}

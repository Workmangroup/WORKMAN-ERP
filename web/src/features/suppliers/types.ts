export interface Supplier {
  id: string
  company_id: string
  code: string
  name: string
  legal_name: string | null
  category: string
  qualification: 'pending' | 'approved' | 'blocked'
  rating: number | null
  tax_id: string | null
  registration_no: string | null
  website: string | null
  email: string | null
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  region: string | null
  country: string
  currency: string
  language: string
  payment_terms_id: string | null
  payment_method: string | null
  lead_time_days: number | null
  min_order_amount: number | null
  incoterm: string | null
  incoterm_place: string | null
  buyer_id: string | null
  notes: string | null
  archived_at: string | null
  archived_by: string | null
  archive_reason: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface SupplierContact {
  id: string
  supplier_id: string
  full_name: string
  job_title: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  language: string | null
  is_primary: boolean
  notes: string | null
}

export interface SupplierDocument {
  id: string
  supplier_id: string
  title: string
  doc_type: string
  file_name: string
  mime_type: string
  size_bytes: number
  storage_path: string
  valid_until: string | null
  notes: string | null
  created_at: string
}

export interface PurchaseOrder {
  id: string
  supplier_id: string
  po_no: string
  status: 'draft' | 'sent' | 'partial' | 'received' | 'cancelled'
  order_date: string
  expected_date: string | null
  received_date: string | null
  currency: string
  total_amount: number
  notes: string | null
}

export interface PurchaseStats {
  orders_count: number
  open_orders: number
  cancelled: number
  total_amount: number
  avg_order: number
  last_order: string | null
  received_count: number
  on_time_rate: number | null
  avg_lead_days: number | null
  late_open: number
  by_month: { month: string; amount: number; count: number }[]
}

export interface SupplierFilters {
  q?: string
  status?: 'active' | 'archived' | 'all'
  category?: string
  country?: string
  qualification?: string
  buyer?: string
  sort?: 'name' | 'code' | 'recent' | 'updated'
  page?: number
}

export interface SupplierListRow extends Supplier {
  primary_contact: { full_name: string; email: string | null; phone: string | null } | null
}

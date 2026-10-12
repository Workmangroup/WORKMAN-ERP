export interface Client {
  id: string
  company_id: string
  code: string
  name: string
  legal_name: string | null
  tax_id: string | null
  registration_no: string | null
  website: string | null
  email: string | null
  phone: string | null
  country: string
  currency: string
  language: string
  payment_terms_id: string | null
  payment_method: string | null
  credit_limit: number | null
  incoterm: string | null
  vat_exempt: boolean
  delivery_tolerance_pct: number
  aql_level: string | null
  sales_rep_id: string | null
  notes: string | null
  archived_at: string | null
  archived_by: string | null
  archive_reason: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface ClientContact {
  id: string
  client_id: string
  full_name: string
  job_title: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  language: string | null
  is_primary: boolean
  notes: string | null
  created_at: string
}

export interface ClientAddress {
  id: string
  client_id: string
  type: 'head_office' | 'billing' | 'delivery' | 'other'
  label: string | null
  line1: string
  line2: string | null
  postal_code: string | null
  city: string
  region: string | null
  country: string
  is_default: boolean
  notes: string | null
}

export interface PaymentTerm {
  id: string
  code: string
  label: string
  days: number
  end_of_month: boolean
}

export interface DirectoryUser {
  id: string
  full_name: string
  email: string
}

export type ClientStatusFilter = 'active' | 'archived' | 'all'
export type ClientSort = 'name' | 'code' | 'recent' | 'updated'

export interface ClientFilters {
  q?: string
  status?: ClientStatusFilter
  country?: string
  currency?: string
  rep?: string // uuid ou 'none'
  terms?: string
  sort?: ClientSort
  page?: number
}

export interface ClientListRow extends Client {
  primary_contact: { full_name: string; email: string | null; phone: string | null } | null
}

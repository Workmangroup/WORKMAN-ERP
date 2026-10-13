import type { ProductSpec, ProductStatus } from '@/lib/products/options'

export interface Product {
  id: string; company_id: string; client_id: string; code: string; name: string; family: string; article_id: string | null
  description: string | null; status: ProductStatus; current_version_id: string | null; active_version_id: string | null; main_photo_id: string | null
  duplicated_from: string | null; archived_at: string | null; archived_by: string | null; archive_reason: string | null
  created_at: string; updated_at: string; created_by: string | null; updated_by: string | null
}
export interface ProductListRow extends Product {
  client_name: string; client_code: string; version_no: number | null; cert_alerts: number; variant_count: number
}
export interface ProductVersion {
  id: string; product_id: string; version_no: number; status: 'draft' | 'prototype' | 'review' | 'validated' | 'obsolete'; spec: ProductSpec; change_note: string | null
  snapshot: unknown | null; validated_by: string | null; validated_at: string | null; validation_comment: string | null
  created_at: string; created_by: string | null; updated_at: string
}
export interface ProductPhoto {
  id: string; product_id: string; storage_path: string; file_name: string; mime_type: string; size_bytes: number
  view: string; color: string | null; caption: string | null; is_main: boolean; created_at: string
}
export interface ProductDocument {
  id: string; product_id: string; ged_document_id: string; kind: string; revision: string | null; note: string | null; created_at: string
  title: string; file_name: string | null; mime_type: string | null; size_bytes: number | null; status: string; valid_until: string | null; version_count: number; client_id: string
}
export interface ProductCert {
  id: string; product_id: string; standard_code: string; label: string | null; cert_type: string; class_level: string | null; certificate_no: string | null
  issuer: string | null; issued_on: string | null; valid_until: string | null; status: string; ged_document_id: string | null; notes: string | null
}
export interface ProductFilters { q?: string; status?: string; client?: string; family?: string; page?: number }

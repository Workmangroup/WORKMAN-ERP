import type { ArticleSpec, ArticleStatus } from '@/lib/articles/options'

export interface Article {
  id: string
  company_id: string
  client_id: string
  internal_ref: string
  client_ref: string
  name: string
  family: string
  description: string | null
  status: ArticleStatus
  current_version_id: string | null
  active_version_id: string | null
  norm_codes: string[]
  main_photo_id: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface ArticleVersion {
  id: string
  article_id: string
  version_no: number
  status: 'draft' | 'validated' | 'obsolete'
  spec: ArticleSpec
  change_note: string | null
  validated_by: string | null
  validated_at: string | null
  validation_comment: string | null
  created_at: string
  created_by: string | null
}

export interface ArticlePhoto {
  id: string
  article_id: string
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  view: string
  caption: string | null
  is_main: boolean
  created_at: string
}

export interface ArticleFilters {
  q?: string
  client?: string
  family?: string
  status?: string
  norm?: string
  page?: number
}

export interface ArticleListRow extends Article {
  client_name: string
  client_code: string
}

export interface LinkedDocument {
  id: string
  client_id: string
  title: string
  status: 'draft' | 'pending_review' | 'validated' | 'rejected'
  version_count: number
  file_name: string | null
  mime_type: string | null
  size_bytes: number | null
  valid_until: string | null
  folder_id: string
  updated_at: string
}

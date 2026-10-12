import type { DocStatus } from '@/lib/ged/constants'

export interface GedFolder {
  id: string
  client_id: string
  parent_id: string | null
  name: string
  system_key: string | null
  sort_order: number
}

export interface GedDocument {
  id: string
  client_id: string
  folder_id: string
  article_id?: string | null
  title: string
  description: string | null
  tags: string[]
  valid_until: string | null
  status: DocStatus
  validated_by: string | null
  validated_at: string | null
  validated_version_id: string | null
  validation_comment: string | null
  current_version_id: string | null
  version_count: number
  file_name: string | null
  mime_type: string | null
  size_bytes: number | null
  sha256: string | null
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface GedVersion {
  id: string
  document_id: string
  version_no: number
  storage_bucket: string
  storage_path: string
  file_name: string
  mime_type: string
  size_bytes: number
  sha256: string | null
  change_note: string | null
  uploaded_by: string | null
  created_at: string
  /** Analyse antivirus (0037) : seules « clean » et « legacy_unscanned » sont publiables. */
  scan_status: 'pending' | 'clean' | 'infected' | 'error' | 'legacy_unscanned'
  scan_details: string | null
}

export interface GedComment {
  id: string
  document_id: string
  author_id: string
  body: string
  created_at: string
  deleted_at: string | null
}

export interface ClientStats {
  client_id: string
  documents: number
  pending: number
  expiring: number
  trashed: number
  size_bytes: number
}

export interface GedFilters {
  q?: string
  clientId?: string
  folderId?: string
  folderIds?: string[]
  folderKey?: string
  status?: string
  expiring?: boolean
  trash?: boolean
  page?: number
}

export interface RoleRow {
  id: string
  code: string
  label: string
  description: string | null
  is_system: boolean
  user_count: number
  permission_count: number
}

export interface PermissionRow {
  code: string
  module: string
  label: string | null
  description: string | null
}

export interface RoleRef {
  id: string
  code: string
  label: string
}

export interface UserRow {
  id: string
  email: string
  full_name: string
  is_active: boolean
  user_type: 'internal' | 'client'
  last_sign_in_at: string | null
  roles: RoleRef[]
}

export interface AuditRow {
  id: number
  company_id: string | null
  actor_id: string | null
  actor_email: string | null
  action: string
  entity_type: string
  entity_id: string | null
  entity_label: string | null
  before_data: Record<string, unknown> | null
  after_data: Record<string, unknown> | null
  metadata: Record<string, unknown>
  source: 'trigger' | 'rpc' | 'app'
  ip: string | null
  user_agent: string | null
  created_at: string
}

export interface AuditFilters {
  type?: 'audit' | 'auth'
  scope?: string // '', 'role.', 'user.', 'access.'
  actor?: string
  from?: string
  to?: string
  page?: number
}

export interface AuthEventFull {
  id: number
  email: string | null
  user_id: string | null
  event_type: string
  success: boolean
  ip: string | null
  user_agent: string | null
  metadata: Record<string, unknown>
  created_at: string
}

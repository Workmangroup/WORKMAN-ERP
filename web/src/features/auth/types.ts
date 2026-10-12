export type FormState = {
  ok: boolean
  message?: string
  fieldErrors?: Record<string, string[] | undefined>
  /** Valeurs non sensibles à réafficher après une erreur (jamais de mot de passe). */
  values?: Record<string, string>
} | null

export interface Profile {
  id: string
  company_id: string
  email: string
  full_name: string
  phone: string | null
  locale: string
  user_type: 'internal' | 'client'
  client_id: string | null
  is_active: boolean
  must_change_password: boolean
  password_changed_at: string | null
  last_sign_in_at: string | null
}

export interface RoleInfo {
  code: string
  label: string
}

export interface AuthContextValue {
  user: { id: string; email: string }
  profile: Profile
  roles: RoleInfo[]
  permissions: string[]
  sessionId: string | null
  sessionExpiresAt: number | null
}

export interface SessionRow {
  id: string
  created_at: string
  updated_at: string | null
  user_agent: string | null
  ip: string | null
  not_after: string | null
  is_current: boolean
}

export interface AuthEventRow {
  id: number
  event_type: string
  success: boolean
  ip: string | null
  user_agent: string | null
  created_at: string
}

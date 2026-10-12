/**
 * Lecture des claims du JWT d'accès (compatible Edge runtime).
 * ATTENTION : à n'utiliser qu'APRÈS validation de la session par
 * supabase.auth.getUser() (qui interroge le serveur Auth) ; ici on ne vérifie
 * pas la signature, on lit seulement les claims ajoutés par le hook.
 */
export interface AppClaims {
  sub: string
  session_id?: string
  exp?: number
  company_id?: string
  user_type?: 'internal' | 'client'
  client_id?: string | null
  app_roles?: string[]
  app_permissions?: string[]
  must_change_password?: boolean
  is_active?: boolean
}

export function decodeJwtClaims(token: string | undefined | null): AppClaims | null {
  if (!token) return null
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as AppClaims
  } catch {
    return null
  }
}

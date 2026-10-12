import 'server-only'
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { decodeJwtClaims } from '@/lib/auth/claims'
import type { AuthContextValue, Profile, RoleInfo } from '../types'

/**
 * Contexte d'authentification de la requête (mis en cache par requête) :
 * utilisateur validé par le serveur Auth + profil + rôles + permissions.
 * Retourne null si non connecté ou compte désactivé.
 */
export const getAuthContext = cache(async (): Promise<AuthContextValue | null> => {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) return null

  const [{ data: profile }, { data: access }, { data: sessionData }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle<Profile>(),
    supabase.rpc('my_access'),
    supabase.auth.getSession(),
  ])
  if (!profile || !profile.is_active) return null

  const claims = decodeJwtClaims(sessionData.session?.access_token)
  const acc = (access ?? { roles: [], permissions: [] }) as { roles: RoleInfo[]; permissions: string[] }

  return {
    user: { id: user.id, email: user.email ?? profile.email },
    profile,
    roles: acc.roles ?? [],
    permissions: acc.permissions ?? [],
    sessionId: claims?.session_id ?? null,
    sessionExpiresAt: claims?.exp ? claims.exp * 1000 : null,
  }
})

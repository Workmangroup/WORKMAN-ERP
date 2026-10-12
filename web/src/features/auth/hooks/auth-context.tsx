'use client'

import { createContext, useContext, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ROUTES } from '@/lib/auth/constants'
import type { AuthContextValue } from '../types'

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Fournit l'utilisateur / profil / rôles / permissions (résolus côté serveur) aux
 * composants clients, et réagit aux changements d'état d'auth (déconnexion dans un autre onglet).
 */
export function AuthProvider({ value, children }: { value: AuthContextValue; children: React.ReactNode }) {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        router.replace(`${ROUTES.login}?reason=signedout`)
        router.refresh()
      }
    })
    return () => data.subscription.unsubscribe()
  }, [router])

  const memo = useMemo(() => value, [value])
  return <AuthContext.Provider value={memo}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth doit être utilisé dans <AuthProvider>.')
  return ctx
}

/** Utilisateur courant ou null (hors provider) — pour composants optionnels. */
export function useOptionalAuth() {
  return useContext(AuthContext)
}

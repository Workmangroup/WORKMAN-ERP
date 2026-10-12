'use client'

import { useAuth } from '../hooks/auth-context'

interface GateProps {
  /** Permission requise (ex: 'users.read'). */
  permission?: string
  /** Au moins une de ces permissions. */
  anyOf?: string[]
  /** Au moins un de ces rôles. */
  roles?: string[]
  fallback?: React.ReactNode
  children: React.ReactNode
}

/**
 * Affiche `children` seulement si l'utilisateur a la/les permission(s) ou le rôle requis.
 * Contrôle d'actions côté interface (boutons, sections) ; la sécurité réelle est appliquée
 * par la RLS, les RPC rbac_* et les guards serveur.
 */
export function PermissionGate({ permission, anyOf, roles, fallback = null, children }: GateProps) {
  const { permissions, roles: mine } = useAuth()
  const okPermission = !permission || permissions.includes(permission)
  const okAny = !anyOf || anyOf.some((p) => permissions.includes(p))
  const okRole = !roles || mine.some((r) => roles.includes(r.code))
  return okPermission && okAny && okRole ? <>{children}</> : <>{fallback}</>
}

/** Alias lisible : <Can permission="orders.confirm">…</Can> */
export const Can = PermissionGate

/** Garde client : n'affiche rien tant que le contexte d'authentification n'est pas disponible. */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  return user ? <>{children}</> : null
}

'use client'

import { useAuth } from './auth-context'

/** true si l'utilisateur possède la permission (ex: 'users.read'). */
export function usePermission(permission: string) {
  return useAuth().permissions.includes(permission)
}

export function useHasAnyPermission(...permissions: string[]) {
  const { permissions: mine } = useAuth()
  return permissions.some((p) => mine.includes(p))
}

/** true si l'utilisateur possède au moins un des rôles (ex: 'admin', 'direction'). */
export function useHasRole(...roles: string[]) {
  const { roles: mine } = useAuth()
  return mine.some((r) => roles.includes(r.code))
}

/**
 * Retourne une fonction `can(permission)` pour contrôler plusieurs actions d'un écran :
 *   const can = useCan(); <Button disabled={!can(P.ORDERS_CONFIRM)} />
 * Confort d'interface : la sécurité réelle est appliquée par la RLS / les RPC.
 */
export function useCan() {
  const { permissions } = useAuth()
  return (permission: string) => permissions.includes(permission)
}

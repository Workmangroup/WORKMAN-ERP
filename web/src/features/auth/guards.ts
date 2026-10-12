import 'server-only'
import { redirect } from 'next/navigation'
import { ROUTES } from '@/lib/auth/constants'
import { getAuthContext } from './services/access.service'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'

/** Garde serveur : exige une session valide (défense en profondeur après le middleware). */
export async function requireAuth() {
  const ctx = await getAuthContext()
  if (!ctx) redirect(ROUTES.login)
  return ctx
}

export async function requireRole(...roles: string[]) {
  const ctx = await requireAuth()
  if (!ctx.roles.some((r) => roles.includes(r.code))) {
    await logAccessDenied(ctx, `role:${roles.join('|')}`)
    redirect(ROUTES.unauthorized)
  }
  return ctx
}

/** Exige la permission (lue en base à chaque requête = source de vérité). Refus journalisé. */
export async function requirePermission(permission: string) {
  const ctx = await requireAuth()
  if (!ctx.permissions.includes(permission)) {
    await logAccessDenied(ctx, permission)
    redirect(ROUTES.unauthorized)
  }
  return ctx
}

/** Exige au moins une des permissions. */
export async function requireAnyPermission(...permissions: string[]) {
  const ctx = await requireAuth()
  if (!permissions.some((p) => ctx.permissions.includes(p))) {
    await logAccessDenied(ctx, permissions.join('|'))
    redirect(ROUTES.unauthorized)
  }
  return ctx
}

/** Pour les Server Actions : retourne le contexte ou lève une erreur (sans redirection). */
export async function assertAuth() {
  const ctx = await getAuthContext()
  if (!ctx) throw new Error('UNAUTHENTICATED')
  return ctx
}

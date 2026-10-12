// Exports clients (hooks / composants). Les services et guards serveur s'importent directement :
//   import { requireAuth } from '@/features/auth/guards'
export { AuthProvider, useAuth, useOptionalAuth } from './hooks/auth-context'
export { usePermission, useHasAnyPermission, useHasRole, useCan } from './hooks/use-permission'
export { useIdleTimeout } from './hooks/use-idle-timeout'
export { PermissionGate, Can, AuthGuard } from './components/guards'
export type { AuthContextValue, Profile, RoleInfo } from './types'

import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { PermissionMatrix, type RoleCol } from '@/features/admin/components/permission-matrix'
import { listPermissions, listRolesWithPermissions } from '@/features/rbac/services/rbac.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Matrice des permissions' }

/** Matrice rôles × permissions, groupée par module. Lecture pour tous les administrateurs de rôles, écriture avec roles.write. */
export default async function PermissionsMatrixPage() {
  const ctx = await requirePermission(P.ROLES_READ)
  const canEdit = ctx.permissions.includes(P.ROLES_WRITE)
  const [roles, perms] = await Promise.all([listRolesWithPermissions(), listPermissions()])
  const cols: RoleCol[] = roles.map((r) => ({ id: r.id, code: r.code, label: r.label, is_system: Boolean(r.is_system), permissions: r.permissions }))
  return (
    <>
      <PageHeader title="Matrice des permissions" description="Qui peut faire quoi, par rôle. Vue complète, filtrable, modifiable si votre droit le permet." />
      <div className="p-4 sm:p-6">
        <PermissionMatrix roles={cols} perms={perms.map((p) => ({ code: p.code, module: p.module, label: p.label ?? p.code }))} canEdit={canEdit} />
      </div>
    </>
  )
}

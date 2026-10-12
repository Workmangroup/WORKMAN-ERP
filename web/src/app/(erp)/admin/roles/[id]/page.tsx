import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { PermissionsEditor, type PermissionGroup } from '@/features/rbac/components/permissions-editor'
import { RoleDeleteForm, RoleEditForm } from '@/features/rbac/components/role-forms'
import { AuditTable } from '@/features/rbac/components/audit-table'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { getRole, getRolePermissionCodes, listPermissions, listRoleUsers } from '@/features/rbac/services/rbac.service'
import { P, PERMISSION_MODULES } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Rôle' }

/** Permissions que le rôle Administrateur doit toujours conserver (voir rbac_set_role_permissions). */
const ADMIN_LOCKED = [P.ROLES_READ, P.ROLES_WRITE, P.ROLES_ASSIGN, P.USERS_READ, P.AUDIT_READ]

export default async function RoleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ created?: string }>
}) {
  const ctx = await requirePermission(P.ROLES_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams

  const role = await getRole(id)
  if (!role) notFound()

  const [permissions, selected, users] = await Promise.all([listPermissions(), getRolePermissionCodes(id), listRoleUsers(id)])
  const canWrite = ctx.permissions.includes(P.ROLES_WRITE)
  const audit = ctx.permissions.includes(P.AUDIT_READ) ? await recentAuditFor('role', id, 8) : []

  const groups: PermissionGroup[] = Object.entries(PERMISSION_MODULES)
    .map(([module, label]) => ({
      module,
      label,
      permissions: permissions
        .filter((p) => p.module === module)
        .map((p) => ({ code: p.code, label: p.label ?? p.code, description: p.description })),
    }))
    .filter((g) => g.permissions.length > 0)

  const deleteBlock = role.is_system
    ? 'Les rôles système ne peuvent pas être supprimés.'
    : role.user_count > 0
      ? `Ce rôle est affecté à ${role.user_count} utilisateur(s) : retirez-le d’abord.`
      : undefined

  return (
    <>
      <PageHeader
        title={role.label}
        description={role.description ?? undefined}
        actions={
          <Link href="/admin/roles" className={buttonVariants({ variant: 'command', size: 'sm' })}>
            <ArrowLeft className="h-4 w-4" /> Tous les rôles
          </Link>
        }
      />

      <div className="space-y-4 p-6">
        {sp.created && <Alert tone="success">Rôle créé. Définissez maintenant ses permissions.</Alert>}
        {!canWrite && <Alert tone="info">Lecture seule : la permission « roles.write » est requise pour modifier ce rôle.</Alert>}
        <div className="flex items-center gap-2">
          <Badge tone={role.is_system ? 'brand' : 'neutral'}>{role.is_system ? 'Rôle système' : 'Rôle personnalisé'}</Badge>
          <span className="font-mono text-xs text-ink-soft">{role.code}</span>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card>
            <CardHeader><CardTitle>Permissions</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-4 text-xs text-ink-soft">
                Les actions sont contrôlées immédiatement par la base. Le menu et l’accès aux pages d’un utilisateur sont actualisés à sa prochaine navigation
                (au plus tard au renouvellement de son jeton de session).
              </p>
              <PermissionsEditor
                roleId={role.id}
                groups={groups}
                initial={selected}
                canEdit={canWrite}
                grantable={ctx.permissions}
                locked={role.code === 'admin' ? ADMIN_LOCKED : []}
              />
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle>Informations</CardTitle></CardHeader>
              <CardContent><RoleEditForm role={role} canEdit={canWrite} /></CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Utilisateurs ({users.length})</CardTitle></CardHeader>
              <ul className="divide-y divide-line text-sm">
                {users.map((u) => (
                  <li key={u.id} className="flex items-center justify-between px-5 py-2.5">
                    <Link href={`/admin/users/${u.id}`} className="text-brand-700 hover:underline">{u.full_name}</Link>
                    <span className="text-xs text-ink-soft">{u.email}</span>
                  </li>
                ))}
                {users.length === 0 && <li className="px-5 py-4 text-ink-soft">Aucun utilisateur n’a ce rôle.</li>}
              </ul>
            </Card>

            {canWrite && !role.is_system && (
              <Card>
                <CardHeader><CardTitle>Zone sensible</CardTitle></CardHeader>
                <CardContent><RoleDeleteForm roleId={role.id} label={role.label} disabledReason={deleteBlock} /></CardContent>
              </Card>
            )}
          </div>
        </div>

        {ctx.permissions.includes(P.AUDIT_READ) && (
          <Card>
            <CardHeader><CardTitle>Historique du rôle</CardTitle></CardHeader>
            <AuditTable rows={audit} />
          </Card>
        )}
      </div>
    </>
  )
}

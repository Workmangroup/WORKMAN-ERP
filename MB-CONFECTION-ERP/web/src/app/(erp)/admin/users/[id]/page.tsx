import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { AuditTable } from '@/features/rbac/components/audit-table'
import { RevokeSessionsForm, UserRolesForm, UserStatusForm, type AssignableRole } from '@/features/rbac/components/user-forms'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { getUser, listRolesWithPermissions } from '@/features/rbac/services/rbac.service'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Utilisateur' }

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.USERS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()

  const user = await getUser(id)
  if (!user) notFound()

  const roles = await listRolesWithPermissions()
  const held = new Set(ctx.permissions)
  const assignable: AssignableRole[] = roles.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    description: r.description,
    is_system: r.is_system,
    assignable: r.permissions.every((p) => held.has(p)), // anti-escalade (revérifié en base)
  }))

  const isSelf = user.id === ctx.user.id
  const audit = ctx.permissions.includes(P.AUDIT_READ) ? await recentAuditFor('user', id, 10) : []

  return (
    <>
      <PageHeader
        title={user.full_name}
        description={user.email}
        actions={
          <Link href="/admin/users" className={buttonVariants({ variant: 'command', size: 'sm' })}>
            <ArrowLeft className="h-4 w-4" /> Tous les utilisateurs
          </Link>
        }
      />
      <div className="space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={user.is_active ? 'success' : 'danger'}>{user.is_active ? 'Actif' : 'Désactivé'}</Badge>
          <Badge>{user.user_type === 'client' ? 'Utilisateur client' : 'Interne'}</Badge>
          {isSelf && <Badge tone="brand">C’est vous</Badge>}
          <span className="text-xs text-ink-soft">Dernière connexion : {formatDateTime(user.last_sign_in_at)}</span>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card>
            <CardHeader><CardTitle>Rôles</CardTitle></CardHeader>
            <CardContent>
              <UserRolesForm
                userId={user.id}
                roles={assignable}
                assigned={user.roles.map((r) => r.id)}
                canAssign={ctx.permissions.includes(P.ROLES_ASSIGN)}
                canForceLogout={ctx.permissions.includes(P.SESSIONS_MANAGE)}
                isSelf={isSelf}
              />
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle>État du compte</CardTitle></CardHeader>
              <CardContent>
                <UserStatusForm userId={user.id} isActive={user.is_active} canWrite={ctx.permissions.includes(P.USERS_WRITE)} isSelf={isSelf} />
              </CardContent>
            </Card>

            {ctx.permissions.includes(P.SESSIONS_MANAGE) && !isSelf && (
              <Card>
                <CardHeader><CardTitle>Sessions</CardTitle></CardHeader>
                <CardContent><RevokeSessionsForm userId={user.id} /></CardContent>
              </Card>
            )}
          </div>
        </div>

        {ctx.permissions.includes(P.AUDIT_READ) && (
          <Card>
            <CardHeader><CardTitle>Historique</CardTitle></CardHeader>
            <AuditTable rows={audit} />
          </Card>
        )}
      </div>
    </>
  )
}

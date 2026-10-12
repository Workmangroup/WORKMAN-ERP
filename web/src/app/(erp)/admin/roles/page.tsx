import type { Metadata } from 'next'
import Link from 'next/link'
import { Check, Plus } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getPermissionMatrix, listPermissions, listRoles } from '@/features/rbac/services/rbac.service'
import { PERMISSION_MODULES, P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Rôles et permissions' }

export default async function RolesPage({ searchParams }: { searchParams: Promise<{ view?: string; deleted?: string }> }) {
  const ctx = await requirePermission(P.ROLES_READ)
  const sp = await searchParams
  const view = sp.view === 'matrix' ? 'matrix' : 'list'
  const canWrite = ctx.permissions.includes(P.ROLES_WRITE)
  const roles = await listRoles()

  return (
    <>
      <PageHeader
        title="Rôles et permissions"
        description="Définissez qui peut voir et faire quoi dans l’ERP."
        actions={
          canWrite && (
            <Link href="/admin/roles/new" className={buttonVariants({ variant: 'command', size: 'sm' })}>
              <Plus className="h-4 w-4" /> Nouveau rôle
            </Link>
          )
        }
      />
      <div className="space-y-4 p-6">
        {sp.deleted && <Alert tone="success">Rôle supprimé.</Alert>}

        <nav aria-label="Vue" className="flex gap-1 border-b border-line">
          {[
            { id: 'list', label: 'Rôles', href: '/admin/roles' },
            { id: 'matrix', label: 'Matrice des permissions', href: '/admin/roles?view=matrix' },
          ].map((t) => (
            <Link
              key={t.id}
              href={t.href}
              aria-current={view === t.id ? 'page' : undefined}
              className={cn('-mb-px border-b-2 px-4 py-2 text-sm', view === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {view === 'list' ? (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-canvas text-xs uppercase text-ink-soft">
                  <tr>
                    <th className="px-5 py-2 font-semibold">Rôle</th>
                    <th className="px-3 py-2 font-semibold">Type</th>
                    <th className="px-3 py-2 text-right font-semibold">Utilisateurs</th>
                    <th className="px-5 py-2 text-right font-semibold">Permissions</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map((r) => (
                    <tr key={r.id} className="border-t border-line hover:bg-canvas/60">
                      <td className="px-5 py-3">
                        <Link href={`/admin/roles/${r.id}`} className="font-semibold text-brand-700 hover:underline">{r.label}</Link>
                        <div className="font-mono text-xs text-ink-faint">{r.code}</div>
                        {r.description && <div className="mt-0.5 text-xs text-ink-soft">{r.description}</div>}
                      </td>
                      <td className="px-3 py-3"><Badge tone={r.is_system ? 'brand' : 'neutral'}>{r.is_system ? 'Système' : 'Personnalisé'}</Badge></td>
                      <td className="px-3 py-3 text-right tabular-nums">{r.user_count}</td>
                      <td className="px-5 py-3 text-right tabular-nums">{r.permission_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <Matrix roles={roles} />
        )}
      </div>
    </>
  )
}

async function Matrix({ roles }: { roles: Awaited<ReturnType<typeof listRoles>> }) {
  const [perms, matrix] = await Promise.all([listPermissions(), getPermissionMatrix()])
  const modules = Object.keys(PERMISSION_MODULES)
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-canvas text-xs">
            <tr>
              <th className="min-w-64 px-5 py-2 text-left font-semibold uppercase text-ink-soft">Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="px-2 py-2 text-center font-semibold">
                  <Link href={`/admin/roles/${r.id}`} className="text-brand-700 hover:underline">{r.label}</Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => {
              const rows = perms.filter((p) => p.module === m)
              if (rows.length === 0) return null
              return [
                <tr key={`h-${m}`} className="bg-brand-50"><td colSpan={roles.length + 1} className="px-5 py-1.5 text-xs font-semibold uppercase text-brand-700">{PERMISSION_MODULES[m]}</td></tr>,
                ...rows.map((p) => (
                  <tr key={p.code} className="border-t border-line">
                    <td className="px-5 py-2"><span>{p.label ?? p.code}</span> <span className="font-mono text-xs text-ink-faint">{p.code}</span></td>
                    {roles.map((r) => (
                      <td key={r.id} className="px-2 py-2 text-center">
                        {matrix[r.id]?.has(p.code) ? <Check className="mx-auto h-4 w-4 text-success-text" aria-label="Accordée" /> : <span className="text-line-strong" aria-label="Non accordée">·</span>}
                      </td>
                    ))}
                  </tr>
                )),
              ]
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

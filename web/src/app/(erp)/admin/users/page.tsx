import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listUsers } from '@/features/rbac/services/rbac.service'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime, initials } from '@/lib/utils'

export const metadata: Metadata = { title: 'Utilisateurs' }

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePermission(P.USERS_READ)
  const { q } = await searchParams
  const users = await listUsers(q)

  return (
    <>
      <PageHeader title="Utilisateurs" description="Affectez les rôles et gérez l’état des comptes." />
      <div className="space-y-4 p-6">
        <form action="/admin/users" className="flex max-w-md gap-2" role="search">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <Input name="q" defaultValue={q} placeholder="Nom ou e-mail" className="pl-8" aria-label="Rechercher un utilisateur" />
          </div>
          <Button type="submit" variant="secondary">Rechercher</Button>
        </form>

        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-canvas text-xs uppercase text-ink-soft">
                <tr>
                  <th className="px-5 py-2 font-semibold">Utilisateur</th>
                  <th className="px-3 py-2 font-semibold">Rôles</th>
                  <th className="px-3 py-2 font-semibold">Statut</th>
                  <th className="px-5 py-2 font-semibold">Dernière connexion</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-line hover:bg-canvas/60">
                    <td className="px-5 py-3">
                      <Link href={`/admin/users/${u.id}`} className="flex items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">{initials(u.full_name)}</span>
                        <span>
                          <span className="block font-semibold text-brand-700 hover:underline">{u.full_name}</span>
                          <span className="block text-xs text-ink-soft">{u.email}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {u.roles.length ? u.roles.map((r) => <Badge key={r.id} tone="brand">{r.label}</Badge>) : <span className="text-xs text-ink-faint">Aucun rôle</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3"><Badge tone={u.is_active ? 'success' : 'danger'}>{u.is_active ? 'Actif' : 'Désactivé'}</Badge></td>
                    <td className="px-5 py-3 text-ink-soft">{formatDateTime(u.last_sign_in_at)}</td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={4} className="px-5 py-10 text-center text-ink-soft">Aucun utilisateur trouvé.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requireAuth } from '@/features/auth/guards'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Tableau de bord' }

export default async function DashboardPage() {
  const ctx = await requireAuth()
  const { profile } = ctx

  const canExec = ctx.permissions.includes(P.DASHBOARD_EXECUTIVE)
  return (
    <>
      <PageHeader title={`Bonjour, ${profile.full_name.split(' ')[0]}`} description="Bienvenue dans WORKMAN ERP 360." />
      {canExec && <div className="px-6 pt-4"><Link href="/dashboard/dg" className="inline-flex rounded-md border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-100">Ouvrir le tableau de bord DG →</Link></div>}
      <div className="grid gap-4 p-6 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Mon profil</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-ink-soft">Nom</dt><dd className="font-semibold">{profile.full_name}</dd></div>
              <div><dt className="text-ink-soft">E-mail</dt><dd className="font-semibold">{ctx.user.email}</dd></div>
              <div><dt className="text-ink-soft">Dernière connexion</dt><dd className="font-semibold">{formatDateTime(profile.last_sign_in_at)}</dd></div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Rôles</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {ctx.roles.length ? ctx.roles.map((r) => <Badge key={r.code} tone="brand">{r.label}</Badge>) : <p className="text-sm text-ink-soft">Aucun rôle attribué. Contactez un administrateur.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Session</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-ink-soft">Expiration du jeton d’accès</dt><dd className="font-semibold">{formatDateTime(ctx.sessionExpiresAt)}</dd></div>
              <div><dt className="text-ink-soft">Permissions</dt><dd className="font-semibold">{ctx.permissions.length}</dd></div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  )
}

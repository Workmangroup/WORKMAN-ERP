import type { Metadata } from 'next'
import { LogOut, MonitorSmartphone } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { ChangePasswordForm } from '@/features/auth/components/change-password-form'
import { requireAuth } from '@/features/auth/guards'
import { listMyAuthEvents, listMySessions } from '@/features/auth/services/sessions.service'
import { revokeOtherSessionsAction, revokeSessionAction, signOutEverywhereAction } from '@/features/auth/actions'
import { describeUserAgent } from '@/lib/ua'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Compte et sécurité' }

const EVENT_LABELS: Record<string, string> = {
  login_success: 'Connexion réussie',
  login_failed: 'Échec de connexion',
  login_locked: 'Connexion bloquée (verrouillage)',
  logout: 'Déconnexion',
  logout_all: 'Déconnexion de tous les appareils',
  password_reset_requested: 'Demande de réinitialisation',
  password_reset_completed: 'Mot de passe réinitialisé',
  password_changed: 'Mot de passe modifié',
  password_change_failed: 'Échec du changement de mot de passe',
  session_revoked: 'Session révoquée',
  sessions_revoked_others: 'Autres sessions révoquées',
  session_idle_timeout: 'Session expirée (inactivité)',
}

export default async function SecurityPage() {
  const ctx = await requireAuth()
  const [sessions, events] = await Promise.all([listMySessions(), listMyAuthEvents(12)])
  const others = sessions.filter((s) => !s.is_current).length

  return (
    <>
      <PageHeader
        title="Compte et sécurité"
        description="Gérez votre mot de passe et vos sessions actives."
        actions={
          <form action={signOutEverywhereAction}>
            <Button variant="command" size="sm" type="submit">
              <LogOut className="h-4 w-4" /> Se déconnecter partout
            </Button>
          </form>
        }
      />

      <div className="grid gap-4 p-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Sessions actives</CardTitle>
              <form action={revokeOtherSessionsAction}>
                <Button variant="secondary" size="sm" type="submit" disabled={others === 0}>
                  Déconnecter les autres sessions ({others})
                </Button>
              </form>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-canvas text-xs uppercase text-ink-soft">
                  <tr>
                    <th className="px-5 py-2 font-semibold">Appareil</th>
                    <th className="px-3 py-2 font-semibold">Adresse IP</th>
                    <th className="px-3 py-2 font-semibold">Connexion</th>
                    <th className="px-3 py-2 font-semibold">Dernière activité</th>
                    <th className="px-5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-t border-line">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <MonitorSmartphone className="h-4 w-4 text-ink-soft" aria-hidden />
                          {describeUserAgent(s.user_agent)}
                          {s.is_current && <Badge tone="success">Cette session</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-ink-soft">{s.ip ?? '—'}</td>
                      <td className="px-3 py-3 text-ink-soft">{formatDateTime(s.created_at)}</td>
                      <td className="px-3 py-3 text-ink-soft">{formatDateTime(s.updated_at ?? s.created_at)}</td>
                      <td className="px-5 py-3 text-right">
                        {!s.is_current && (
                          <form action={revokeSessionAction}>
                            <input type="hidden" name="session_id" value={s.id} />
                            <Button variant="ghost" size="sm" type="submit">Révoquer</Button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                  {sessions.length === 0 && (
                    <tr><td colSpan={5} className="px-5 py-6 text-center text-ink-soft">Aucune session à afficher.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>Activité récente</CardTitle></CardHeader>
            <ul className="divide-y divide-line text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <span className="flex items-center gap-2">
                    <Badge tone={e.success ? 'success' : 'danger'}>{e.success ? 'OK' : 'Échec'}</Badge>
                    {EVENT_LABELS[e.event_type] ?? e.event_type}
                  </span>
                  <span className="text-xs text-ink-soft">{e.ip ?? ''} · {formatDateTime(e.created_at)}</span>
                </li>
              ))}
              {events.length === 0 && <li className="px-5 py-6 text-center text-ink-soft">Aucune activité enregistrée.</li>}
            </ul>
          </Card>
        </div>

        <Card id="mot-de-passe" className="h-fit scroll-mt-20">
          <CardHeader><CardTitle>Changer le mot de passe</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-4 text-xs text-ink-soft">
              Dernière modification : {formatDateTime(ctx.profile.password_changed_at)}. Les autres appareils seront déconnectés.
            </p>
            <ChangePasswordForm />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, Bell, CheckCircle2, FlaskConical, Gauge, Plus, Rocket, Shirt, Timer } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { AlertsList } from '@/features/development/components/alerts-list'
import { getAlerts, getDashboard } from '@/features/development/services/development.service'
import { formatMoney } from '@/lib/bom/options'
import { PRIORITY, STAGES } from '@/lib/development/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Développement produit' }

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

export default async function DevelopmentDashboard() {
  const ctx = await requirePermission(P.DEVELOPMENT_READ)
  const [d, alerts] = await Promise.all([getDashboard(), getAlerts()])
  const canWrite = ctx.permissions.includes(P.DEVELOPMENT_WRITE)
  if (!d) return <div className="p-6"><Alert tone="error">Tableau de bord indisponible.</Alert></div>
  const maxStage = Math.max(1, ...d.by_stage.map((s) => s.count))
  const maxMonth = Math.max(1, ...d.by_month.map((m) => m.count))
  const kpi = [
    { label: 'Projets actifs', value: d.projects.active, sub: `${d.projects.on_hold} en pause`, icon: FlaskConical, tone: 'text-ink' },
    { label: 'Projets en retard', value: d.projects.overdue, sub: 'échéance dépassée', icon: AlertTriangle, tone: d.projects.overdue ? 'text-danger-text' : 'text-ink' },
    { label: 'Validations en attente', value: d.validations.pending, sub: `${d.validations.overdue} en retard`, icon: Bell, tone: d.validations.overdue ? 'text-danger-text' : 'text-warn-text' },
    { label: 'Échantillons chez le client', value: d.work.samples_at_client, sub: `${d.work.samples_open} en fabrication`, icon: Shirt, tone: 'text-ink' },
    { label: 'En production série', value: d.projects.in_production, sub: `${d.projects.completed} terminé(s)`, icon: Rocket, tone: 'text-success-text' },
    { label: 'Taux d’aboutissement', value: d.projects.success_rate === null ? '—' : `${d.projects.success_rate} %`, sub: 'série / (série + annulés)', icon: CheckCircle2, tone: 'text-ink' },
    { label: 'Cycle moyen', value: d.projects.avg_cycle_days === null ? '—' : `${d.projects.avg_cycle_days} j`, sub: 'création → série', icon: Timer, tone: 'text-ink' },
    { label: 'Délai de réponse client', value: d.validations.avg_response_days === null ? '—' : `${d.validations.avg_response_days} j`, sub: `${d.validations.approved_90d} appr. / ${d.validations.refused_90d} refus (90 j)`, icon: Gauge, tone: 'text-ink' },
  ]
  return (
    <>
      <PageHeader title="Développement produit" description="De la demande client à la production série : avancement, validations client, coûts de prototype et alertes."
        actions={canWrite && <Link href="/development/projects/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouveau projet</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Indicateurs">
          {kpi.map((k) => (
            <li key={k.label} className="rounded-md border border-line bg-white p-3 shadow-card"><p className="flex items-center gap-1.5 text-xs text-ink-soft"><k.icon className="h-3.5 w-3.5" aria-hidden />{k.label}</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${k.tone}`}>{k.value}</p><p className="text-xs text-ink-faint">{k.sub}</p></li>
          ))}
        </ul>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Projets par étape</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {STAGES.map((s) => {
                  const n = d.by_stage.find((x) => x.stage === s.id)?.count ?? 0
                  return (
                    <li key={s.id} className="flex items-center gap-3 text-sm">
                      <Link href={`/development/projects?stage=${s.id}`} className="w-36 shrink-0 hover:underline">{s.label}</Link>
                      <div className="h-5 flex-1 overflow-hidden rounded-sm bg-canvas" role="img" aria-label={`${n} projet(s)`}><div className="h-full bg-brand-500" style={{ width: `${(100 * n) / maxStage}%` }} /></div>
                      <span className="w-6 text-right font-semibold tabular-nums">{n}</span>
                    </li>
                  )
                })}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Créations (6 mois)</CardTitle></CardHeader>
            <CardContent>
              <ul className="flex h-36 items-end gap-2" aria-label="Projets créés par mois">
                {d.by_month.map((m) => (
                  <li key={m.month} className="flex flex-1 flex-col items-center justify-end gap-1">
                    <span className="text-xs font-semibold tabular-nums">{m.count}</span>
                    <div className="w-full rounded-t-sm bg-brand-500" style={{ height: `${Math.max(4, (100 * m.count) / maxMonth)}%`, minHeight: 4 }} />
                    <span className="text-[11px] text-ink-soft">{MONTHS[Number(m.month.slice(5)) - 1]}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <section aria-labelledby="alerts-title" className="space-y-2">
          <div className="flex items-center justify-between"><h2 id="alerts-title" className="text-base font-semibold">Alertes {alerts.length > 0 && <span className="ml-1 rounded-full bg-danger px-2 text-xs text-white">{alerts.length}</span>}</h2><Link href="/development/validations" className="text-sm text-brand-600 hover:underline">Tout voir</Link></div>
          <AlertsList alerts={alerts} canWrite={canWrite} limit={6} />
        </section>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader><CardTitle>Clients (projets en cours)</CardTitle></CardHeader>
            <CardContent>{d.by_client.length === 0 ? <p className="text-sm text-ink-soft">Aucun projet en cours.</p> : <ul className="space-y-1.5 text-sm">{d.by_client.map((c) => <li key={c.client} className="flex justify-between"><span>{c.client}</span><span className="font-semibold tabular-nums">{c.count}</span></li>)}</ul>}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Priorités (projets actifs)</CardTitle></CardHeader>
            <CardContent><ul className="space-y-1.5 text-sm">{(Object.keys(PRIORITY) as (keyof typeof PRIORITY)[]).map((k) => <li key={k} className="flex justify-between"><span>{PRIORITY[k].label}</span><span className="font-semibold tabular-nums">{d.by_priority[k] ?? 0}</span></li>)}</ul></CardContent>
          </Card>
          {d.costs ? (
            <Card>
              <CardHeader><CardTitle>Coûts de prototype</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="flex justify-between"><span className="text-ink-soft">Total</span><span className="font-semibold tabular-nums">{formatMoney(Number(d.costs.total))}</span></p>
                <p className="flex justify-between"><span className="text-ink-soft">30 derniers jours</span><span className="font-semibold tabular-nums">{formatMoney(Number(d.costs.last_30d))}</span></p>
                <ul className="space-y-1 border-t border-line pt-2">{d.costs.by_project.map((p) => <li key={p.code} className="flex justify-between gap-2"><span className="truncate"><span className="font-mono text-xs">{p.code}</span> {p.name}</span><span className="tabular-nums">{formatMoney(Number(p.amount))}</span></li>)}</ul>
              </CardContent>
            </Card>
          ) : (
            <Card><CardHeader><CardTitle>Prototypes</CardTitle></CardHeader><CardContent className="space-y-1.5 text-sm"><p className="flex justify-between"><span>En cours</span><span className="font-semibold tabular-nums">{d.work.prototypes_open}</span></p><p className="text-xs text-ink-faint">Les coûts sont réservés aux utilisateurs habilités.</p></CardContent></Card>
          )}
        </div>
      </div>
    </>
  )
}

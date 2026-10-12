import Link from 'next/link'
import { AlertTriangle, CalendarDays, CheckCircle2, Info, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { P } from '@/lib/rbac/permissions'
import { formatDate, formatEuro } from '@/lib/strategy/engine'
import { AGENDA_VIEWS, URGENCY_LABEL, briefing, visibleWidgets, type AgendaView, type Urgency} from '@/lib/command-center/logic'
import type { CommandCenterData } from '@/features/command-center/services/command-center.service'
import { WidgetLayout, type WidgetItem } from './widget-layout'
import { QuickActions } from './quick-actions'

const URGENCY_STYLE: Record<Urgency, string> = {
  high: 'bg-danger-bg text-danger-text',
  medium: 'bg-warn-bg text-warn-text',
  low: 'bg-canvas text-ink-soft',
}
const TONE_BORDER = { danger: 'border-l-danger-text', warning: 'border-l-warn-text', info: 'border-l-brand-500' } as const
const TONE_ICON = { danger: ShieldAlert, warning: AlertTriangle, info: Info } as const
const KIND_LABEL: Record<string, string> = { a_lancer: 'À lancer', en_cours: 'En cours', bloque: 'Bloqués', en_retard: 'En retard', termine: 'Terminés' }

/** Le Command Center : ce qu'il faut faire, ce qui attend, ce qui bloque, ce qui est prioritaire. Chaque bloc suit les droits. */
export function CommandCenterBoard({ data, perms, userName, view }: { data: CommandCenterData; perms: string[]; userName: string; view: AgendaView }) {
  const allowed = new Set<string>(visibleWidgets(perms))
  const eventsToday = data.agenda?.events.filter((e) => e.date === data.asOf).length ?? 0
  const topAlerts = (data.alerts ?? []).filter((a) => a.tone !== 'info').slice(0, 3).map((a) => a.title)
  const lines = briefing({
    validations: data.validations?.length ?? 0,
    validationsOld: data.validationsOld,
    criticalAlerts: data.criticalAlerts,
    highAlerts: data.highAlerts,
    topAlerts,
    lateOfs: data.ofs?.filter((o) => o.group === 'en_retard').length ?? 0,
    blockedOfs: data.ofs?.filter((o) => o.group === 'bloque').length ?? 0,
    shortages: data.stocks?.length ?? 0,
    quotesToChase: data.quotes?.toChase.length ?? 0,
    eventsToday,
  })

  const items: WidgetItem[] = [
    { id: 'briefing', label: 'Briefing IA', node: <Briefing lines={lines} /> },
    { id: 'tasks', label: 'Mes tâches', node: <Tasks data={data} /> },
    { id: 'validations', label: 'Mes validations', node: <Validations data={data} /> },
    { id: 'alerts', label: 'Mes alertes', node: <Alerts data={data} /> },
    { id: 'orders', label: 'Mes commandes', node: <Orders data={data} perms={perms} /> },
    { id: 'ofs', label: 'Mes OF', node: <Ofs data={data} /> },
    { id: 'stocks', label: 'Stocks critiques', node: <Stocks data={data} perms={perms} /> },
    { id: 'agenda', label: 'Mon agenda', node: <Agenda data={data} view={view} /> },
    { id: 'kpi', label: 'Mes KPI', node: <Kpis data={data} /> },
    { id: 'actions', label: 'Actions rapides', node: <Actions perms={perms} /> },
  ].filter((i) => allowed.has(i.id)) as WidgetItem[]

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-ink-soft">{formatDate(data.asOf)} · vue {data.roles.join(' · ')}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Bonjour, {userName}</h1>
        </div>
        <p className="max-w-md text-sm text-ink-soft">En moins de 30 secondes : ce que vous devez faire, ce qui attend, ce qui bloque.</p>
      </header>
      <WidgetLayout items={items} />
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md bg-canvas px-3 py-4 text-center text-sm text-ink-soft">{children}</p>
}

function Badge({ urgency }: { urgency: Urgency }) {
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', URGENCY_STYLE[urgency])}>{URGENCY_LABEL[urgency]}</span>
}

function Briefing({ lines }: { lines: string[] }) {
  return (
    <div className="space-y-3">
      <ul className="space-y-2 text-sm">
        {lines.map((l) => <li key={l} className="flex gap-2"><span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />{l}</li>)}
      </ul>
      <p className="text-xs text-ink-soft">
        Questions : <Link href="/copilot" className="font-medium text-brand-700 hover:underline">demandez au Copilote</Link>, par exemple « Quels dossiers sont urgents aujourd’hui ? ».
      </p>
    </div>
  )
}

function Tasks({ data }: { data: CommandCenterData }) {
  if (!data.tasks) return <Empty>Aucune donnée : votre droit ne couvre pas les tâches.</Empty>
  if (data.tasks.length === 0) return <Empty>Aucune tâche assignée.</Empty>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-ink-soft">
          <tr><th className="py-2 font-medium">Priorité</th><th className="font-medium">Tâche</th><th className="font-medium">Date limite</th><th className="font-medium">Module</th><th className="font-medium">Statut</th></tr>
        </thead>
        <tbody>
          {data.tasks.map((t) => (
            <tr key={t.id} className="border-t border-line">
              <td className="py-2"><Badge urgency={t.urgency} /></td>
              <td className="pr-3"><span className="font-mono text-xs text-ink-faint">{t.ref}</span> {t.title}</td>
              <td className="whitespace-nowrap">{formatDate(t.due)}</td>
              <td>Qualité</td>
              <td>{t.status === 'todo' ? 'À faire' : 'En cours'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-faint">Statut « En attente » et « Terminé » non modélisés : les actions correctives terminées sortent de la liste.</p>
    </div>
  )
}

function Validations({ data }: { data: CommandCenterData }) {
  if (!data.validations) return <Empty>Aucune validation : votre droit ne couvre aucun type de validation.</Empty>
  const list = data.validations
  return (
    <div className="space-y-3">
      <p className="text-sm"><span className="text-2xl font-semibold">{list.length}</span> en attente{data.validationsOld > 0 && <>, dont <span className="font-semibold text-danger-text">{data.validationsOld}</span> depuis plus de 7 jours</>}.</p>
      {list.length === 0 ? <Empty>Rien à valider.</Empty> : (
        <ul className="divide-y divide-line">
          {list.map((v) => (
            <li key={`${v.type}-${v.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">{v.type} <span className="font-mono text-xs text-ink-faint">{v.ref}</span></p>
                <p className="text-xs text-ink-soft">Demandée le {formatDate(v.since)} · {v.days} j</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge urgency={v.urgency} />
                <Link href={v.href} className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium hover:border-brand-500">Ouvrir pour décider</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-faint">Valider, refuser ou reporter se fait sur la fiche du module : la décision suit le circuit d’approbation existant.</p>
    </div>
  )
}

function Alerts({ data }: { data: CommandCenterData }) {
  if (!data.alerts) return <Empty>Aucune donnée : votre droit ne couvre pas les alertes.</Empty>
  const list = data.alerts
  if (list.length === 0) return <Empty>Aucune alerte pertinente. Les éléments résolus ne sont pas suivis dans cette version.</Empty>
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-xs text-ink-soft">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-danger-text" />Critique</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warn-text" />Élevé</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand-500" />Information</span>
      </div>
      <ul className="grid gap-2 md:grid-cols-2">
        {list.map((a) => {
          const Icon = TONE_ICON[a.tone]
          return (
            <li key={a.id} className={cn('rounded-md border border-line border-l-4 bg-canvas p-3', TONE_BORDER[a.tone])}>
              <p className="flex items-center gap-2 text-xs font-medium text-ink-soft"><Icon className="h-3.5 w-3.5" aria-hidden />{a.type}</p>
              <p className="mt-1 text-sm font-medium">{a.title}</p>
              <Link href={a.href} className="mt-1 inline-block text-xs text-brand-700 hover:underline">Voir les recommandations</Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Orders({ data, perms }: { data: CommandCenterData; perms: string[] }) {
  const has = (p: string) => perms.includes(p)
  const blocks: React.ReactNode[] = []
  if (data.quotes) {
    blocks.push(
      <div key="q" className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Commercial</h3>
        <p className="text-sm">{data.quotes.pending} devis en attente de réponse, dont <span className="font-semibold">{data.quotes.toChase.length}</span> à relancer cette semaine.</p>
        <ul className="space-y-1 text-sm">
          {data.quotes.toChase.map((q) => <li key={q.id} className="flex justify-between gap-2"><span>{q.code} · {q.client}</span><span className="text-ink-soft">valide jusqu’au {formatDate(q.validUntil)}</span></li>)}
        </ul>
        {data.salesOrders && <p className="text-sm">{data.salesOrders.open} commande(s) ouverte(s).</p>}
      </div>,
    )
  }
  if (data.salesOrders && has(P.DASHBOARD_EXECUTIVE)) {
    blocks.push(
      <div key="r" className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Direction : commandes à risque</h3>
        {data.salesOrders.atRisk.length === 0 ? <p className="text-sm text-ink-soft">Aucune commande confirmée en retard de livraison.</p> : (
          <ul className="space-y-1 text-sm">{data.salesOrders.atRisk.map((o) => <li key={o.id}>{o.code} · {o.client} : ligne(s) à livrer en retard</li>)}</ul>
        )}
      </div>,
    )
  }
  if (data.purchases) {
    blocks.push(
      <div key="p" className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Achat</h3>
        <p className="text-sm">{data.purchases.waiting} bon(s) de commande en attente de réception, dont {data.purchases.receipts.length} attendu(s) sous 7 jours.</p>
        <ul className="space-y-1 text-sm">
          {data.purchases.receipts.map((r) => <li key={r.id} className="flex justify-between gap-2"><span>{r.ref} · {r.supplier}</span><span className="text-ink-soft">{formatDate(r.date)}</span></li>)}
        </ul>
      </div>,
    )
  }
  if (blocks.length === 0) return <Empty>Aucune donnée de commande avec vos droits.</Empty>
  return <div className="grid gap-4 md:grid-cols-2">{blocks}</div>
}

function Ofs({ data }: { data: CommandCenterData }) {
  if (!data.ofs) return <Empty>Aucune donnée : votre droit ne couvre pas la production.</Empty>
  const counts = (['a_lancer', 'en_cours', 'bloque', 'en_retard', 'termine'] as const).map((k) => ({ k, n: data.ofs!.filter((o) => o.group === k).length }))
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {counts.map((c) => (
          <div key={c.k} className="rounded-md bg-canvas px-3 py-2">
            <p className="text-xs text-ink-soft">{KIND_LABEL[c.k]}</p>
            <p className="text-lg font-semibold">{c.n}</p>
          </div>
        ))}
      </div>
      {data.ofs.length === 0 ? <Empty>Aucun OF en cours.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-soft">
              <tr><th className="py-2 font-medium">OF</th><th className="font-medium">Client</th><th className="font-medium">Produit</th><th className="font-medium">Avancement</th><th className="font-medium">Livraison</th><th className="font-medium">Urgence</th></tr>
            </thead>
            <tbody>
              {data.ofs.map((o) => (
                <tr key={o.id} className="border-t border-line">
                  <td className="py-2 font-mono text-xs"><Link href={`/production/ordres/${o.id}`} className="text-brand-700 hover:underline">{o.number}</Link></td>
                  <td>{o.client}</td>
                  <td>{o.product}</td>
                  <td className="min-w-[7rem]">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={o.progress ?? 0} aria-valuemin={0} aria-valuemax={100}>
                        <div className="h-full bg-brand-500" style={{ width: `${o.progress ?? 0}%` }} />
                      </div>
                      <span className="text-xs text-ink-soft">{o.progress === null ? '—' : `${o.progress} %`}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap">{formatDate(o.due)}</td>
                  <td>{o.group === 'termine' ? <span className="inline-flex items-center gap-1 text-xs text-success-text"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Terminé</span> : <Badge urgency={o.urgency} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Stocks({ data, perms }: { data: CommandCenterData; perms: string[] }) {
  if (!data.stocks) return <Empty>Aucune donnée : votre droit ne couvre pas les stocks.</Empty>
  if (data.stocks.length === 0) return <Empty>Aucun article critique.</Empty>
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-ink-soft">
            <tr><th className="py-2 font-medium">Article</th><th className="font-medium">Manque</th><th className="font-medium">Risque rupture</th><th className="font-medium">Jours restants</th></tr>
          </thead>
          <tbody>
            {data.stocks.map((s) => (
              <tr key={`${s.kind}-${s.id}`} className="border-t border-line">
                <td className="py-2">{s.article}</td>
                <td>{s.missing}</td>
                <td><span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', s.severity === 'critical' ? 'bg-danger-bg text-danger-text' : 'bg-warn-bg text-warn-text')}>{s.kind === 'mrp' ? 'Besoin non couvert' : 'Sous le seuil'}</span></td>
                <td>{s.daysLeft === null ? '—' : s.daysLeft < 0 ? 'dépassé' : `${s.daysLeft} j`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {perms.includes(P.PURCHASES_REQUEST) && (
        <Link href="/purchases/requests/new" className="inline-flex rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700">Générer demande achat</Link>
      )}
      <p className="text-xs text-ink-faint">Stock actuel et minimum par entrepôt non affichés : le calcul agrège les entrepôts. La demande d’achat s’ouvre vierge.</p>
    </div>
  )
}

function Agenda({ data, view }: { data: CommandCenterData; view: AgendaView }) {
  if (!data.agenda) return <Empty>Aucune donnée : votre droit ne couvre pas l’agenda.</Empty>
  const byDate = new Map<string, { kind: string; label: string }[]>()
  for (const e of data.agenda.events) byDate.set(e.date, [...(byDate.get(e.date) ?? []), { kind: e.kind, label: e.label }])
  const dates = [...byDate.keys()].sort()
  return (
    <div className="space-y-3">
      <nav aria-label="Vue de l’agenda" className="flex gap-1">
        {AGENDA_VIEWS.map((v) => (
          <Link key={v} href={`/command-center?vue=${v}`} aria-current={v === view ? 'page' : undefined}
            className={cn('rounded-md px-3 py-1 text-xs font-medium capitalize', v === view ? 'bg-brand-600 text-white' : 'border border-line-strong text-ink-soft hover:text-ink')}>
            {v}
          </Link>
        ))}
      </nav>
      {dates.length === 0 ? <Empty>Rien de prévu sur cette période.</Empty> : (
        <ol className="space-y-3">
          {dates.map((d) => (
            <li key={d}>
              <p className="flex items-center gap-1 text-xs font-semibold text-ink-soft"><CalendarDays className="h-3.5 w-3.5" aria-hidden />{formatDate(d)}{d === data.asOf && ' · aujourd’hui'}</p>
              <ul className="mt-1 space-y-1 text-sm">
                {(byDate.get(d) ?? []).map((e, i) => <li key={`${d}-${i}`}><span className="text-ink-soft">{e.kind} :</span> {e.label}</li>)}
              </ul>
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-ink-faint">Réunions, visites clients, inventaires et contrôles qualité ne sont pas encore dans le modèle de données : ils n’apparaissent pas.</p>
    </div>
  )
}

function Kpis({ data }: { data: CommandCenterData }) {
  if (data.kpis.length === 0) return <Empty>Aucun indicateur avec vos droits.</Empty>
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {data.kpis.map((k) => (
        <div key={k.label} className="rounded-md border border-line bg-canvas p-3">
          <p className="text-xs text-ink-soft">{k.label}</p>
          <p className="mt-1 text-xl font-semibold">{k.value}</p>
          {k.hint && <p className="mt-0.5 text-[11px] text-ink-faint">{k.hint}</p>}
        </div>
      ))}
    </div>
  )
}

function Actions({ perms }: { perms: string[] }) {
  const catalogue: { perm: string; href: string; label: string }[] = [
    { perm: P.QUOTES_WRITE, href: '/commercial/quotes/new', label: 'Nouveau devis' },
    { perm: P.ORDERS_WRITE, href: '/orders/new', label: 'Nouvelle commande' },
    { perm: P.ARTICLES_WRITE, href: '/articles/new', label: 'Nouvel article' },
    { perm: P.PURCHASES_REQUEST, href: '/purchases/requests/new', label: 'Nouvelle demande achat' },
    { perm: P.SUPPLIERS_WRITE, href: '/suppliers/new', label: 'Nouveau fournisseur' },
  ]
  const actions = catalogue.filter((a) => perms.includes(a.perm)).map((a) => ({ href: a.href, label: a.label }))
  if (actions.length === 0) return <Empty>Aucune action de création avec vos droits.</Empty>
  return (
    <div className="space-y-2">
      <QuickActions actions={actions} />
      <p className="text-xs text-ink-faint">Nouvel OF, nouveau document GED et nouvel inventaire ne sont pas encore disponibles comme écrans de création.</p>
    </div>
  )
}


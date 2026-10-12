import Link from 'next/link'
import { AlertTriangle, CalendarClock, Target, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DOMAIN_LABEL, PRIORITY_LABEL, PRIORITY_ORDER, formatDate, formatEuro,
  type Domain, type Priority, type Recommendation, type Summary,
} from '@/lib/strategy/engine'

const PRIORITY_STYLE: Record<Priority, string> = {
  critical: 'bg-danger-bg text-danger-text',
  high: 'bg-warn-bg text-warn-text',
  medium: 'bg-brand-50 text-brand-700',
  low: 'bg-canvas text-ink-soft',
}

/** Tableau de bord des recommandations : synthèse, filtre par domaine, puis cartes par priorité. */
export function StrategyBoard({ recs, summary, missing, domain }: {
  recs: Recommendation[]; summary: Summary; missing: string[]; domain: Domain | null
}) {
  const visible = domain ? recs.filter((r) => r.domain === domain) : recs
  const domains = Object.keys(summary.byDomain) as Domain[]

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Kpi label="Recommandations" value={String(summary.total)} />
        {PRIORITY_ORDER.map((p) => (
          <Kpi key={p} label={PRIORITY_LABEL[p]} value={String(summary.byPriority[p])} tone={p} />
        ))}
      </section>

      <p className="text-sm text-ink-soft">
        Impact chiffré estimé (somme des montants calculés, hypothèses incluses) :{' '}
        <span className="font-semibold text-ink">{formatEuro(summary.estimatedImpact)}</span>
      </p>

      <nav aria-label="Filtrer par domaine" className="flex flex-wrap gap-2">
        <DomainChip href="/strategie" active={domain === null} label={`Tous (${summary.total})`} />
        {domains.map((d) => (
          <DomainChip key={d} href={`/strategie?domaine=${d}`} active={domain === d} label={`${DOMAIN_LABEL[d]} (${summary.byDomain[d]})`} />
        ))}
      </nav>

      {recs.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-6 text-sm text-ink-soft shadow-card">
          Aucune recommandation : les données disponibles ne signalent pas d’anomalie avec vos droits.
        </p>
      ) : (
        PRIORITY_ORDER.map((p) => {
          const group = visible.filter((r) => r.priority === p)
          if (group.length === 0) return null
          return (
            <section key={p} aria-labelledby={`prio-${p}`} className="space-y-3">
              <h2 id={`prio-${p}`} className="flex items-center gap-2 text-base font-semibold">
                <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', PRIORITY_STYLE[p])}>{PRIORITY_LABEL[p]}</span>
                <span className="text-ink-soft">{group.length}</span>
              </h2>
              <div className="grid gap-3 xl:grid-cols-2">
                {group.map((r) => <RecommendationCard key={r.id} rec={r} />)}
              </div>
            </section>
          )
        })
      )}

      <section aria-labelledby="sources" className="rounded-lg border border-line bg-surface p-4 shadow-card">
        <h2 id="sources" className="text-sm font-semibold">Périmètre de l’analyse</h2>
        <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-ink-soft">
          {missing.map((m) => <li key={m}>{m}</li>)}
          <li>Entrepôts : couverts via les seuils de stock et les besoins MRP ; pas d’analyse dédiée.</li>
          <li>RH : aucune donnée RH dans le modèle ERP actuel, donc non analysée.</li>
        </ul>
      </section>
    </div>
  )
}

function RecommendationCard({ rec: r }: { rec: Recommendation }) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-ink-faint">{DOMAIN_LABEL[r.domain]}</p>
          <h3 className="font-semibold leading-snug">{r.title}</h3>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium', PRIORITY_STYLE[r.priority])}>{PRIORITY_LABEL[r.priority]}</span>
      </header>
      <p className="text-sm">{r.description}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <Field label="Cause détectée" value={r.cause} />
        <Field label="Impact estimé" value={r.impact.label} icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />} />
        <Field label="Action recommandée" value={r.action} icon={<Target className="h-3.5 w-3.5" aria-hidden />} />
        <Field label="Indicateur de suivi" value={r.kpi} />
      </dl>
      <footer className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-ink-soft">
        <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5" aria-hidden />{r.owner}</span>
        <span className="inline-flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" aria-hidden />Date limite : {formatDate(r.dueDate)}</span>
      </footer>
    </article>
  )
}

function Field({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-md bg-canvas px-3 py-2">
      <dt className="flex items-center gap-1 text-xs font-medium text-ink-soft">{icon}{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: Priority }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3 shadow-card">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold', tone === 'critical' && 'text-danger-text', tone === 'high' && 'text-warn-text')}>{value}</p>
    </div>
  )
}

function DomainChip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}
      className={cn('rounded-full border px-3 py-1 text-sm transition-colors duration-150 motion-reduce:transition-none',
        active ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-surface text-ink-soft hover:border-brand-500 hover:text-ink')}>
      {label}
    </Link>
  )
}

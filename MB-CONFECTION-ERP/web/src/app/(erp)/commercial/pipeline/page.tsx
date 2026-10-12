import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { StageSelect } from '@/features/commercial/components/prospect-forms'
import { listProspects, type Stage } from '@/features/commercial/services/commercial.service'
import { STAGE_INFO, fmtDay, money } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Pipeline commercial' }

const COLUMNS: Stage[] = ['new', 'contacted', 'qualified', 'proposal', 'negotiation']

export default async function PipelinePage() {
  const ctx = await requirePermission(P.PROSPECTS_READ)
  const rows = await listProspects({ open: true })
  const canWrite = ctx.permissions.includes(P.PROSPECTS_WRITE)
  const today = new Date().toISOString().slice(0, 10)
  const total = rows.reduce((a, r) => a + r.est_value, 0)
  const weighted = rows.reduce((a, r) => a + (r.est_value * STAGE_INFO[r.stage].probability) / 100, 0)
  return (
    <>
      <PageHeader title="Pipeline commercial" description={`${rows.length} opportunité(s) ouverte(s) · ${money(total)} · pondéré ${money(weighted)}. Changez l’étape depuis la carte ; « Gagné » passe par la conversion en client.`}
        actions={canWrite && <Link href="/commercial/prospects/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouveau prospect</Link>} />
      <div className="overflow-x-auto p-4 sm:p-6">
        <div className="grid min-w-[64rem] grid-cols-5 gap-3">
          {COLUMNS.map((stage) => {
            const col = rows.filter((r) => r.stage === stage)
            const sum = col.reduce((a, r) => a + r.est_value, 0)
            return (
              <section key={stage} aria-label={STAGE_INFO[stage].label} className="rounded-md border border-line bg-canvas/60">
                <header className="border-b border-line px-3 py-2">
                  <div className="flex items-center justify-between"><Badge tone={STAGE_INFO[stage].tone}>{STAGE_INFO[stage].label}</Badge><span className="text-xs text-ink-soft">{col.length}</span></div>
                  <p className="mt-1 text-xs text-ink-soft tabular-nums">{money(sum)} · {STAGE_INFO[stage].probability} %</p>
                </header>
                <ul className="space-y-2 p-2">
                  {col.length === 0 && <li className="p-3 text-center text-xs text-ink-faint">Aucune opportunité</li>}
                  {col.map((p) => {
                    const late = p.next_action_date && p.next_action_date < today
                    return (
                      <li key={p.id} className="rounded-md border border-line bg-white p-3 shadow-card">
                        <Link href={`/commercial/prospects/${p.id}`} className="block font-semibold text-brand-700 hover:underline">{p.company_name}</Link>
                        <p className="text-xs text-ink-soft">{p.contact_name ?? '—'}{p.country ? ` · ${p.country}` : ''}</p>
                        <p className="mt-1 text-sm font-semibold tabular-nums">{money(p.est_value)}</p>
                        {p.next_action && <p className={cn('mt-1 text-xs', late ? 'font-semibold text-danger-text' : 'text-ink-soft')}>{late ? '⚠ ' : ''}{p.next_action} · {fmtDay(p.next_action_date)}</p>}
                        <div className="mt-2 flex items-center justify-between gap-2"><span className="truncate text-[11px] text-ink-faint">{p.owner ?? 'Non affecté'}</span>{canWrite && <StageSelect id={p.id} stage={p.stage} compact />}</div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
    </>
  )
}

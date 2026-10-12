import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { OpenInspectionDialog } from '@/features/quality/components/quality-forms'
import { listInspections, sourceOptions } from '@/features/quality/services/quality.service'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Contrôles qualité' }

const KINDS = [['reception', 'Réception'], ['production', 'Production'], ['final', 'Final']] as const
const DECISION: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  accepted: { label: 'Accepté', tone: 'success' }, conditional: { label: 'Sous réserve', tone: 'warning' }, rejected: { label: 'Rejeté', tone: 'danger' },
}

export default async function InspectionsPage({ searchParams }: { searchParams: Promise<{ type?: string; etat?: string }> }) {
  const ctx = await requirePermission(P.QUALITY_READ)
  const sp = await searchParams
  const kind = KINDS.some(([k]) => k === sp.type) ? (sp.type as string) : null
  const status = sp.etat === 'open' || sp.etat === 'closed' ? sp.etat : null
  const canWrite = ctx.permissions.includes(P.QUALITY_WRITE)
  const [rows, src] = await Promise.all([listInspections(kind, status), canWrite ? sourceOptions() : Promise.resolve({ materials: [], articles: [], orders: [] })])
  const href = (p: { type?: string | null; etat?: string | null }) => {
    const q = new URLSearchParams()
    const t = p.type === undefined ? kind : p.type
    const e = p.etat === undefined ? status : p.etat
    if (t) q.set('type', t)
    if (e) q.set('etat', e)
    const s = q.toString()
    return `/quality/controles${s ? `?${s}` : ''}`
  }
  const chip = (on: boolean) => cn('rounded-full border px-3 py-1', on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-soft')
  return (
    <>
      <PageHeader title="Contrôles qualité" description="Contrôle réception, contrôle production et contrôle final. Chaque décision est tracée."
        actions={canWrite && <OpenInspectionDialog src={src} />} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href={href({ type: null })} className={chip(!kind)}>Tous types</Link>
          {KINDS.map(([k, l]) => <Link key={k} href={href({ type: k })} className={chip(kind === k)}>{l}</Link>)}
          <span className="mx-2 border-l border-line" />
          <Link href={href({ etat: 'open' })} className={chip(status === 'open')}>Ouverts</Link>
          <Link href={href({ etat: 'closed' })} className={chip(status === 'closed')}>Décidés</Link>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun contrôle dans cette vue.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Contrôle</th><th className="px-2 py-2 font-semibold">Type</th><th className="px-2 py-2 text-right font-semibold">Échantillon</th><th className="px-2 py-2 text-right font-semibold">Accepté / rebuté</th><th className="px-2 py-2 font-semibold">Décision</th><th className="px-2 py-2 font-semibold">Ouvert le</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((r) => {
                const dec = r.decision ? DECISION[r.decision] : null
                return (
                  <tr key={r.id} className="hover:bg-canvas">
                    <td className="px-4 py-2"><Link href={`/quality/controles/${r.id}`} className="font-mono text-xs text-brand-700 hover:underline">{r.number}</Link>{r.receipt_ref && <span className="block text-xs text-ink-soft">BL {r.receipt_ref}</span>}</td>
                    <td className="px-2 py-2">{KINDS.find(([k]) => k === r.kind)?.[1] ?? r.kind}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{Number(r.sample_size)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.status === 'closed' ? `${Number(r.qty_accepted)} / ${Number(r.qty_rejected)}` : '—'}</td>
                    <td className="px-2 py-2">{dec ? <Badge tone={dec.tone}>{dec.label}</Badge> : <Badge tone="brand">En cours</Badge>}</td>
                    <td className="px-2 py-2 text-xs text-ink-soft">{formatDateTime(r.opened_at)}</td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

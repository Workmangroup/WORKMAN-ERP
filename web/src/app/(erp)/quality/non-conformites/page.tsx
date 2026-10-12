import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { OpenNcDialog } from '@/features/quality/components/quality-forms'
import { listNcs } from '@/features/quality/services/quality.service'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Non-conformités' }

const SEV: Record<string, { label: string; tone: 'neutral' | 'warning' | 'danger' }> = {
  minor: { label: 'Mineure', tone: 'neutral' }, major: { label: 'Majeure', tone: 'warning' }, critical: { label: 'Critique', tone: 'danger' },
}
const STATUS: Record<string, { label: string; tone: 'danger' | 'warning' | 'success' }> = {
  open: { label: 'Ouverte', tone: 'danger' }, contained: { label: 'Confinée', tone: 'warning' }, closed: { label: 'Close', tone: 'success' },
}

export default async function NcListPage({ searchParams }: { searchParams: Promise<{ etat?: string }> }) {
  const ctx = await requirePermission(P.QUALITY_READ)
  const sp = await searchParams
  const etat = sp.etat === 'open' || sp.etat === 'closed' ? sp.etat : null
  const rows = await listNcs(etat)
  const canWrite = ctx.permissions.includes(P.QUALITY_WRITE)
  const chip = (on: boolean) => cn('rounded-full border px-3 py-1', on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-soft')
  return (
    <>
      <PageHeader title="Non-conformités" description="Chaque rejet de contrôle ouvre une non-conformité. Elle se confine, reçoit des actions correctives, puis se clôt."
        actions={canWrite && <OpenNcDialog />} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/quality/non-conformites" className={chip(!etat)}>Toutes</Link>
          <Link href="/quality/non-conformites?etat=open" className={chip(etat === 'open')}>Ouvertes</Link>
          <Link href="/quality/non-conformites?etat=closed" className={chip(etat === 'closed')}>Closes</Link>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune non-conformité.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Numéro</th><th className="px-2 py-2 font-semibold">Titre</th><th className="px-2 py-2 font-semibold">Gravité</th><th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2 font-semibold">Ouverte le</th><th className="px-2 py-2 font-semibold">Échéance</th></tr></thead>
              <tbody className="divide-y divide-line">{rows.map((n) => (
                <tr key={n.id} className="hover:bg-canvas">
                  <td className="px-4 py-2"><Link href={`/quality/non-conformites/${n.id}`} className="font-mono text-xs text-brand-700 hover:underline">{n.number}</Link></td>
                  <td className="px-2 py-2">{n.title}</td>
                  <td className="px-2 py-2"><Badge tone={SEV[n.severity]?.tone ?? 'neutral'}>{SEV[n.severity]?.label ?? n.severity}</Badge></td>
                  <td className="px-2 py-2"><Badge tone={STATUS[n.status]?.tone ?? 'neutral'}>{STATUS[n.status]?.label ?? n.status}</Badge></td>
                  <td className="px-2 py-2 text-xs text-ink-soft">{formatDateTime(n.created_at)}</td>
                  <td className="px-2 py-2 text-xs text-ink-soft">{n.due_date ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

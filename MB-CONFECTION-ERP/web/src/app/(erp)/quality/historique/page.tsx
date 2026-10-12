import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewDefectCodeDialog } from '@/features/quality/components/quality-forms'
import { listDefectCodes, listHistory } from '@/features/quality/services/quality.service'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Historique des défauts' }

const SEV: Record<string, { label: string; tone: 'neutral' | 'warning' | 'danger' }> = {
  minor: { label: 'Mineure', tone: 'neutral' }, major: { label: 'Majeure', tone: 'warning' }, critical: { label: 'Critique', tone: 'danger' },
}
const KIND: Record<string, string> = { reception: 'Réception', production: 'Production', final: 'Final' }

export default async function DefectHistoryPage() {
  const ctx = await requirePermission(P.QUALITY_READ)
  const canWrite = ctx.permissions.includes(P.QUALITY_WRITE)
  const [history, codes] = await Promise.all([listHistory(300), listDefectCodes()])
  return (
    <>
      <PageHeader title="Historique des défauts" description="Chaque défaut constaté est conservé. Le référentiel définit les codes proposés lors des contrôles."
        actions={canWrite && <NewDefectCodeDialog />} />
      <div className="space-y-4 p-4 sm:p-6">
        <section aria-label="Référentiel des défauts" className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="mb-2 text-sm font-semibold">Référentiel ({codes.length})</h2>
          {codes.length === 0 ? <p className="text-sm text-ink-soft">Aucun défaut défini.</p> : (
            <div className="flex flex-wrap gap-2">{codes.map((c) => (
              <Badge key={c.id} tone={SEV[c.default_severity]?.tone ?? 'neutral'}><span className="font-mono">{c.code}</span> {c.label}</Badge>
            ))}</div>
          )}
        </section>
        {history.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun défaut constaté.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Constaté le</th><th className="px-2 py-2 font-semibold">Contrôle</th><th className="px-2 py-2 font-semibold">Défaut</th><th className="px-2 py-2 font-semibold">Famille</th><th className="px-2 py-2 font-semibold">Gravité</th><th className="px-2 py-2 text-right font-semibold">Nombre</th><th className="px-2 py-2 font-semibold">Note</th></tr></thead>
              <tbody className="divide-y divide-line">{history.map((h) => (
                <tr key={h.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-soft">{formatDateTime(h.occurred_at)}</td>
                  <td className="px-2 py-2"><span className="font-mono text-xs">{h.inspection_number}</span> <span className="text-xs text-ink-soft">{KIND[h.kind] ?? h.kind}</span></td>
                  <td className="px-2 py-2"><span className="font-mono text-xs">{h.defect_code}</span> {h.defect_label ?? ''}</td>
                  <td className="px-2 py-2">{h.category}</td>
                  <td className="px-2 py-2"><Badge tone={SEV[h.severity]?.tone ?? 'neutral'}>{SEV[h.severity]?.label ?? h.severity}</Badge></td>
                  <td className="px-2 py-2 text-right tabular-nums">{h.qty}</td>
                  <td className="px-2 py-2 text-ink-soft">{h.note ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

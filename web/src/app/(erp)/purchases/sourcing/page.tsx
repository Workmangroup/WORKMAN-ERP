import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { listSourcing, type SourcingStatus } from '@/features/sourcing/services/sourcing.service'
import { fmtDay } from '@/features/purchases/status'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Consultations fournisseurs' }

const STATUS: Record<SourcingStatus, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' }> = {
  draft: { label: 'Brouillon', tone: 'neutral' },
  open: { label: 'Ouverte', tone: 'brand' },
  closed: { label: 'Clôturée', tone: 'warning' },
  awarded: { label: 'Attribuée', tone: 'success' },
}

export default async function SourcingListPage() {
  const ctx = await requireAnyPermission(P.PURCHASES_READ)
  const canWrite = ctx.permissions.includes(P.PURCHASES_WRITE)
  const rows = await listSourcing()
  return (
    <>
      <PageHeader title="Consultations fournisseurs"
        description="Appels d’offres sur une base identique, comparatif transparent, attribution par décision humaine."
        actions={canWrite && <Link href="/purchases/sourcing/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouvelle consultation</Link>} />
      <div className="p-4 sm:p-6">
        <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
              <tr><th className="px-4 py-2 font-semibold">Code</th><th className="px-2 py-2 font-semibold">Intitulé</th><th className="px-2 py-2 font-semibold">Statut</th><th className="px-2 py-2 font-semibold">Besoin le</th><th className="px-4 py-2 font-semibold">Créée le</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-ink-soft">Aucune consultation.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-canvas/60">
                  <td className="px-4 py-2 font-mono"><Link href={`/purchases/sourcing/${r.id}`} className="font-semibold text-brand-700 hover:underline">{r.code}</Link></td>
                  <td className="px-2 py-2">{r.title}</td>
                  <td className="px-2 py-2"><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
                  <td className="whitespace-nowrap px-2 py-2">{fmtDay(r.needed_date)}</td>
                  <td className="whitespace-nowrap px-4 py-2">{formatDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  )
}

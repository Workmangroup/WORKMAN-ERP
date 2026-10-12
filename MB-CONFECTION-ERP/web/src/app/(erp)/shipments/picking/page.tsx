import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { PickDialog } from '@/features/shipping/components/shipping-forms'
import { listLines, listShipments } from '@/features/shipping/services/shipping.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Picking' }

export default async function PickingPage() {
  const ctx = await requirePermission(P.SHIPMENTS_READ)
  const canWrite = ctx.permissions.includes(P.SHIPMENTS_WRITE)
  const open = [...(await listShipments('preparing')), ...(await listShipments('picking'))].slice(0, 50)
  const withLines = await Promise.all(open.map(async (s) => ({ s, lines: await listLines(s.id) })))
  const pending = withLines.filter((x) => x.lines.some((l) => l.qty_picked < l.qty_requested))
  return (
    <>
      <PageHeader title="Picking" description="Pièces à prélever par expédition. Chaque prélèvement réserve le stock disponible." />
      <div className="space-y-4 p-4 sm:p-6">
        {pending.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun prélèvement en attente.</p>
        ) : pending.map(({ s, lines }) => (
          <section key={s.id} className="rounded-md border border-line bg-white shadow-card">
            <header className="flex items-center justify-between border-b border-line px-4 py-2">
              <Link href={`/shipments/${s.id}`} className="font-mono text-sm text-brand-700 hover:underline">{s.number}</Link>
              <span className="text-xs text-ink-soft">{lines.length} ligne(s)</span>
            </header>
            <ul className="divide-y divide-line">
              {lines.map((l) => {
                const remaining = l.qty_requested - l.qty_picked
                return (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span><span className="font-mono text-xs text-ink-faint">{l.sku}</span> {l.product} <span className="text-xs text-ink-soft">{l.color ?? ''} {l.size ?? ''}</span></span>
                    <span className="flex items-center gap-3">
                      <span className="tabular-nums">{l.qty_picked} / {l.qty_requested}</span>
                      {canWrite && remaining > 0 && <PickDialog lineId={l.id} remaining={remaining} />}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}

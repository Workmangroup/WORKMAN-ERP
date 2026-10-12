import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { VariantMatrix } from '@/features/variants/components/variant-matrix'
import { VariantsTimeline } from '@/features/variants/components/timeline'
import { bomChoices, bomCosts, getMatrix, listColors, listMoves, listSizes } from '@/features/variants/services/variants.service'
import { MOVE_LABELS } from '@/lib/variants/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Matrice des variantes' }

const TABS = [{ id: 'matrix', label: 'Matrice' }, { id: 'moves', label: 'Mouvements de stock' }, { id: 'history', label: 'Historique' }] as const

export default async function VariantProductPage({ params, searchParams }: { params: Promise<{ productId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requirePermission(P.VARIANTS_READ)
  const { productId } = await params
  if (!z.uuid().safeParse(productId).success) notFound()
  const sp = await searchParams
  const tab = TABS.find((t) => t.id === sp.tab)?.id ?? 'matrix'
  const data = await getMatrix(productId)
  if (!data) notFound()
  const perms = ctx.permissions
  const [colors, sizes, boms] = await Promise.all([listColors(), listSizes(), tab === 'matrix' ? bomChoices(data.product.client_id) : Promise.resolve([])])
  const costs = tab === 'matrix' && perms.includes(P.COSTS_READ) ? await bomCosts([...data.variants.map((v) => v.bom_id ?? ''), data.product_bom?.id ?? '']) : {}
  const moves = tab === 'moves' ? await listMoves(productId) : []
  const history = tab === 'history' ? await recentAuditFor('variant', productId, 150) : []
  return (
    <>
      <PageHeader title={`${data.product.code} — ${data.product.name}`} description="Matrice taille × couleur : stock, prix, codes-barres et nomenclature par variante."
        actions={<>
          <Link href="/variants" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Variantes</Link>
          {perms.includes(P.PRODUCTS_READ) && <Link href={`/products/${productId}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Fiche produit</Link>}
          {data.product.status === 'archived' && <Badge tone="warning">Archivé</Badge>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <nav aria-label="Sections" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {TABS.map((t) => <Link key={t.id} href={t.id === 'matrix' ? `/variants/${productId}` : `/variants/${productId}?tab=${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>{t.label}</Link>)}
        </nav>

        {tab === 'matrix' && <VariantMatrix data={data} colors={colors} sizes={sizes} bomOptions={boms} costs={costs} canWrite={perms.includes(P.VARIANTS_WRITE)} canStock={perms.includes(P.VARIANTS_STOCK)} canBomWrite={perms.includes(P.BOM_WRITE)} />}

        {tab === 'moves' && (moves.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun mouvement de stock.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Variante</th><th className="px-2 py-2 font-semibold">Entrepôt</th><th className="px-2 py-2 font-semibold">Type</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 text-right font-semibold">Solde</th><th className="px-2 py-2 font-semibold">Référence / motif</th><th className="px-2 py-2 font-semibold">Par</th></tr></thead>
              <tbody className="divide-y divide-line">{moves.map((m) => (
                <tr key={m.id}><td className="whitespace-nowrap px-4 py-1.5">{formatDateTime(m.created_at)}</td><td className="px-2 py-1.5 font-mono text-xs">{m.sku}</td><td className="px-2 py-1.5">{m.warehouse}</td><td className="px-2 py-1.5"><Badge tone={m.qty_delta > 0 ? 'success' : 'warning'}>{MOVE_LABELS[m.move_type] ?? m.move_type}</Badge></td>
                  <td className={cn('px-2 py-1.5 text-right font-semibold tabular-nums', m.qty_delta > 0 ? 'text-success-text' : 'text-danger-text')}>{m.qty_delta > 0 ? '+' : ''}{m.qty_delta}</td><td className="px-2 py-1.5 text-right tabular-nums">{m.balance_after}</td>
                  <td className="px-2 py-1.5 text-ink-soft">{[m.reference, m.reason].filter(Boolean).join(' — ') || '—'}</td><td className="px-2 py-1.5 text-ink-soft">{m.by ?? '—'}</td></tr>))}</tbody>
            </table>
          </div>
        ))}

        {tab === 'history' && <Card><CardHeader><CardTitle>Historique des variantes</CardTitle></CardHeader><CardContent><VariantsTimeline rows={history} /></CardContent></Card>}
      </div>
    </>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, Barcode, Boxes, Layers, Search, Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getOverview } from '@/features/variants/services/variants.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Variantes textile' }

export default async function VariantsPage({ searchParams }: { searchParams: Promise<{ q?: string; todo?: string }> }) {
  await requirePermission(P.VARIANTS_READ)
  const sp = await searchParams
  const all = await getOverview()
  const term = (sp.q ?? '').trim().toLowerCase()
  const rows = all.filter((r) => (!term || `${r.code} ${r.name} ${r.client_name}`.toLowerCase().includes(term)) && (!sp.todo || r.variants === 0 || r.low > 0 || r.out_of_stock > 0 || r.missing_barcode > 0 || r.missing_price > 0))
  const sum = (f: (r: (typeof all)[number]) => number) => all.reduce((a, r) => a + f(r), 0)
  const kpi = [
    { l: 'Produits avec variantes', v: `${all.filter((r) => r.variants > 0).length} / ${all.length}`, i: Layers },
    { l: 'Variantes actives', v: sum((r) => r.active), i: Tag },
    { l: 'Pièces en stock', v: sum((r) => r.on_hand), i: Boxes },
    { l: 'Stock bas / ruptures', v: `${sum((r) => r.low)} / ${sum((r) => r.out_of_stock)}`, i: AlertTriangle },
    { l: 'Sans code-barres / prix', v: `${sum((r) => r.missing_barcode)} / ${sum((r) => r.missing_price)}`, i: Barcode },
  ]
  return (
    <>
      <PageHeader title="Variantes textile" description="Déclinaisons taille × couleur des produits : matrice, stock, prix, codes-barres et nomenclature par variante." />
      <div className="space-y-4 p-4 sm:p-6">
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Indicateurs">
          {kpi.map((k) => <li key={k.l} className="rounded-md border border-line bg-white p-3 shadow-card"><p className="flex items-center gap-1.5 text-xs text-ink-soft"><k.i className="h-3.5 w-3.5" aria-hidden />{k.l}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{k.v}</p></li>)}
        </ul>
        <form action="/variants" role="search" className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white p-3 shadow-card">
          <div className="relative min-w-60 flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" /><Input name="q" defaultValue={sp.q} placeholder="Rechercher un produit (code, désignation, client)…" className="pl-8" aria-label="Rechercher un produit" /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="todo" value="1" defaultChecked={Boolean(sp.todo)} className="h-4 w-4 accent-brand-500" />À traiter (sans variante, alertes de stock, codes ou prix manquants)</label>
          <Button type="submit">Filtrer</Button>
          <span className="ml-auto text-sm text-ink-soft">{rows.length} produit(s)</span>
        </form>
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun produit ne correspond. Les produits se créent dans le module Produits (PDM).</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Produit</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 text-right font-semibold">Couleurs × tailles</th><th className="px-2 py-2 text-right font-semibold">Variantes</th><th className="px-2 py-2 text-right font-semibold">Stock</th><th className="px-2 py-2 font-semibold">À surveiller</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.product_id}>
                    <td className="px-4 py-2"><Link href={`/variants/${r.product_id}`} className="font-semibold text-brand-700 hover:underline"><span className="font-mono text-xs">{r.code}</span> {r.name}</Link></td>
                    <td className="px-2 py-2">{r.client_name}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.variants ? `${r.colors} × ${r.sizes}` : '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.active}{r.active !== r.variants ? <span className="text-ink-faint"> / {r.variants}</span> : null}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.on_hand}{r.reserved > 0 && <span className="block text-xs text-ink-soft">{r.reserved} réservées</span>}</td>
                    <td className="px-2 py-2"><span className="flex flex-wrap gap-1">
                      {r.variants === 0 && <Badge tone="neutral">Aucune variante</Badge>}
                      {r.out_of_stock > 0 && r.variants > 0 && <Badge tone="danger">{r.out_of_stock} en rupture</Badge>}
                      {r.low > 0 && <Badge tone="warning">{r.low} stock bas</Badge>}
                      {r.missing_barcode > 0 && <Badge tone="warning">{r.missing_barcode} sans code-barres</Badge>}
                      {r.missing_price > 0 && <Badge tone="warning">{r.missing_price} sans prix</Badge>}
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

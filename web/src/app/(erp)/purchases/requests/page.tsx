import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { listRequests } from '@/features/purchases/services/purchases.service'
import { REQUEST_STATUS, fmtDay } from '@/features/purchases/status'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Demandes d’achat' }

export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const ctx = await requireAnyPermission(P.PURCHASES_READ, P.PURCHASES_REQUEST)
  const sp = await searchParams
  const rows = await listRequests(sp)
  const canCreate = ctx.permissions.includes(P.PURCHASES_REQUEST) || ctx.permissions.includes(P.PURCHASES_WRITE)
  const onlyMine = !ctx.permissions.includes(P.PURCHASES_READ)
  return (
    <>
      <PageHeader title="Demandes d’achat" description={onlyMine ? 'Vos demandes d’achat.' : 'Besoins exprimés par la production, le magasin ou issus du MRP : à valider avant commande.'}
        actions={canCreate && <Link href="/purchases/requests/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouvelle demande</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/purchases/requests" role="search" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="relative"><Label htmlFor="q">Recherche</Label><Search className="pointer-events-none absolute left-2.5 top-[2.1rem] h-4 w-4 text-ink-faint" /><Input id="q" name="q" defaultValue={sp.q} placeholder="Code DA, motif…" className="pl-8" /></div>
          <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">Tous</option>{Object.entries(REQUEST_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
          <Button type="submit">Filtrer</Button>
        </form>
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune demande.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Demande</th><th className="px-2 py-2 font-semibold">Motif</th><th className="px-2 py-2 font-semibold">Demandeur</th><th className="px-2 py-2 text-right font-semibold">Lignes</th><th className="px-2 py-2 font-semibold">Besoin le</th><th className="px-2 py-2 font-semibold">Statut</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2"><Link href={`/purchases/requests/${r.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{r.code}</Link>{r.source === 'mrp' && <Badge tone="brand" className="ml-2">MRP</Badge>}</td>
                    <td className="max-w-xs truncate px-2 py-2 text-ink-soft">{r.reason ?? '—'}</td><td className="px-2 py-2">{r.requester ?? '—'}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.line_count}</td><td className="whitespace-nowrap px-2 py-2">{fmtDay(r.needed_date)}</td>
                    <td className="px-2 py-2"><Badge tone={REQUEST_STATUS[r.status].tone}>{REQUEST_STATUS[r.status].label}</Badge></td>
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

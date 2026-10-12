import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listQuotes } from '@/features/commercial/services/commercial.service'
import { QUOTE_STATUS, fmtDay, money } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Devis' }

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const ctx = await requirePermission(P.QUOTES_READ)
  const sp = await searchParams
  const rows = await listQuotes(sp)
  return (
    <>
      <PageHeader title="Devis" description="Brouillon → envoyé → accepté → transformé en commande. Un devis envoyé n’est plus modifiable : dupliquez-le pour le réviser."
        actions={ctx.permissions.includes(P.QUOTES_WRITE) && <Link href="/commercial/quotes/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouveau devis</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/commercial/quotes" role="search" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="relative"><Label htmlFor="q">Recherche</Label><Search className="pointer-events-none absolute left-2.5 top-[2.1rem] h-4 w-4 text-ink-faint" /><Input id="q" name="q" defaultValue={sp.q} placeholder="Code devis, notes…" className="pl-8" /></div>
          <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">Tous</option>{Object.entries(QUOTE_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
          <Button type="submit">Filtrer</Button>
        </form>
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun devis.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Devis</th><th className="px-2 py-2 font-semibold">Client / prospect</th><th className="px-2 py-2 font-semibold">Date</th><th className="px-2 py-2 font-semibold">Valable jusqu’au</th><th className="px-2 py-2 text-right font-semibold">Total HT</th><th className="px-2 py-2 text-right font-semibold">TTC</th><th className="px-2 py-2 font-semibold">Statut</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2"><Link href={`/commercial/quotes/${r.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{r.code}</Link></td>
                    <td className="px-2 py-2">{r.party}{r.is_prospect && <Badge className="ml-2" tone="warning">prospect</Badge>}</td>
                    <td className="whitespace-nowrap px-2 py-2">{fmtDay(r.quote_date)}</td>
                    <td className={cn('whitespace-nowrap px-2 py-2', r.expired && 'font-semibold text-danger-text')}>{fmtDay(r.valid_until)}{r.expired && <span className="block text-xs">Expiré</span>}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(r.subtotal, r.currency)}</td><td className="px-2 py-2 text-right tabular-nums">{money(r.total, r.currency)}</td>
                    <td className="px-2 py-2"><Badge tone={QUOTE_STATUS[r.status].tone}>{QUOTE_STATUS[r.status].label}</Badge></td>
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

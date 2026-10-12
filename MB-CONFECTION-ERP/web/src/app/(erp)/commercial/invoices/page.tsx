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
import { listInvoices } from '@/features/commercial/services/commercial.service'
import { INVOICE_STATUS, fmtDay, money } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Factures' }

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; overdue?: string; client?: string }> }) {
  const ctx = await requirePermission(P.INVOICES_READ)
  const sp = await searchParams
  const rows = await listInvoices({ q: sp.q, status: sp.status, client: sp.client, overdue: sp.overdue === '1' })
  const open = rows.filter((r) => ['issued', 'partially_paid'].includes(r.status)).reduce((a, r) => a + r.balance, 0)
  return (
    <>
      <PageHeader title="Factures" description="Facturation depuis les commandes confirmées (totale ou partielle). Le numéro légal est attribué à l’émission, sans trou ; une facture émise se corrige par un avoir."
        actions={ctx.permissions.includes(P.INVOICES_WRITE) && <Link href="/commercial/invoices/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Facture sans commande</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/commercial/invoices" role="search" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="relative"><Label htmlFor="q">Recherche</Label><Search className="pointer-events-none absolute left-2.5 top-[2.1rem] h-4 w-4 text-ink-faint" /><Input id="q" name="q" defaultValue={sp.q} placeholder="N° de facture…" className="pl-8" /></div>
          <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">Tous</option>{Object.entries(INVOICE_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
          <div><Label htmlFor="overdue">Échéance</Label><Select id="overdue" name="overdue" defaultValue={sp.overdue ?? ''}><option value="">Toutes</option><option value="1">En retard uniquement</option></Select></div>
          <Button type="submit">Filtrer</Button>
        </form>
        {open > 0 && <p className="text-sm text-ink-soft">Reste à encaisser sur cette liste : <strong className="tabular-nums text-ink">{money(open)}</strong></p>}
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune facture.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Facture</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">Émise le</th><th className="px-2 py-2 font-semibold">Échéance</th><th className="px-2 py-2 text-right font-semibold">Total TTC</th><th className="px-2 py-2 text-right font-semibold">Solde</th><th className="px-2 py-2 font-semibold">Statut</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-2"><Link href={`/commercial/invoices/${r.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{r.code ?? 'Brouillon'}</Link></td>
                    <td className="px-2 py-2">{r.client_name}</td><td className="whitespace-nowrap px-2 py-2">{fmtDay(r.issue_date)}</td>
                    <td className={cn('whitespace-nowrap px-2 py-2', r.overdue && 'font-semibold text-danger-text')}>{fmtDay(r.due_date)}{r.overdue && <span className="block text-xs">En retard</span>}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{money(r.total, r.currency)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{['issued', 'partially_paid'].includes(r.status) ? money(r.balance, r.currency) : '—'}</td>
                    <td className="px-2 py-2"><Badge tone={INVOICE_STATUS[r.status].tone}>{INVOICE_STATUS[r.status].label}</Badge></td>
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

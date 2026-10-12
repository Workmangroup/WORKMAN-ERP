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
import { listProspects } from '@/features/commercial/services/commercial.service'
import { STAGE_INFO, fmtDay, money } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Prospects' }

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<{ q?: string; stage?: string }> }) {
  const ctx = await requirePermission(P.PROSPECTS_READ)
  const sp = await searchParams
  const rows = await listProspects(sp)
  const today = new Date().toISOString().slice(0, 10)
  return (
    <>
      <PageHeader title="Prospects" description="Clients potentiels à qualifier, relancer puis convertir en fiche client."
        actions={ctx.permissions.includes(P.PROSPECTS_WRITE) && <Link href="/commercial/prospects/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouveau prospect</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/commercial/prospects" role="search" className="grid gap-3 rounded-md border border-line bg-white p-4 shadow-card md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="relative"><Label htmlFor="q">Recherche</Label><Search className="pointer-events-none absolute left-2.5 top-[2.1rem] h-4 w-4 text-ink-faint" /><Input id="q" name="q" defaultValue={sp.q} placeholder="Société, contact, code, e-mail…" className="pl-8" /></div>
          <div><Label htmlFor="stage">Étape</Label><Select id="stage" name="stage" defaultValue={sp.stage ?? ''}><option value="">Toutes</option>{Object.entries(STAGE_INFO).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
          <Button type="submit">Filtrer</Button>
        </form>
        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun prospect.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Prospect</th><th className="px-2 py-2 font-semibold">Contact</th><th className="px-2 py-2 font-semibold">Commercial</th><th className="px-2 py-2 text-right font-semibold">Valeur</th><th className="px-2 py-2 font-semibold">Prochaine action</th><th className="px-2 py-2 font-semibold">Étape</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((p) => {
                  const late = p.next_action_date && p.next_action_date < today && !['won', 'lost'].includes(p.stage)
                  return (
                    <tr key={p.id}>
                      <td className="px-4 py-2"><Link href={`/commercial/prospects/${p.id}`} className="font-semibold text-brand-700 hover:underline">{p.company_name}</Link><span className="ml-2 font-mono text-xs text-ink-faint">{p.code}</span></td>
                      <td className="px-2 py-2 text-ink-soft">{p.contact_name ?? '—'}{p.country ? ` · ${p.country}` : ''}</td><td className="px-2 py-2">{p.owner ?? '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{money(p.est_value)}</td>
                      <td className={cn('px-2 py-2 text-xs', late && 'font-semibold text-danger-text')}>{p.next_action ? `${p.next_action} · ${fmtDay(p.next_action_date)}` : '—'}</td>
                      <td className="px-2 py-2"><Badge tone={STAGE_INFO[p.stage].tone}>{STAGE_INFO[p.stage].label}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listClientsLite } from '@/features/articles/services/articles.service'
import { PAGE_SIZE, listProjects } from '@/features/development/services/development.service'
import { FAMILIES, PRIORITY, PROJECT_STATUS, STAGES, daysUntil, label, stageInfo } from '@/lib/development/options'
import { P } from '@/lib/rbac/permissions'
import { fmtDay } from '@/features/orders/status'

export const metadata: Metadata = { title: 'Projets — Développement produit' }

type SP = Partial<Record<'q' | 'stage' | 'status' | 'client' | 'priority' | 'page', string>>

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePermission(P.DEVELOPMENT_READ)
  const sp = await searchParams
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const [{ rows, total }, clients] = await Promise.all([listProjects({ ...sp, page }), listClientsLite()])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasFilters = Boolean(sp.q || sp.stage || sp.status || sp.client || sp.priority)
  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...sp, page: undefined, ...over })) if (v !== undefined && v !== '') p.set(k, String(v))
    const s = p.toString()
    return s ? `/development/projects?${s}` : '/development/projects'
  }
  return (
    <>
      <PageHeader title="Projets de développement" description="Tous les projets, de la demande client à la production série."
        actions={ctx.permissions.includes(P.DEVELOPMENT_WRITE) && <Link href="/development/projects/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouveau projet</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/development/projects" role="search" className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" /><Input name="q" defaultValue={sp.q} placeholder="Rechercher : code (DEV-0001), désignation, demande…" className="pl-8" aria-label="Rechercher un projet" /></div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div><Label htmlFor="stage">Étape</Label><Select id="stage" name="stage" defaultValue={sp.stage ?? ''}><option value="">Toutes</option>{STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></div>
            <div><Label htmlFor="status">Statut</Label><Select id="status" name="status" defaultValue={sp.status ?? ''}><option value="">En cours (actifs, en pause)</option><option value="all">Tous</option>{Object.entries(PROJECT_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></div>
            <div><Label htmlFor="client">Client</Label><Select id="client" name="client" defaultValue={sp.client ?? ''}><option value="">Tous</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
            <div><Label htmlFor="priority">Priorité</Label><Select id="priority" name="priority" defaultValue={sp.priority ?? ''}><option value="">Toutes</option>{Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</Select></div>
          </div>
          <div className="flex flex-wrap items-center gap-3"><Button type="submit">Rechercher</Button>{hasFilters && <Link href="/development/projects" className="text-sm text-brand-600 hover:underline">Réinitialiser</Link>}<span className="ml-auto text-sm text-ink-soft">{total} projet(s)</span></div>
        </form>

        {rows.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun projet ne correspond.</p> : (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Projet</th><th className="px-2 py-2 font-semibold">Client</th><th className="px-2 py-2 font-semibold">Étape</th><th className="px-2 py-2 font-semibold">Priorité</th><th className="px-2 py-2 font-semibold">Responsable</th><th className="px-2 py-2 font-semibold">Échéance</th><th className="px-2 py-2 font-semibold">Statut</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((p) => {
                  const d = daysUntil(p.due_date)
                  const late = p.status === 'active' && p.stage !== 'production' && d !== null && d < 0
                  return (
                    <tr key={p.id}>
                      <td className="px-4 py-2"><Link href={`/development/projects/${p.id}`} className="font-semibold text-brand-700 hover:underline"><span className="font-mono text-xs">{p.code}</span> {p.name}</Link><span className="block text-xs text-ink-soft">{label(FAMILIES, p.family)}{p.target_qty ? ` · série ${p.target_qty}` : ''}</span></td>
                      <td className="px-2 py-2">{p.client_name}</td>
                      <td className="px-2 py-2"><Badge tone="brand">{stageInfo(p.stage).label}</Badge>{p.pending_validations > 0 && <Badge tone="warning" className="ml-1">{p.pending_validations} valid.</Badge>}</td>
                      <td className="px-2 py-2"><Badge tone={PRIORITY[p.priority].tone}>{PRIORITY[p.priority].label}</Badge></td>
                      <td className="px-2 py-2 text-ink-soft">{p.owner_name ?? '—'}</td>
                      <td className={`whitespace-nowrap px-2 py-2 ${late ? 'font-semibold text-danger-text' : ''}`}>{late && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden />}{fmtDay(p.due_date)}{late && <span className="block text-xs">en retard de {-d!} j</span>}</td>
                      <td className="px-2 py-2"><Badge tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-ink-soft"><span>Page {Math.min(page, totalPages)} / {totalPages}</span>
            <div className="flex gap-2">{page > 1 && <Link href={qs({ page: page - 1 })} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><ChevronLeft className="h-4 w-4" /> Précédent</Link>}{page < totalPages && <Link href={qs({ page: page + 1 })} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Suivant <ChevronRight className="h-4 w-4" /></Link>}</div></div>
        )}
      </div>
    </>
  )
}

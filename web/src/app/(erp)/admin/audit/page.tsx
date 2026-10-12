import type { Metadata } from 'next'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { AuditTable, AuthEventsTable } from '@/features/rbac/components/audit-table'
import { PAGE_SIZE, queryAudit, queryAuthEvents } from '@/features/rbac/services/audit-query.service'
import { AUDIT_SCOPES } from '@/lib/rbac/audit-labels'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Journal d’audit' }

type SP = { type?: string; scope?: string; actor?: string; from?: string; to?: string; page?: string }

export default async function AuditPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePermission(P.AUDIT_READ)
  const sp = await searchParams
  const type = sp.type === 'auth' ? 'auth' : 'audit'
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1)
  const filters = { type, scope: sp.scope, actor: sp.actor, from: sp.from, to: sp.to, page } as const

  const result = type === 'audit' ? await queryAudit(filters) : await queryAuthEvents(filters)
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE))

  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    const base = { type, scope: sp.scope, actor: sp.actor, from: sp.from, to: sp.to, ...over }
    for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== '') p.set(k, String(v))
    return p.toString()
  }

  return (
    <>
      <PageHeader
        title="Journal d’audit"
        description="Historique inaltérable des changements de droits, de rôles et de comptes."
        actions={
          type === 'audit' && (
            <Link href={`/admin/audit/export?${qs({ page: undefined })}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>
              <Download className="h-4 w-4" /> Exporter en CSV
            </Link>
          )
        }
      />
      <div className="space-y-4 p-6">
        <nav aria-label="Journal" className="flex gap-1 border-b border-line">
          {[
            { id: 'audit', label: 'Administration et accès' },
            { id: 'auth', label: 'Authentification' },
          ].map((t) => (
            <Link
              key={t.id}
              href={`/admin/audit?type=${t.id}`}
              aria-current={type === t.id ? 'page' : undefined}
              className={cn('-mb-px border-b-2 px-4 py-2 text-sm', type === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        <form action="/admin/audit" className="flex flex-wrap items-end gap-3" role="search">
          <input type="hidden" name="type" value={type} />
          {type === 'audit' && (
            <div>
              <Label htmlFor="scope">Action</Label>
              <select id="scope" name="scope" defaultValue={sp.scope ?? ''} className="h-9 rounded-sm border border-line-strong bg-white px-2 text-sm">
                {AUDIT_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          )}
          <div>
            <Label htmlFor="actor">{type === 'audit' ? 'Acteur ou cible' : 'E-mail'}</Label>
            <Input id="actor" name="actor" defaultValue={sp.actor} placeholder="e-mail…" className="w-56" />
          </div>
          <div>
            <Label htmlFor="from">Du</Label>
            <Input id="from" name="from" type="date" defaultValue={sp.from} className="w-40" />
          </div>
          <div>
            <Label htmlFor="to">Au</Label>
            <Input id="to" name="to" type="date" defaultValue={sp.to} className="w-40" />
          </div>
          <Button type="submit" variant="secondary">Filtrer</Button>
          <Link href={`/admin/audit?type=${type}`} className="pb-2 text-sm text-brand-600 hover:underline">Réinitialiser</Link>
        </form>

        <Card>
          {type === 'audit' ? <AuditTable rows={(result as Awaited<ReturnType<typeof queryAudit>>).rows} /> : <AuthEventsTable rows={(result as Awaited<ReturnType<typeof queryAuthEvents>>).rows} />}
          <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm text-ink-soft">
            <span>{result.total} entrée(s) · page {Math.min(page, totalPages)} / {totalPages}</span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link href={`/admin/audit?${qs({ page: page - 1 })}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><ChevronLeft className="h-4 w-4" /> Précédent</Link>
              ) : null}
              {page < totalPages ? (
                <Link href={`/admin/audit?${qs({ page: page + 1 })}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Suivant <ChevronRight className="h-4 w-4" /></Link>
              ) : null}
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewOrderDialog } from '@/features/production/components/production-forms'
import { OrdersTable, type OrderRow } from '@/features/production/components/orders-table'
import { listArticleOptions, listOrders, listWorkCenters } from '@/features/production/services/production.service'
import { createClient } from '@/lib/supabase/server'
import { ORDER_STATUS } from '@/lib/production/options'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Ordres de fabrication' }

const STATUSES = Object.keys(ORDER_STATUS)

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ statut?: string; vue?: string }> }) {
  const ctx = await requirePermission(P.PRODUCTION_READ)
  const sp = await searchParams
  const statut = STATUSES.includes(sp.statut ?? '') ? (sp.statut as string) : null
  const closed = sp.vue === 'clotures'
  const canPlan = ctx.permissions.includes(P.PRODUCTION_PLAN)
  const [orders, articles, workCenters] = await Promise.all([
    listOrders(statut, closed), canPlan ? listArticleOptions() : Promise.resolve([]), canPlan ? listWorkCenters() : Promise.resolve([]),
  ])

  // Responsable = auteur de l'ordre, résolu depuis l'annuaire de la société.
  const ids = [...new Set(orders.map((o) => o.created_by).filter((x): x is string => Boolean(x)))]
  const supabase = await createClient()
  const { data: people } = ids.length ? await supabase.from('company_directory').select('id,full_name,email').in('id', ids) : { data: [] }
  const names = new Map((people ?? []).map((p) => [p.id as string, (p.full_name as string) || (p.email as string)]))

  const rows: OrderRow[] = orders.map((o) => ({
    id: o.id,
    number: o.number,
    article: o.article_name,
    article_ref: o.article_ref,
    status: o.status,
    qty_good: Number(o.qty_good),
    qty_planned: Number(o.qty_planned),
    work_center: o.work_center_code ?? '',
    planned_end: o.planned_end,
    late_days: Number(o.late_days ?? 0),
    owner: o.created_by ? names.get(o.created_by) ?? '' : '',
    closed: Boolean(o.closed_at),
  }))

  const chip = (on: boolean) => cn('rounded-full border px-3 py-1 text-sm transition-colors duration-150', on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-surface text-ink-soft hover:text-ink')
  const href = (s: string | null, c = false) => `/production/ordres${s || c ? `?${[s ? `statut=${s}` : '', c ? 'vue=clotures' : ''].filter(Boolean).join('&')}` : ''}`

  return (
    <>
      <PageHeader title="Ordres de fabrication" description="Recherchez, filtrez et triez les ordres. Enregistrez vos vues et exportez-les."
        actions={canPlan && <NewOrderDialog articles={articles} workCenters={workCenters} />} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2">
          <Link href={href(null)} className={chip(!statut && !closed)}>Ouverts</Link>
          {STATUSES.map((s) => <Link key={s} href={href(s)} className={chip(statut === s)}>{ORDER_STATUS[s].label}</Link>)}
          <Link href={href(null, true)} className={chip(closed)}>Clôturés</Link>
        </div>
        <OrdersTable rows={rows} />
      </div>
    </>
  )
}

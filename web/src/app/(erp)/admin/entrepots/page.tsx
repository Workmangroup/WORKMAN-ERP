import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { WarehouseAccessMatrix, type UserRowLite, type WhCol } from '@/features/admin/components/warehouse-access-matrix'
import { listUsers } from '@/features/rbac/services/rbac.service'
import { createClient } from '@/lib/supabase/server'
import type { WarehouseRole } from '@/lib/admin/matrix'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Entrepôts et accès' }

/** Qui accède à quel entrepôt, avec quel rôle. Le bilan montre les entrepôts refusés pour chaque personne. */
export default async function WarehouseAccessPage() {
  const ctx = await requirePermission(P.WAREHOUSES_ALL)
  const canEdit = ctx.permissions.includes(P.WAREHOUSES_MANAGE)
  const supabase = await createClient()
  const [{ data: whs }, { data: grants }, users] = await Promise.all([
    supabase.from('warehouses').select('id,name,code').is('archived_at', null).order('name'),
    supabase.from('user_warehouses').select('user_id,warehouse_id,role').eq('active', true),
    listUsers(),
  ])
  const warehouses: WhCol[] = ((whs ?? []) as { id: string; name: string; code: string }[])
  const rows: UserRowLite[] = users.map((u) => ({ id: u.id, name: (u.full_name as string) || u.email, email: u.email }))
  const map: Record<string, Record<string, WarehouseRole>> = {}
  for (const g of (grants ?? []) as { user_id: string; warehouse_id: string; role: WarehouseRole }[]) {
    map[g.user_id] = { ...(map[g.user_id] ?? {}), [g.warehouse_id]: g.role }
  }
  return (
    <>
      <PageHeader title="Entrepôts et accès" description="Chaque personne ne voit et ne modifie que les entrepôts qui lui sont accordés. Le bilan indique ce qui est refusé." />
      <div className="p-4 sm:p-6">
        <WarehouseAccessMatrix users={rows} warehouses={warehouses} grants={map} canEdit={canEdit} />
      </div>
    </>
  )
}

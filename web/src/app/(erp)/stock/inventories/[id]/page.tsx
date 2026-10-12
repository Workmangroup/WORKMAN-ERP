import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import { z } from 'zod'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { cancelInventoryAction, validateInventoryAction } from '@/features/stock/actions'
import { AddLine, CountTable } from '@/features/stock/components/inventory-components'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { getInventory } from '@/features/stock/services/stock.service'
import { INVENTORY_STATUS } from '@/lib/stock/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Inventaire' }

export default async function InventoryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission(P.STOCK_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const data = await getInventory(id)
  if (!data) notFound()
  const { inv, lines, locations } = data
  const supabase = await createClient()
  const { data: mats } = await supabase.from('bom_materials').select('id,code,name').is('archived_at', null).order('name').limit(3000)
  const open = inv.status === 'draft'
  const canWrite = ctx.permissions.includes(P.STOCK_WRITE) && open
  const canValidate = ctx.permissions.includes(P.STOCK_ADJUST) && open
  const counted = lines.filter((l) => l.counted_qty !== null).length
  return (
    <>
      <PageHeader title={`${inv.code} — ${inv.warehouse_code}${inv.location_code ? ` / ${inv.location_code}` : ''}`} description={inv.note ?? 'Inventaire physique'}
        actions={<>
          <Link href="/stock/inventories" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Inventaires</Link>
          {canValidate && <RpcButton action={validateInventoryAction} fields={{ id: inv.id }} variant="command" size="sm" confirm="Valider l’inventaire ? Les écarts seront appliqués au stock et ne pourront plus être modifiés."><CheckCircle2 className="h-4 w-4" /> Valider et appliquer</RpcButton>}
          {canWrite && <RpcButton action={cancelInventoryAction} fields={{ id: inv.id }} variant="command" size="sm" className="text-danger-text" confirm="Annuler cet inventaire ?">Annuler</RpcButton>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={INVENTORY_STATUS[inv.status].tone}>{INVENTORY_STATUS[inv.status].label}</Badge>
          <span className="text-ink-soft">{counted} / {lines.length} ligne(s) comptée(s) · créé le {formatDateTime(inv.created_at)}{inv.closed_at ? ` · clos le ${formatDateTime(inv.closed_at)}` : ''}</span>
        </div>
        {open && !canValidate && <p className="text-xs text-ink-soft">Saisissez les quantités comptées ; la validation est réservée aux personnes ayant le droit d’ajuster le stock.</p>}
        {open && <p className="text-xs text-ink-soft">Les lignes non comptées sont ignorées. L’écart appliqué = compté − stock réel au moment de la validation.</p>}
        <CountTable lines={lines} editable={canWrite} />
        {canWrite && <AddLine inventoryId={inv.id} materials={(mats ?? []) as { id: string; code: string; name: string }[]} locations={locations} />}
      </div>
    </>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Lock } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { AccessPanel } from '@/features/warehouses/components/access-panel'
import { BinDialog, EditWarehouseDialog, ZoneDialog } from '@/features/warehouses/components/warehouse-forms'
import { WarehouseTimeline } from '@/features/warehouses/components/timeline'
import { candidateUsers, getWarehouse, listAccess, listBins, listZones, warehouseHistory } from '@/features/warehouses/services/warehouses.service'
import { BIN_KINDS, kindLabel, roleLabel, roleTone, zoneTypeLabel } from '@/lib/warehouses/options'
import { P } from '@/lib/rbac/permissions'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Entrepôt' }

const TABS = [
  { id: 'overview', label: 'Vue d’ensemble' }, { id: 'zones', label: 'Zones' }, { id: 'bins', label: 'Emplacements' },
  { id: 'access', label: 'Accès et responsables' }, { id: 'history', label: 'Traçabilité' },
] as const

export default async function WarehousePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; created?: string }> }) {
  const ctx = await requirePermission(P.STOCK_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const tab = (TABS.find((t) => t.id === sp.tab)?.id ?? 'overview') as (typeof TABS)[number]['id']
  // Entrepôt non affecté : la base ne le renvoie pas → 404 (aucune fuite d'information)
  const w = await getWarehouse(id, ctx.profile.id)
  if (!w) notFound()
  const canManage = w.role === 'manager' || ctx.permissions.includes(P.WAREHOUSES_MANAGE)
  const [zones, bins, access, history] = await Promise.all([
    tab === 'zones' || tab === 'overview' || tab === 'bins' ? listZones(id) : Promise.resolve([]),
    tab === 'bins' || tab === 'overview' ? listBins(id) : Promise.resolve([]),
    tab === 'access' ? listAccess(id) : Promise.resolve([]),
    tab === 'history' ? warehouseHistory(id) : Promise.resolve([]),
  ])
  const activeIds = access.filter((a) => a.active).map((a) => a.user_id)
  const candidates = tab === 'access' && canManage ? await candidateUsers(id, activeIds) : []
  const zonesActive = zones.filter((z) => !z.archived_at)

  return (
    <>
      <PageHeader title={`${w.code} — ${w.name}`} description={`${kindLabel(w.kind)}${w.city ? ` · ${w.city}` : ''}${w.address ? ` · ${w.address}` : ''}`}
        actions={<>
          <Link href="/warehouses" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Entrepôts</Link>
          <Link href="/stock/warehouses" className={buttonVariants({ variant: 'command', size: 'sm' })}>Stock</Link>
          {canManage && <EditWarehouseDialog w={w} />}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        {sp.created && <Alert tone="success">Entrepôt créé. Vous en êtes le responsable : ajoutez ses zones, ses emplacements et ses utilisateurs.</Alert>}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={roleTone(w.role)}>Votre rôle : {roleLabel(w.role)}</Badge>
          {!canManage && <span className="inline-flex items-center gap-1 text-ink-soft"><Lock className="h-3.5 w-3.5" aria-hidden />Lecture ou opération uniquement : la gestion de cet entrepôt est réservée à ses responsables.</span>}
          {w.archived_at && <Badge tone="neutral">Archivé</Badge>}
        </div>

        <nav aria-label="Sections de l’entrepôt" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {TABS.map((t) => (
            <Link key={t.id} href={t.id === 'overview' ? `/warehouses/${id}` : `/warehouses/${id}?tab=${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>{t.label}</Link>
          ))}
        </nav>

        {tab === 'overview' && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Zones</CardTitle></CardHeader><CardContent>
              {zonesActive.length === 0 ? <p className="text-sm text-ink-soft">Aucune zone définie.</p> : <ul className="space-y-1 text-sm">{zonesActive.map((z) => <li key={z.id} className="flex justify-between gap-2"><span><span className="font-mono text-xs">{z.code}</span> {z.name}</span><span className="text-ink-soft">{zoneTypeLabel(z.zone_type)} · {z.bins} empl.</span></li>)}</ul>}
              <Link href={`/warehouses/${id}?tab=zones`} className="mt-3 inline-block text-sm text-brand-700 hover:underline">Gérer les zones</Link>
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Emplacements</CardTitle></CardHeader><CardContent>
              <p className="text-sm">{bins.filter((b) => !b.archived_at).length} emplacement(s) actif(s)</p>
              <Link href={`/warehouses/${id}?tab=bins`} className="mt-3 inline-block text-sm text-brand-700 hover:underline">Gérer les emplacements</Link>
            </CardContent></Card>
          </div>
        )}

        {tab === 'zones' && (
          <Card><CardHeader><CardTitle className="flex items-center justify-between"><span>Zones de l’entrepôt</span>{canManage && <ZoneDialog warehouseId={id} />}</CardTitle></CardHeader><CardContent className="p-0">
            <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Code</th><th className="px-2 py-2 font-semibold">Nom</th><th className="px-2 py-2 font-semibold">Type</th><th className="px-2 py-2 text-right font-semibold">Emplacements</th><th className="px-2 py-2 font-semibold">État</th><th className="px-2 py-2" /></tr></thead>
              <tbody className="divide-y divide-line">{zones.map((z) => (
                <tr key={z.id} className={cn(z.archived_at && 'text-ink-faint')}>
                  <td className="px-4 py-2 font-mono text-xs">{z.code}</td><td className="px-2 py-2">{z.name}</td><td className="px-2 py-2">{zoneTypeLabel(z.zone_type)}</td><td className="px-2 py-2 text-right tabular-nums">{z.bins}</td>
                  <td className="px-2 py-2">{z.archived_at ? <Badge tone="neutral">Archivée</Badge> : <Badge tone="success">Active</Badge>}</td>
                  <td className="px-2 py-2 text-right">{canManage && <div className="flex justify-end gap-1"><ZoneDialog warehouseId={id} z={z} /></div>}</td>
                </tr>))}
                {zones.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-soft">Aucune zone.</td></tr>}
              </tbody></table></div>
          </CardContent></Card>
        )}

        {tab === 'bins' && (
          <Card><CardHeader><CardTitle className="flex items-center justify-between"><span>Emplacements (allées, racks, zones de réception)</span>{canManage && <BinDialog warehouseId={id} zones={zones} />}</CardTitle></CardHeader><CardContent className="p-0">
            <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Code</th><th className="px-2 py-2 font-semibold">Nom</th><th className="px-2 py-2 font-semibold">Usage</th><th className="px-2 py-2 font-semibold">Zone</th><th className="px-2 py-2" /></tr></thead>
              <tbody className="divide-y divide-line">{bins.map((b) => (
                <tr key={b.id} className={cn(b.archived_at && 'text-ink-faint')}>
                  <td className="px-4 py-2 font-mono text-xs">{b.code}{b.code === 'GEN' && <Badge tone="neutral" className="ml-2">Général</Badge>}</td><td className="px-2 py-2">{b.name ?? '—'}</td>
                  <td className="px-2 py-2">{BIN_KINDS.find((k) => k.value === b.kind)?.label ?? b.kind}</td><td className="px-2 py-2">{b.zone ?? <span className="text-ink-faint">—</span>}</td>
                  <td className="px-2 py-2 text-right">{canManage && <BinDialog warehouseId={id} zones={zones} b={b} />}</td>
                </tr>))}
                {bins.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">Aucun emplacement.</td></tr>}
              </tbody></table></div>
            <p className="px-4 py-2 text-xs text-ink-faint">Zones actives : {zonesActive.map((z) => z.code).join(', ') || 'aucune'}</p>
          </CardContent></Card>
        )}

        {tab === 'access' && (
          <AccessPanel warehouseId={id} rows={access} candidates={candidates} canManage={canManage} />
        )}

        {tab === 'history' && (
          <Card><CardHeader><CardTitle>Traçabilité de l’entrepôt</CardTitle></CardHeader><CardContent><WarehouseTimeline rows={history} /></CardContent></Card>
        )}
      </div>
    </>
  )
}

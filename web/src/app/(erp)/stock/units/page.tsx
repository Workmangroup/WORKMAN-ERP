import type { Metadata } from 'next'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requireAnyPermission } from '@/features/auth/guards'
import { DefectUnitForm, ReceiveUnitForm } from '@/features/stock/components/unit-forms'
import { consumeUnitAction } from '@/features/stock/units-actions'
import { listUnits, unitTrace } from '@/features/stock/services/units.service'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Unités et lots' }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  available: { label: 'Disponible', tone: 'success' }, quarantine: { label: 'Quarantaine', tone: 'danger' }, consumed: { label: 'Consommée', tone: 'neutral' },
}
const EVENT_LABEL: Record<string, string> = { receive: 'Réception', move: 'Déplacement', defect: 'Défaut', quarantine: 'Quarantaine', release: 'Libération', consume: 'Consommation' }

export default async function UnitsPage({ searchParams }: { searchParams: Promise<{ unit?: string }> }) {
  const ctx = await requireAnyPermission(P.STOCK_READ)
  const sp = await searchParams
  const canWrite = ctx.permissions.includes(P.STOCK_WRITE)
  const units = await listUnits()
  const selected = sp.unit && /^[0-9a-f-]{36}$/i.test(sp.unit) ? sp.unit : null
  const trace = selected ? await unitTrace(selected) : null
  let form: null | { materials: { id: string; name: string; family: string }[]; lots: { id: string; code: string; material_id: string }[]; warehouses: { id: string; label: string }[]; locations: { id: string; warehouse_id: string; code: string }[] } = null
  if (canWrite) {
    const supabase = await createClient()
    const { data: access } = await supabase.rpc('wh_my_access')
    const whs = ((access ?? []) as { warehouse_id: string; code: string; name: string }[])
    const whIds = whs.map((w) => w.warehouse_id)
    const [mats, lots, locs] = await Promise.all([
      supabase.from('bom_materials').select('id,name,family').is('archived_at', null).order('name').limit(500),
      supabase.from('material_lots').select('id,lot_code,material_id').order('lot_code').limit(500),
      whIds.length ? supabase.from('stock_locations').select('id,warehouse_id,code').in('warehouse_id', whIds).is('archived_at', null).order('code') : Promise.resolve({ data: [] }),
    ])
    form = {
      materials: (mats.data ?? []).map((m) => ({ id: m.id as string, name: m.name as string, family: m.family as string })),
      lots: (lots.data ?? []).map((l) => ({ id: l.id as string, code: l.lot_code as string, material_id: l.material_id as string })),
      warehouses: whs.map((w) => ({ id: w.warehouse_id, label: `${w.code} — ${w.name}` })),
      locations: (locs.data ?? []).map((l) => ({ id: l.id as string, warehouse_id: l.warehouse_id as string, code: l.code as string })),
    }
  }
  const t = trace?.data
  const tu = t?.unit as Record<string, unknown> | undefined
  return (
    <>
      <PageHeader title="Unités et lots" description="Rouleaux et pièces : longueur, largeur, bain, défauts, localisation et propriété. Seuls les entrepôts qui vous sont affectés sont visibles." />
      <div className="space-y-4 p-4 sm:p-6">
        {canWrite && form && form.warehouses.length > 0 && <ReceiveUnitForm materials={form.materials} lots={form.lots} warehouses={form.warehouses} locations={form.locations} />}
        {canWrite && form && form.warehouses.length === 0 && <Alert tone="info">Aucun entrepôt ne vous est affecté : la réception n’est pas possible.</Alert>}
        {trace?.error && <Alert tone="error">Traçabilité indisponible pour cette unité (hors de votre périmètre ou introuvable).</Alert>}

        <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-semibold">Unité</th><th className="px-2 py-2 font-semibold">Composant</th><th className="px-2 py-2 font-semibold">Entrepôt · emplacement</th><th className="px-2 py-2 text-right font-semibold">Quantité</th><th className="px-2 py-2 text-right font-semibold">Largeur</th><th className="px-2 py-2 font-semibold">Bain</th><th className="px-2 py-2 font-semibold">Propriété</th><th className="px-2 py-2 font-semibold">État</th><th className="px-4 py-2 font-semibold">Reçue le</th></tr></thead>
            <tbody className="divide-y divide-line">
              {units.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-ink-soft">Aucune unité visible.</td></tr>}
              {units.map((u) => (
                <tr key={u.id} className="hover:bg-canvas/60">
                  <td className="px-4 py-2 font-mono"><Link href={`/stock/units?unit=${u.id}`} className="font-semibold text-brand-700 hover:underline">{u.code}</Link></td>
                  <td className="px-2 py-2">{u.material_name}</td>
                  <td className="px-2 py-2 text-xs">{u.warehouse} · {u.location}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{u.length_m != null ? `${u.length_m} m` : u.qty}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{u.width_cm ?? '—'}</td>
                  <td className="px-2 py-2">{u.dye_bath ?? '—'}</td>
                  <td className="px-2 py-2">{u.owner}</td>
                  <td className="px-2 py-2"><Badge tone={STATUS[u.status]?.tone ?? 'neutral'}>{STATUS[u.status]?.label ?? u.status}</Badge></td>
                  <td className="whitespace-nowrap px-4 py-2">{formatDateTime(u.received_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {tu && t && (
          <section className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-base font-semibold">Traçabilité {String(tu.code)}</h2>
            <p className="text-sm text-ink-soft">{tu.owner === 'client' ? 'Propriété client (hors stock société)' : 'Propriété société (stock)'} · {tu.stock_posted ? 'mouvement de stock suivi' : 'pas de mouvement de stock société'} · état {STATUS[String(tu.status)]?.label ?? String(tu.status)}{tu.dye_bath ? ` · bain ${String(tu.dye_bath)}` : ''}</p>
            <ol className="space-y-1 text-sm">
              {(t.events as { seq: number; event: string; reason: string | null; at: string }[]).map((e) => (
                <li key={e.seq}><span className="font-medium">{EVENT_LABEL[e.event] ?? e.event}</span> · {formatDateTime(e.at)}{e.reason ? ` · ${e.reason}` : ''}</li>
              ))}
            </ol>
            {(t.defects as { code: string; severity: string; description: string; length_affected_m: number | null }[]).length > 0 && (
              <div className="text-sm">
                <p className="font-semibold">Défauts</p>
                <ul className="list-disc pl-5">{(t.defects as { code: string; severity: string; description: string; length_affected_m: number | null }[]).map((d, i) => <li key={i}>{d.code} ({d.severity}) — {d.description}{d.length_affected_m != null ? ` · ${d.length_affected_m} m` : ''}</li>)}</ul>
              </div>
            )}
            {canWrite && tu.status !== 'consumed' && <DefectUnitForm unitId={String(tu.id)} maxLength={Number(tu.qty)} />}
            {canWrite && tu.status === 'available' && (
              <RpcButton action={consumeUnitAction} fields={{ unit_id: String(tu.id) }} variant="command" size="sm" confirm="Consommer cette unité ? Elle ne sera plus disponible.">Consommer</RpcButton>
            )}
            <Link href="/stock/units" className={buttonVariants({ variant: 'command', size: 'sm' })}>Fermer</Link>
          </section>
        )}
      </div>
    </>
  )
}

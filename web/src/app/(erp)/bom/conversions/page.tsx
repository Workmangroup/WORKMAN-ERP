import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ConversionForm } from '@/features/units/components/conversion-form'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Unités et conversions' }

/** Unités des composants, caractéristiques explicites (rouleau, largeur, grammage) et conversions saisies. Rien n'est déduit ici. */
export default async function UnitsPage() {
  const ctx = await requirePermission(P.BOM_READ)
  const supabase = await createClient()
  const [mats, units, convs] = await Promise.all([
    supabase.from('bom_materials').select('id, code, name, unit, roll_length_m, width_m, grammage_g_m2').is('archived_at', null).order('code').limit(300),
    supabase.from('measurement_units').select('code, label, dimension').order('code'),
    supabase.from('material_unit_conversions').select('material_id, from_unit, to_unit, factor, basis').order('created_at', { ascending: false }).limit(200),
  ])
  const materials = (mats.data ?? []) as { id: string; code: string; name: string; unit: string; roll_length_m: number | null; width_m: number | null; grammage_g_m2: number | null }[]
  const byId = new Map(materials.map((m) => [m.id, m]))
  const canWrite = ctx.permissions.includes(P.BOM_WRITE)
  return (
    <>
      <PageHeader title="Unités et conversions" description="Chaque composant garde son unité. Une conversion n’existe que si elle est saisie avec sa source, ou dérivée d’une caractéristique explicite (longueur de rouleau, largeur, grammage)." />
      <div className="space-y-6 p-4 sm:p-6">
        <section className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
              <tr><th className="px-3 py-2">Code</th><th className="px-3 py-2">Composant</th><th className="px-3 py-2">Unité</th><th className="px-3 py-2">Rouleau</th><th className="px-3 py-2">Largeur</th><th className="px-3 py-2">Grammage</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {materials.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-2 font-mono">{m.code}</td>
                  <td className="px-3 py-2">{m.name}</td>
                  <td className="px-3 py-2"><Badge tone="neutral">{m.unit}</Badge></td>
                  <td className="px-3 py-2">{m.roll_length_m ? `${m.roll_length_m} m` : '—'}</td>
                  <td className="px-3 py-2">{m.width_m ? `${m.width_m} m` : '—'}</td>
                  <td className="px-3 py-2">{m.grammage_g_m2 ? `${m.grammage_g_m2} g/m²` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-ink">Conversions saisies</h2>
          {(convs.data ?? []).length === 0 ? (
            <p className="text-sm text-ink-soft">Aucune conversion saisie.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
              {(convs.data ?? []).map((c, i) => {
                const m = byId.get(c.material_id as string)
                return (
                  <li key={i} className="p-3 text-sm">
                    <span className="font-mono">{m?.code ?? '—'}</span> · 1 {c.from_unit} = {Number(c.factor)} {c.to_unit} <span className="text-ink-soft">· source : {c.basis}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {canWrite && (
          <section className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-base font-semibold text-ink">Saisir une conversion</h2>
            <ConversionForm materials={materials.map((m) => ({ id: m.id, code: m.code, name: m.name }))} units={(units.data ?? []) as { code: string; label: string }[]} />
          </section>
        )}
      </div>
    </>
  )
}

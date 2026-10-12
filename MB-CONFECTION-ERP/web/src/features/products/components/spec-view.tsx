import { Droplets, FlaskConical, Package, Palette, Ruler, Shirt, Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BLEACH, DRY_CLEAN, GENDERS, IRON, TUMBLE, WASH, label, type ProductSpec } from '@/lib/products/options'

const ok = (s: string | number | undefined | null) => (s !== undefined && s !== null && String(s).trim() !== '' ? s : null)

/** Rendu lisible d'une version de la fiche technique : technique, couleurs, tailles, variantes, mesures, entretien, packaging. */
export function SpecView({ spec }: { spec: ProductSpec }) {
  const t = spec.tech ?? {}
  const p = spec.packaging ?? {}
  const c = spec.care ?? {}
  const dims = p.carton_dims_cm && (p.carton_dims_cm.l || p.carton_dims_cm.w || p.carton_dims_cm.h) ? `${p.carton_dims_cm.l ?? '?'} × ${p.carton_dims_cm.w ?? '?'} × ${p.carton_dims_cm.h ?? '?'} cm` : null
  const careRows = [c.wash && label(WASH, c.wash), c.bleach && label(BLEACH, c.bleach), c.tumble && label(TUMBLE, c.tumble), c.iron && label(IRON, c.iron), c.dry_clean && label(DRY_CLEAN, c.dry_clean)].filter(Boolean) as string[]
  const techRows: [string, string | number | null][] = [
    ['Composition', ok(t.composition)], ['Tissu', ok(t.fabric)], ['Grammage', t.weight_gsm ? `${t.weight_gsm} g/m²` : null], ['Saison', ok(t.season)],
    ['Genre', t.gender ? label(GENDERS, t.gender) : null], ['Construction', ok(t.construction)], ['Finitions', ok(t.finishing)],
  ]
  const hasTech = techRows.some(([, v]) => v !== null) || ok(t.notes)
  const hasPackaging = Boolean(ok(p.unit) || p.units_per_carton || p.carton_weight_kg || dims || ok(p.labeling) || ok(p.instructions))
  const variantByKey = new Map(spec.variants.map((v) => [`${v.color ?? ''}|${v.size ?? ''}`, v]))
  const sizeLabels = spec.sizes.map((s) => s.label)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="flex items-center gap-2"><FlaskConical className="h-4 w-4 text-brand-500" /> Fiche technique</CardTitle></CardHeader>
        <CardContent>
          {!hasTech ? <p className="text-sm text-ink-soft">Aucune donnée technique.</p> : (
            <>
              <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {techRows.filter(([, v]) => v !== null).map(([k, v]) => <div key={k} className="flex gap-2"><dt className="w-28 shrink-0 text-ink-soft">{k}</dt><dd className="font-medium">{v}</dd></div>)}
              </dl>
              {ok(t.notes) && <p className="mt-3 whitespace-pre-wrap rounded-sm bg-canvas p-3 text-sm">{t.notes}</p>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Palette className="h-4 w-4 text-brand-500" /> Couleurs ({spec.colors.length})</CardTitle></CardHeader>
        <CardContent>
          {spec.colors.length === 0 ? <p className="text-sm text-ink-soft">Aucune couleur.</p> : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {spec.colors.map((col) => (
                <li key={col.name} className="flex items-center gap-3 rounded-md border border-line p-2.5">
                  <span className="h-9 w-9 shrink-0 rounded-md border border-line-strong shadow-inner" style={{ background: col.hex || '#e1dfdd' }} aria-hidden />
                  <span className="min-w-0 text-sm"><span className="block truncate font-semibold">{col.name}</span><span className="block truncate text-xs text-ink-soft">{[col.pantone, col.client_code && `client ${col.client_code}`, col.hex].filter(Boolean).join(' · ') || '—'}</span></span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Ruler className="h-4 w-4 text-brand-500" /> Tailles ({spec.sizes.length})</CardTitle></CardHeader>
        <CardContent>
          {spec.sizes.length === 0 ? <p className="text-sm text-ink-soft">Aucune taille.</p> : (
            <ul className="flex flex-wrap gap-2">{spec.sizes.map((s) => <li key={s.label} className="rounded-md border border-line bg-canvas px-3 py-1.5 text-sm font-semibold">{s.label}{s.client_code && <span className="ml-1 text-xs font-normal text-ink-soft">({s.client_code})</span>}</li>)}</ul>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="flex items-center gap-2"><Tag className="h-4 w-4 text-brand-500" /> Variantes ({spec.variants.filter((v) => v.active !== false).length} actives / {spec.variants.length})</CardTitle></CardHeader>
        <CardContent>
          {spec.variants.length === 0 ? <p className="text-sm text-ink-soft">Aucune variante : générez la matrice couleurs × tailles dans l’éditeur de la fiche.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead><tr className="border-b border-line text-left text-xs text-ink-soft"><th className="py-1.5 pr-3 font-semibold">Couleur</th>{sizeLabels.map((s) => <th key={s} className="px-2 py-1.5 text-center font-semibold">{s}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">
                  {spec.colors.map((col) => (
                    <tr key={col.name}>
                      <td className="py-1.5 pr-3 font-medium"><span className="mr-2 inline-block h-3 w-3 rounded-full border border-line-strong align-middle" style={{ background: col.hex || '#e1dfdd' }} aria-hidden />{col.name}</td>
                      {sizeLabels.map((s) => {
                        const v = variantByKey.get(`${col.name}|${s}`)
                        return <td key={s} className="px-2 py-1.5 text-center">{v ? <span title={`${v.sku}${v.barcode ? ` · ${v.barcode}` : ''}`} className={v.active === false ? 'text-ink-faint line-through' : 'font-mono text-xs text-ink'}>{v.active === false ? 'inactive' : v.sku}</span> : <span className="text-ink-faint">—</span>}</td>
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="flex items-center gap-2"><Ruler className="h-4 w-4 text-brand-500" /> Tableau de mesures (cm)</CardTitle></CardHeader>
        <CardContent>
          {spec.measurements.length === 0 ? <p className="text-sm text-ink-soft">Aucune mesure.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead><tr className="border-b border-line text-left text-xs text-ink-soft"><th className="py-1.5 pr-3 font-semibold">Point de mesure</th><th className="px-2 py-1.5 text-right font-semibold">Tol. ±</th>{sizeLabels.map((s) => <th key={s} className="px-2 py-1.5 text-right font-semibold">{s}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">
                  {spec.measurements.map((m) => (
                    <tr key={m.point}><td className="py-1.5 pr-3 font-medium">{m.point}</td><td className="px-2 py-1.5 text-right tabular-nums text-ink-soft">{m.tolerance ?? '—'}</td>
                      {sizeLabels.map((s) => <td key={s} className="px-2 py-1.5 text-right tabular-nums">{m.values?.[s] ?? <span className="text-ink-faint">—</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Droplets className="h-4 w-4 text-brand-500" /> Entretien</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {careRows.length === 0 && !ok(c.instructions) ? <p className="text-sm text-ink-soft">Aucune consigne.</p> : (
            <>
              <ul className="flex flex-wrap gap-1.5">{careRows.map((r) => <li key={r}><Badge tone="neutral"><Shirt className="mr-1 h-3 w-3" />{r}</Badge></li>)}</ul>
              {ok(c.instructions) && <p className="whitespace-pre-wrap text-sm">{c.instructions}</p>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Package className="h-4 w-4 text-brand-500" /> Packaging</CardTitle></CardHeader>
        <CardContent>
          {!hasPackaging ? <p className="text-sm text-ink-soft">Aucune donnée de conditionnement.</p> : (
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              {ok(p.unit) && <><dt className="text-ink-soft">Unité de vente</dt><dd className="font-medium">{p.unit}</dd></>}
              {p.units_per_carton ? <><dt className="text-ink-soft">Pièces / carton</dt><dd className="font-medium">{p.units_per_carton}</dd></> : null}
              {p.carton_weight_kg ? <><dt className="text-ink-soft">Poids du carton</dt><dd className="font-medium">{p.carton_weight_kg} kg</dd></> : null}
              {dims && <><dt className="text-ink-soft">Dimensions</dt><dd className="font-medium">{dims}</dd></>}
              {ok(p.labeling) && <><dt className="text-ink-soft">Étiquetage</dt><dd className="font-medium">{p.labeling}</dd></>}
              {ok(p.instructions) && <><dt className="text-ink-soft">Consignes</dt><dd className="whitespace-pre-wrap font-medium">{p.instructions}</dd></>}
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

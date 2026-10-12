import { Droplets, Package, Palette, Ruler, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BLEACH, DRY_CLEAN, IRON, TUMBLE, WASH, label, type ArticleSpec } from '@/lib/articles/options'

const ok = (s: string | undefined) => (s && s.trim() ? s : null)
const daysLeft = (d?: string) => (d ? Math.ceil((new Date(d + 'T23:59:59').getTime() - Date.now()) / 86_400_000) : null)

/** Rendu lisible de la fiche d'une version (couleurs, tailles, normes, packaging, lavage). */
export function SpecView({ spec }: { spec: ArticleSpec }) {
  const p = spec.packaging ?? {}
  const c = spec.care ?? {}
  const dims = p.carton_dims_cm && (p.carton_dims_cm.l || p.carton_dims_cm.w || p.carton_dims_cm.h) ? `${p.carton_dims_cm.l ?? '?'} × ${p.carton_dims_cm.w ?? '?'} × ${p.carton_dims_cm.h ?? '?'} cm` : null
  const careRows = [
    c.wash && label(WASH, c.wash), c.bleach && label(BLEACH, c.bleach), c.tumble && label(TUMBLE, c.tumble), c.iron && label(IRON, c.iron), c.dry_clean && label(DRY_CLEAN, c.dry_clean),
  ].filter(Boolean) as string[]
  const hasPackaging = Boolean(ok(p.unit) || p.units_per_carton || p.carton_weight_kg || dims || ok(p.labeling) || ok(p.instructions))

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Palette className="h-4 w-4 text-brand-500" /> Couleurs ({spec.colors.length})</CardTitle></CardHeader>
        <CardContent>
          {spec.colors.length === 0 ? <p className="text-sm text-ink-soft">Aucune couleur.</p> : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {spec.colors.map((col) => (
                <li key={col.name} className="flex items-center gap-3 rounded-md border border-line p-2.5">
                  <span className="h-9 w-9 shrink-0 rounded-md border border-line-strong shadow-inner" style={{ background: col.hex || '#e1dfdd' }} aria-hidden />
                  <span className="min-w-0 text-sm">
                    <span className="block truncate font-semibold">{col.name}</span>
                    <span className="block truncate text-xs text-ink-soft">{[col.code, col.pantone, col.client_code && `client ${col.client_code}`].filter(Boolean).join(' · ') || '—'}</span>
                  </span>
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
            <ul className="flex flex-wrap gap-2">{spec.sizes.map((s) => <li key={s.label} className="rounded-sm border border-line-strong bg-white px-3 py-1 text-sm font-semibold">{s.label}</li>)}</ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-brand-500" /> Normes ({spec.norms.length})</CardTitle></CardHeader>
        <CardContent>
          {spec.norms.length === 0 ? <p className="text-sm text-ink-soft">Aucune norme.</p> : (
            <ul className="space-y-2">
              {spec.norms.map((n) => {
                const d = daysLeft(n.valid_until)
                return (
                  <li key={n.code} className="rounded-md border border-line p-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{n.code}</span>{n.class && <Badge tone="brand">Classe {n.class}</Badge>}
                      {d !== null && (d < 0 ? <Badge tone="danger">Expirée</Badge> : d <= 60 ? <Badge tone="warning">Expire dans {d} j</Badge> : <Badge>Valide jusqu’au {new Date(n.valid_until + 'T12:00:00').toLocaleDateString('fr-FR')}</Badge>)}
                    </div>
                    {(n.label || n.certificate_ref) && <p className="mt-0.5 text-xs text-ink-soft">{[n.label, n.certificate_ref && `certificat ${n.certificate_ref}`].filter(Boolean).join(' · ')}</p>}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Package className="h-4 w-4 text-brand-500" /> Packaging</CardTitle></CardHeader>
        <CardContent>
          {!hasPackaging ? <p className="text-sm text-ink-soft">Non renseigné.</p> : (
            <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              {ok(p.unit) && <><dt className="text-ink-soft">Unitaire</dt><dd className="font-medium">{p.unit}</dd></>}
              {p.units_per_carton && <><dt className="text-ink-soft">Pièces / carton</dt><dd className="font-medium">{p.units_per_carton}</dd></>}
              {p.carton_weight_kg !== undefined && <><dt className="text-ink-soft">Poids carton</dt><dd className="font-medium">{p.carton_weight_kg} kg</dd></>}
              {dims && <><dt className="text-ink-soft">Dimensions</dt><dd className="font-medium">{dims}</dd></>}
              {ok(p.labeling) && <><dt className="text-ink-soft">Étiquetage</dt><dd className="font-medium">{p.labeling}</dd></>}
              {ok(p.instructions) && <><dt className="text-ink-soft">Instructions</dt><dd className="whitespace-pre-wrap font-medium">{p.instructions}</dd></>}
            </dl>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="flex items-center gap-2"><Droplets className="h-4 w-4 text-brand-500" /> Instructions de lavage</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {careRows.length === 0 && !ok(c.composition) && !ok(c.instructions) ? <p className="text-sm text-ink-soft">Non renseignées.</p> : (
            <>
              {careRows.length > 0 && <ul className="flex flex-wrap gap-2">{careRows.map((r) => <li key={r} className="rounded-sm border border-line-strong bg-white px-2.5 py-1 text-sm">{r}</li>)}</ul>}
              {ok(c.composition) && <p className="text-sm"><span className="text-ink-soft">Composition : </span><span className="font-medium">{c.composition}</span></p>}
              {ok(c.instructions) && <p className="whitespace-pre-wrap text-sm text-ink-soft">{c.instructions}</p>}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

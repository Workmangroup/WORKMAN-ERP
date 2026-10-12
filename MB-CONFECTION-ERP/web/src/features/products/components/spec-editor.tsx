'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { FlaskConical, Package, Palette, Plus, Ruler, Shirt, Tag, Trash2, Wand2, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { SubmitButton } from '@/components/auth/submit-button'
import {
  BLEACH, DRY_CLEAN, GENDERS, IRON, MEASURE_PRESETS, SEASONS, SIZE_PRESETS, TUMBLE, WASH, buildVariants,
  type ProductSpec,
} from '@/lib/products/options'
import { cn } from '@/lib/utils'
import { saveSpecAction } from '../actions'

const TABS = [
  { id: 'tech', label: 'Technique', icon: FlaskConical },
  { id: 'colors', label: 'Couleurs', icon: Palette },
  { id: 'sizes', label: 'Tailles', icon: Ruler },
  { id: 'variants', label: 'Variantes', icon: Tag },
  { id: 'measures', label: 'Mesures', icon: Ruler },
  { id: 'care', label: 'Entretien', icon: Shirt },
  { id: 'packaging', label: 'Packaging', icon: Package },
] as const
type Tab = (typeof TABS)[number]['id']

const num = (v: string) => {
  if (v.trim() === '') return undefined
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : undefined
}

/** Éditeur de la fiche technique d'une version (brouillon). Les données partent en JSON, validées côté serveur puis en base. */
export function SpecEditor({ productId, productCode, versionId, versionNo, initial, note }: {
  productId: string; productCode: string; versionId: string; versionNo: number; initial: ProductSpec; note: string | null
}) {
  const [state, formAction] = useActionState(saveSpecAction, null)
  const [spec, setSpec] = useState<ProductSpec>(initial)
  const [tab, setTab] = useState<Tab>('tech')
  const [sizeInput, setSizeInput] = useState('')
  const set = <K extends keyof ProductSpec>(k: K, v: ProductSpec[K]) => setSpec((s) => ({ ...s, [k]: v }))
  const sizeLabels = spec.sizes.map((s) => s.label)

  const addSizes = (labels: string[]) => {
    const have = new Set(spec.sizes.map((s) => s.label.toLowerCase()))
    const add = labels.map((l) => l.trim()).filter((l) => l && !have.has(l.toLowerCase())).map((label) => ({ label }))
    if (add.length) set('sizes', [...spec.sizes, ...add])
  }
  const removeSize = (label: string) => setSpec((s) => ({
    ...s, sizes: s.sizes.filter((x) => x.label !== label),
    measurements: s.measurements.map((m) => ({ ...m, values: Object.fromEntries(Object.entries(m.values).filter(([k]) => k !== label)) })),
    variants: s.variants.filter((v) => v.size !== label),
  }))
  const removeColor = (name: string) => setSpec((s) => ({ ...s, colors: s.colors.filter((c) => c.name !== name), variants: s.variants.filter((v) => v.color !== name) }))
  const renameColor = (i: number, name: string) => setSpec((s) => {
    const old = s.colors[i].name
    return { ...s, colors: s.colors.map((c, j) => (j === i ? { ...c, name } : c)), variants: s.variants.map((v) => (v.color === old ? { ...v, color: name } : v)) }
  })
  const syncVariants = () => set('variants', buildVariants(productCode, spec.colors.filter((c) => c.name.trim()), spec.sizes, spec.variants))

  const invalidColors = spec.colors.some((c) => !c.name.trim())

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="product_id" value={productId} />
      <input type="hidden" name="version_id" value={versionId} />
      <input type="hidden" name="spec" value={JSON.stringify(spec)} />
      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}

      <nav aria-label="Rubriques de la fiche" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => {
          const Icon = t.icon
          const n = t.id === 'colors' ? spec.colors.length : t.id === 'sizes' ? spec.sizes.length : t.id === 'variants' ? spec.variants.length : t.id === 'measures' ? spec.measurements.length : null
          return (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
              <Icon className="h-4 w-4" aria-hidden />{t.label}{n !== null && <span className="rounded-full bg-canvas px-1.5 text-xs">{n}</span>}
            </button>
          )
        })}
      </nav>

      <section className="rounded-md border border-line bg-white p-5 shadow-card">
        {tab === 'tech' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><Label htmlFor="t-comp">Composition</Label><Input id="t-comp" maxLength={300} value={spec.tech.composition ?? ''} onChange={(e) => set('tech', { ...spec.tech, composition: e.target.value })} placeholder="100 % polyester — doublure 100 % coton" /></div>
            <div><Label htmlFor="t-fab">Tissu principal</Label><Input id="t-fab" maxLength={160} value={spec.tech.fabric ?? ''} onChange={(e) => set('tech', { ...spec.tech, fabric: e.target.value })} placeholder="Oxford enduit PU" /></div>
            <div><Label htmlFor="t-wt">Grammage (g/m²)</Label><Input id="t-wt" inputMode="decimal" value={spec.tech.weight_gsm ?? ''} onChange={(e) => set('tech', { ...spec.tech, weight_gsm: num(e.target.value) })} placeholder="240" /></div>
            <div><Label htmlFor="t-season">Saison</Label>
              <Select id="t-season" value={spec.tech.season ?? ''} onChange={(e) => set('tech', { ...spec.tech, season: e.target.value || undefined })}><option value="">—</option>{SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}</Select></div>
            <div><Label htmlFor="t-gender">Genre</Label>
              <Select id="t-gender" value={spec.tech.gender ?? ''} onChange={(e) => set('tech', { ...spec.tech, gender: e.target.value || undefined })}><option value="">—</option>{GENDERS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</Select></div>
            <div className="sm:col-span-2"><Label htmlFor="t-cons">Construction</Label><Input id="t-cons" maxLength={300} value={spec.tech.construction ?? ''} onChange={(e) => set('tech', { ...spec.tech, construction: e.target.value })} placeholder="Coutures surjetées et rabattues, bandes rétroréfléchissantes cousues" /></div>
            <div className="sm:col-span-2"><Label htmlFor="t-fin">Finitions</Label><Input id="t-fin" maxLength={300} value={spec.tech.finishing ?? ''} onChange={(e) => set('tech', { ...spec.tech, finishing: e.target.value })} placeholder="Déperlant, antistatique" /></div>
            <div className="sm:col-span-2"><Label htmlFor="t-notes">Notes techniques</Label><Textarea id="t-notes" rows={4} maxLength={2000} value={spec.tech.notes ?? ''} onChange={(e) => set('tech', { ...spec.tech, notes: e.target.value })} /></div>
          </div>
        )}

        {tab === 'colors' && (
          <div className="space-y-3">
            {spec.colors.length === 0 && <p className="text-sm text-ink-soft">Aucune couleur. Ajoutez au moins un coloris pour pouvoir valider la version.</p>}
            {spec.colors.map((c, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-[3rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                <div><Label htmlFor={`c-hex-${i}`}>Teinte</Label><input id={`c-hex-${i}`} type="color" value={c.hex || '#cccccc'} onChange={(e) => set('colors', spec.colors.map((x, j) => (j === i ? { ...x, hex: e.target.value } : x)))} className="h-9 w-full cursor-pointer rounded-md border border-line bg-white p-0.5" /></div>
                <div><Label htmlFor={`c-name-${i}`}>Nom *</Label><Input id={`c-name-${i}`} maxLength={60} value={c.name} onChange={(e) => renameColor(i, e.target.value)} placeholder="Jaune HV" /></div>
                <div><Label htmlFor={`c-pan-${i}`}>Pantone</Label><Input id={`c-pan-${i}`} maxLength={30} value={c.pantone ?? ''} onChange={(e) => set('colors', spec.colors.map((x, j) => (j === i ? { ...x, pantone: e.target.value } : x)))} placeholder="PMS 389 C" /></div>
                <div><Label htmlFor={`c-cc-${i}`}>Code client</Label><Input id={`c-cc-${i}`} maxLength={30} value={c.client_code ?? ''} onChange={(e) => set('colors', spec.colors.map((x, j) => (j === i ? { ...x, client_code: e.target.value } : x)))} /></div>
                <Button type="button" variant="ghost" size="sm" aria-label={`Supprimer la couleur ${c.name || i + 1}`} onClick={() => removeColor(c.name)}><Trash2 className="h-4 w-4 text-danger-text" /></Button>
              </div>
            ))}
            <Button type="button" variant="secondary" size="sm" onClick={() => set('colors', [...spec.colors, { name: '', hex: '#cccccc' }])}><Plus className="h-4 w-4" /> Ajouter une couleur</Button>
            {invalidColors && <p className="text-xs text-warn-text">Une couleur n’a pas de nom : elle sera refusée à l’enregistrement.</p>}
          </div>
        )}

        {tab === 'sizes' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {SIZE_PRESETS.map((p) => <Button key={p.label} type="button" variant="secondary" size="sm" onClick={() => addSizes([...p.sizes])}>{p.label}</Button>)}
            </div>
            <div className="flex gap-2">
              <Input aria-label="Nouvelle taille" maxLength={12} value={sizeInput} onChange={(e) => setSizeInput(e.target.value)} placeholder="Ex. 5XL" className="max-w-40"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSizes([sizeInput]); setSizeInput('') } }} />
              <Button type="button" variant="secondary" onClick={() => { addSizes([sizeInput]); setSizeInput('') }}><Plus className="h-4 w-4" /> Ajouter</Button>
            </div>
            {spec.sizes.length === 0 ? <p className="text-sm text-ink-soft">Aucune taille.</p> : (
              <ul className="flex flex-wrap gap-2">
                {spec.sizes.map((s) => (
                  <li key={s.label} className="flex items-center gap-1 rounded-md border border-line bg-canvas py-1 pl-3 pr-1 text-sm font-semibold">{s.label}
                    <button type="button" onClick={() => removeSize(s.label)} aria-label={`Retirer la taille ${s.label}`} className="rounded p-1 text-ink-faint hover:bg-white hover:text-danger-text"><X className="h-3.5 w-3.5" /></button></li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'variants' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-ink-soft">{spec.variants.length} variante(s) — une par couleur × taille. Le SKU est généré (PRD-xxxx-COU-TAILLE) ; code-barres et statut restent éditables.</p>
              <Button type="button" size="sm" onClick={syncVariants} disabled={spec.colors.length === 0 || spec.sizes.length === 0}><Wand2 className="h-4 w-4" /> Générer / synchroniser la matrice</Button>
            </div>
            {spec.variants.length > 0 && (
              <div className="max-h-[28rem] overflow-auto rounded-md border border-line">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="sticky top-0 bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-2 font-semibold">Couleur</th><th className="px-2 py-2 font-semibold">Taille</th><th className="px-2 py-2 font-semibold">SKU</th><th className="px-2 py-2 font-semibold">Code-barres</th><th className="px-2 py-2 text-center font-semibold">Actif</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {spec.variants.map((v, i) => (
                      <tr key={i}>
                        <td className="px-3 py-1.5">{v.color}</td><td className="px-2 py-1.5">{v.size}</td>
                        <td className="px-2 py-1.5"><Input aria-label={`SKU ${v.color} ${v.size}`} className="h-8 font-mono text-xs" maxLength={40} value={v.sku} onChange={(e) => set('variants', spec.variants.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))} /></td>
                        <td className="px-2 py-1.5"><Input aria-label={`Code-barres ${v.color} ${v.size}`} className="h-8 text-xs" maxLength={20} value={v.barcode ?? ''} onChange={(e) => set('variants', spec.variants.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)))} /></td>
                        <td className="px-2 py-1.5 text-center"><input type="checkbox" aria-label={`Variante active ${v.color} ${v.size}`} checked={v.active !== false} onChange={(e) => set('variants', spec.variants.map((x, j) => (j === i ? { ...x, active: e.target.checked } : x)))} className="h-4 w-4 accent-brand-500" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'measures' && (
          <div className="space-y-3">
            {spec.sizes.length === 0 && <Alert tone="info">Définissez d’abord les tailles : le tableau de mesures a une colonne par taille.</Alert>}
            <div className="flex flex-wrap gap-2">
              {MEASURE_PRESETS.filter((m) => !spec.measurements.some((x) => x.point === m)).map((m) => (
                <Button key={m} type="button" variant="secondary" size="sm" onClick={() => set('measurements', [...spec.measurements, { point: m, values: {} }])}><Plus className="h-3.5 w-3.5" /> {m}</Button>
              ))}
              <Button type="button" variant="secondary" size="sm" onClick={() => set('measurements', [...spec.measurements, { point: '', values: {} }])}><Plus className="h-3.5 w-3.5" /> Autre point</Button>
            </div>
            {spec.measurements.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-2 font-semibold">Point de mesure</th><th className="px-2 py-2 font-semibold">Tol. ± cm</th>{sizeLabels.map((s) => <th key={s} className="px-2 py-2 text-right font-semibold">{s}</th>)}<th className="w-10" /></tr></thead>
                  <tbody className="divide-y divide-line">
                    {spec.measurements.map((m, i) => (
                      <tr key={i}>
                        <td className="px-3 py-1.5"><Input aria-label="Point de mesure" className="h-8" maxLength={80} value={m.point} onChange={(e) => set('measurements', spec.measurements.map((x, j) => (j === i ? { ...x, point: e.target.value } : x)))} /></td>
                        <td className="px-2 py-1.5"><Input aria-label={`Tolérance ${m.point}`} className="h-8 w-16" inputMode="decimal" value={m.tolerance ?? ''} onChange={(e) => set('measurements', spec.measurements.map((x, j) => (j === i ? { ...x, tolerance: num(e.target.value) } : x)))} /></td>
                        {sizeLabels.map((s) => (
                          <td key={s} className="px-2 py-1.5"><Input aria-label={`${m.point} taille ${s}`} className="h-8 w-16 text-right" inputMode="decimal" value={m.values[s] ?? ''}
                            onChange={(e) => set('measurements', spec.measurements.map((x, j) => {
                              if (j !== i) return x
                              const values = { ...x.values }
                              const n = num(e.target.value)
                              if (n === undefined) delete values[s]; else values[s] = n
                              return { ...x, values }
                            }))} /></td>
                        ))}
                        <td className="px-1 py-1.5"><Button type="button" variant="ghost" size="sm" aria-label={`Supprimer ${m.point || 'la ligne'}`} onClick={() => set('measurements', spec.measurements.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-danger-text" /></Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'care' && (
          <div className="grid gap-4 sm:grid-cols-2">
            {([['wash', 'Lavage', WASH], ['bleach', 'Javel', BLEACH], ['tumble', 'Sèche-linge', TUMBLE], ['iron', 'Repassage', IRON], ['dry_clean', 'Nettoyage à sec', DRY_CLEAN]] as const).map(([k, lbl, list]) => (
              <div key={k}><Label htmlFor={`care-${k}`}>{lbl}</Label>
                <Select id={`care-${k}`} value={spec.care[k] ?? ''} onChange={(e) => set('care', { ...spec.care, [k]: e.target.value || undefined })}><option value="">—</option>{list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></div>
            ))}
            <div className="sm:col-span-2"><Label htmlFor="care-ins">Consignes complémentaires</Label><Textarea id="care-ins" rows={3} maxLength={1000} value={spec.care.instructions ?? ''} onChange={(e) => set('care', { ...spec.care, instructions: e.target.value })} /></div>
          </div>
        )}

        {tab === 'packaging' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><Label htmlFor="pk-unit">Unité de vente</Label><Input id="pk-unit" maxLength={160} value={spec.packaging.unit ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, unit: e.target.value })} placeholder="1 pièce sous sachet individuel" /></div>
            <div><Label htmlFor="pk-upc">Pièces par carton</Label><Input id="pk-upc" inputMode="numeric" value={spec.packaging.units_per_carton ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, units_per_carton: num(e.target.value) })} /></div>
            <div><Label htmlFor="pk-w">Poids du carton (kg)</Label><Input id="pk-w" inputMode="decimal" value={spec.packaging.carton_weight_kg ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, carton_weight_kg: num(e.target.value) })} /></div>
            {(['l', 'w', 'h'] as const).map((d) => (
              <div key={d}><Label htmlFor={`pk-${d}`}>{d === 'l' ? 'Longueur' : d === 'w' ? 'Largeur' : 'Hauteur'} du carton (cm)</Label>
                <Input id={`pk-${d}`} inputMode="decimal" value={spec.packaging.carton_dims_cm?.[d] ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, carton_dims_cm: { ...spec.packaging.carton_dims_cm, [d]: num(e.target.value) } })} /></div>
            ))}
            <div className="sm:col-span-2"><Label htmlFor="pk-lab">Étiquetage</Label><Input id="pk-lab" maxLength={300} value={spec.packaging.labeling ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, labeling: e.target.value })} /></div>
            <div className="sm:col-span-2"><Label htmlFor="pk-ins">Consignes d’emballage</Label><Textarea id="pk-ins" rows={3} maxLength={1000} value={spec.packaging.instructions ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, instructions: e.target.value })} /></div>
          </div>
        )}
      </section>

      <section className="rounded-md border border-line bg-white p-4 shadow-card">
        <Label htmlFor="change_note">Ce qui change dans la version {versionNo} (facultatif)</Label>
        <Input id="change_note" name="change_note" maxLength={500} defaultValue={note ?? ''} placeholder="Tissu 260 g, coloris marine ajouté…" />
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <Link href={`/products/${productId}?tab=versions`} className={buttonVariants({ variant: 'secondary' })}>Retour aux versions</Link>
        <SubmitButton pendingText="Enregistrement…">Enregistrer la fiche</SubmitButton>
      </div>
    </form>
  )
}

'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Palette, Plus, Ruler, ShieldCheck, Shirt, Package, Trash2, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { SubmitButton } from '@/components/auth/submit-button'
import {
  BLEACH, DRY_CLEAN, IRON, NORM_SUGGESTIONS, SIZE_PRESETS, TUMBLE, WASH,
  type ArticleSpec, type ColorSpec, type NormSpec,
} from '@/lib/articles/options'
import { cn } from '@/lib/utils'
import { saveSpecAction } from '../actions'

const TABS = [
  { id: 'colors', label: 'Couleurs', icon: Palette },
  { id: 'sizes', label: 'Tailles', icon: Ruler },
  { id: 'norms', label: 'Normes', icon: ShieldCheck },
  { id: 'packaging', label: 'Packaging', icon: Package },
  { id: 'care', label: 'Lavage', icon: Shirt },
] as const
type Tab = (typeof TABS)[number]['id']

const num = (v: string) => {
  if (v.trim() === '') return undefined
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : undefined
}

/** Éditeur de la fiche d'une version (brouillon). Les données partent en JSON, validées côté serveur puis en base. */
export function SpecEditor({
  articleId,
  versionId,
  versionNo,
  initial,
  note,
}: {
  articleId: string
  versionId: string
  versionNo: number
  initial: ArticleSpec
  note: string | null
}) {
  const [state, formAction] = useActionState(saveSpecAction, null)
  const [spec, setSpec] = useState<ArticleSpec>({ ...initial, packaging: initial.packaging ?? {}, care: initial.care ?? {} })
  const [tab, setTab] = useState<Tab>('colors')
  const [sizeInput, setSizeInput] = useState('')

  const set = <K extends keyof ArticleSpec>(k: K, v: ArticleSpec[K]) => setSpec((s) => ({ ...s, [k]: v }))
  const updColor = (i: number, p: Partial<ColorSpec>) => set('colors', spec.colors.map((c, j) => (j === i ? { ...c, ...p } : c)))
  const updNorm = (i: number, p: Partial<NormSpec>) => set('norms', spec.norms.map((n, j) => (j === i ? { ...n, ...p } : n)))

  const addSizes = (raw: string) => {
    const labels = raw.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
    const known = new Set(spec.sizes.map((s) => s.label.toLowerCase()))
    const next = [...spec.sizes]
    for (const l of labels) if (!known.has(l.toLowerCase())) { next.push({ label: l.slice(0, 12) }); known.add(l.toLowerCase()) }
    set('sizes', next)
    setSizeInput('')
  }
  const counts: Record<Tab, number> = { colors: spec.colors.length, sizes: spec.sizes.length, norms: spec.norms.length, packaging: Object.keys(spec.packaging).length ? 1 : 0, care: Object.keys(spec.care).length ? 1 : 0 }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="article_id" value={articleId} />
      <input type="hidden" name="version_id" value={versionId} />
      <input type="hidden" name="spec" value={JSON.stringify(spec)} />
      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}

      <div role="tablist" aria-label="Sections de la fiche" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={cn('-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
            <t.icon className="h-4 w-4" aria-hidden /> {t.label}
            {counts[t.id] > 0 && <span className="rounded-full bg-canvas px-1.5 text-xs">{counts[t.id]}</span>}
          </button>
        ))}
      </div>

      <div className="rounded-md border border-line bg-white p-5 shadow-card">
        {tab === 'colors' && (
          <div className="space-y-3">
            {spec.colors.map((c, i) => (
              <div key={i} className="grid gap-2 rounded-md bg-canvas p-3 sm:grid-cols-[3rem_1fr_1fr_1fr_1fr_auto] sm:items-end">
                <div>
                  <Label htmlFor={`hex-${i}`}>Teinte</Label>
                  <input id={`hex-${i}`} type="color" value={/^#[0-9a-fA-F]{6}$/.test(c.hex ?? '') ? c.hex : '#cccccc'} onChange={(e) => updColor(i, { hex: e.target.value })}
                    className="h-9 w-full cursor-pointer rounded-sm border border-line-strong bg-white p-0.5" aria-label={`Teinte de ${c.name || 'la couleur'}`} />
                </div>
                <div><Label htmlFor={`cn-${i}`}>Nom *</Label><Input id={`cn-${i}`} value={c.name} onChange={(e) => updColor(i, { name: e.target.value })} placeholder="Bleu marine" maxLength={60} /></div>
                <div><Label htmlFor={`cc-${i}`}>Code interne</Label><Input id={`cc-${i}`} value={c.code ?? ''} onChange={(e) => updColor(i, { code: e.target.value })} placeholder="NAVY" maxLength={30} /></div>
                <div><Label htmlFor={`cp-${i}`}>Pantone</Label><Input id={`cp-${i}`} value={c.pantone ?? ''} onChange={(e) => updColor(i, { pantone: e.target.value })} placeholder="19-3832 TCX" maxLength={30} /></div>
                <div><Label htmlFor={`ck-${i}`}>Code client</Label><Input id={`ck-${i}`} value={c.client_code ?? ''} onChange={(e) => updColor(i, { client_code: e.target.value })} maxLength={30} /></div>
                <Button type="button" variant="ghost" size="sm" onClick={() => set('colors', spec.colors.filter((_, j) => j !== i))} aria-label={`Retirer ${c.name || 'la couleur'}`}><Trash2 className="h-4 w-4 text-danger-text" /></Button>
              </div>
            ))}
            {spec.colors.length === 0 && <p className="text-sm text-ink-soft">Aucune couleur. Ajoutez les coloris commandés par le client.</p>}
            <Button type="button" variant="secondary" size="sm" onClick={() => set('colors', [...spec.colors, { name: '', hex: '#cccccc' }])}><Plus className="h-4 w-4" /> Ajouter une couleur</Button>
          </div>
        )}

        {tab === 'sizes' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {spec.sizes.map((s, i) => (
                <span key={s.label} className="inline-flex items-center gap-1 rounded-sm border border-line-strong bg-white px-2.5 py-1 text-sm font-medium">
                  {s.label}
                  <button type="button" onClick={() => set('sizes', spec.sizes.filter((_, j) => j !== i))} className="rounded-sm p-0.5 text-ink-faint hover:text-danger-text" aria-label={`Retirer la taille ${s.label}`}><X className="h-3.5 w-3.5" /></button>
                </span>
              ))}
              {spec.sizes.length === 0 && <p className="text-sm text-ink-soft">Aucune taille.</p>}
            </div>
            <div className="flex gap-2">
              <Input value={sizeInput} onChange={(e) => setSizeInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (sizeInput.trim()) addSizes(sizeInput) } }}
                placeholder="Ajouter : S, M, L ou 44 46 48 (Entrée)" aria-label="Ajouter des tailles" className="max-w-sm" />
              <Button type="button" variant="secondary" onClick={() => sizeInput.trim() && addSizes(sizeInput)}><Plus className="h-4 w-4" /> Ajouter</Button>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-ink-soft">Grilles prédéfinies</p>
              <div className="flex flex-wrap gap-2">
                {SIZE_PRESETS.map((p) => <Button key={p.label} type="button" variant="ghost" size="sm" onClick={() => addSizes(p.sizes.join(','))}>{p.label}</Button>)}
                {spec.sizes.length > 0 && <Button type="button" variant="ghost" size="sm" className="text-danger-text" onClick={() => set('sizes', [])}>Tout effacer</Button>}
              </div>
            </div>
          </div>
        )}

        {tab === 'norms' && (
          <div className="space-y-3">
            <datalist id="norm-list">{NORM_SUGGESTIONS.map((n) => <option key={n.code} value={n.code}>{n.label}</option>)}</datalist>
            {spec.norms.map((n, i) => (
              <div key={i} className="grid gap-2 rounded-md bg-canvas p-3 sm:grid-cols-[1.4fr_1.6fr_5rem_1fr_9rem_auto] sm:items-end">
                <div><Label htmlFor={`nc-${i}`}>Norme *</Label><Input id={`nc-${i}`} list="norm-list" value={n.code} onChange={(e) => updNorm(i, { code: e.target.value })} placeholder="EN ISO 20471" maxLength={60} /></div>
                <div><Label htmlFor={`nl-${i}`}>Libellé</Label><Input id={`nl-${i}`} value={n.label ?? ''} onChange={(e) => updNorm(i, { label: e.target.value })} maxLength={120} /></div>
                <div><Label htmlFor={`nk-${i}`}>Classe</Label><Input id={`nk-${i}`} value={n.class ?? ''} onChange={(e) => updNorm(i, { class: e.target.value })} placeholder="2" maxLength={20} /></div>
                <div><Label htmlFor={`nr-${i}`}>N° certificat</Label><Input id={`nr-${i}`} value={n.certificate_ref ?? ''} onChange={(e) => updNorm(i, { certificate_ref: e.target.value })} maxLength={60} /></div>
                <div><Label htmlFor={`nv-${i}`}>Valide jusqu’au</Label><Input id={`nv-${i}`} type="date" value={n.valid_until ?? ''} onChange={(e) => updNorm(i, { valid_until: e.target.value })} /></div>
                <Button type="button" variant="ghost" size="sm" onClick={() => set('norms', spec.norms.filter((_, j) => j !== i))} aria-label={`Retirer ${n.code || 'la norme'}`}><Trash2 className="h-4 w-4 text-danger-text" /></Button>
              </div>
            ))}
            {spec.norms.length === 0 && <p className="text-sm text-ink-soft">Aucune norme. Ajoutez celles exigées par le client (haute visibilité, flamme, pluie…).</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => set('norms', [...spec.norms, { code: '' }])}><Plus className="h-4 w-4" /> Ajouter une norme</Button>
              {NORM_SUGGESTIONS.filter((s) => !spec.norms.some((n) => n.code.toLowerCase() === s.code.toLowerCase())).slice(0, 6).map((s) => (
                <Button key={s.code} type="button" variant="ghost" size="sm" onClick={() => set('norms', [...spec.norms, { code: s.code, label: s.label }])} title={s.label}>+ {s.code}</Button>
              ))}
            </div>
          </div>
        )}

        {tab === 'packaging' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div><Label htmlFor="pk-unit">Conditionnement unitaire</Label><Input id="pk-unit" value={spec.packaging.unit ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, unit: e.target.value })} placeholder="1 pièce / sachet polybag" maxLength={160} /></div>
            <div><Label htmlFor="pk-upc">Pièces par carton</Label><Input id="pk-upc" inputMode="numeric" value={spec.packaging.units_per_carton ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, units_per_carton: num(e.target.value) })} /></div>
            <div><Label htmlFor="pk-w">Poids du carton (kg)</Label><Input id="pk-w" inputMode="decimal" value={spec.packaging.carton_weight_kg ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, carton_weight_kg: num(e.target.value) })} /></div>
            <div>
              <Label>Dimensions du carton (cm) L × l × h</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['l', 'w', 'h'] as const).map((k) => (
                  <Input key={k} inputMode="decimal" aria-label={{ l: 'Longueur', w: 'Largeur', h: 'Hauteur' }[k]} placeholder={{ l: 'L', w: 'l', h: 'h' }[k]} value={spec.packaging.carton_dims_cm?.[k] ?? ''}
                    onChange={(e) => set('packaging', { ...spec.packaging, carton_dims_cm: { ...spec.packaging.carton_dims_cm, [k]: num(e.target.value) } })} />
                ))}
              </div>
            </div>
            <div className="sm:col-span-2"><Label htmlFor="pk-lab">Étiquetage / marquage</Label><Input id="pk-lab" value={spec.packaging.labeling ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, labeling: e.target.value })} placeholder="Étiquette code-barres EAN, face avant du carton" maxLength={300} /></div>
            <div className="sm:col-span-2"><Label htmlFor="pk-ins">Instructions d’emballage</Label><Textarea id="pk-ins" rows={3} value={spec.packaging.instructions ?? ''} onChange={(e) => set('packaging', { ...spec.packaging, instructions: e.target.value })} maxLength={1000} /></div>
          </div>
        )}

        {tab === 'care' && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {([['wash', 'Lavage', WASH], ['bleach', 'Blanchiment', BLEACH], ['tumble', 'Séchage', TUMBLE], ['iron', 'Repassage', IRON], ['dry_clean', 'Nettoyage à sec', DRY_CLEAN]] as const).map(([k, title, list]) => (
              <div key={k}>
                <Label htmlFor={`care-${k}`}>{title}</Label>
                <Select id={`care-${k}`} value={spec.care[k] ?? ''} onChange={(e) => set('care', { ...spec.care, [k]: e.target.value || undefined })}>
                  <option value="">— Non précisé —</option>
                  {list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </div>
            ))}
            <div><Label htmlFor="care-comp">Composition</Label><Input id="care-comp" value={spec.care.composition ?? ''} onChange={(e) => set('care', { ...spec.care, composition: e.target.value })} placeholder="65 % polyester, 35 % coton" maxLength={200} /></div>
            <div className="sm:col-span-2 lg:col-span-3"><Label htmlFor="care-ins">Instructions complémentaires</Label><Textarea id="care-ins" rows={3} value={spec.care.instructions ?? ''} onChange={(e) => set('care', { ...spec.care, instructions: e.target.value })} maxLength={1000} placeholder="Laver à l’envers, fermer les fermetures éclair…" /></div>
          </div>
        )}
      </div>

      <div className="rounded-md border border-line bg-white p-5 shadow-card">
        <Label htmlFor="change_note">Note de version (ce qui change)</Label>
        <Input id="change_note" name="change_note" defaultValue={note ?? ''} maxLength={500} placeholder={`Version ${versionNo} : ajout d’un coloris, nouvelle norme…`} />
      </div>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
        <Link href={`/articles/${articleId}?tab=versions`} className={buttonVariants({ variant: 'secondary' })}>Retour aux versions</Link>
        <SubmitButton pendingText="Enregistrement…">Enregistrer la fiche</SubmitButton>
      </div>
    </form>
  )
}

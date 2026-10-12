'use client'

import { useActionState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import type { FormState } from '@/features/auth/types'
import { SIZE_GROUPS, type CatalogColor, type CatalogSize } from '@/lib/variants/options'
import { cn } from '@/lib/utils'
import { deleteCatalogAction, saveColorAction, saveSizeAction, seedDefaultsAction, toggleCatalogAction } from '../actions'

function SizeFields({ st, s }: { st: FormState; s?: CatalogSize }) {
  const e = st?.fieldErrors ?? {}
  const v = (k: string, fb: string | number | undefined = '') => st?.values?.[k] ?? String(fb ?? '')
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField id={`sz-code-${s?.id ?? 'new'}`} label="Code *" errors={e.code}><Input id={`sz-code-${s?.id ?? 'new'}`} name="code" maxLength={12} defaultValue={v('code', s?.code)} disabled={Boolean(s)} placeholder="XXL" /></FormField>
      <FormField id={`sz-label-${s?.id ?? 'new'}`} label="Libellé *" errors={e.label}><Input id={`sz-label-${s?.id ?? 'new'}`} name="label" maxLength={30} defaultValue={v('label', s?.label)} placeholder="2XL" /></FormField>
      <FormField id={`sz-group-${s?.id ?? 'new'}`} label="Groupe" errors={e.size_group}><Select id={`sz-group-${s?.id ?? 'new'}`} name="size_group" defaultValue={v('size_group', s?.size_group ?? 'letters')}>{SIZE_GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</Select></FormField>
      <FormField id={`sz-order-${s?.id ?? 'new'}`} label="Ordre d’affichage" errors={e.sort_order}><Input id={`sz-order-${s?.id ?? 'new'}`} name="sort_order" inputMode="numeric" defaultValue={v('sort_order', s?.sort_order ?? 100)} /></FormField>
    </div>
  )
}
function ColorFields({ st, c }: { st: FormState; c?: CatalogColor }) {
  const e = st?.fieldErrors ?? {}
  const v = (k: string, fb: string | undefined | null = '') => st?.values?.[k] ?? fb ?? ''
  const id = c?.id ?? 'new'
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField id={`cl-code-${id}`} label="Code *" errors={e.code}><Input id={`cl-code-${id}`} name="code" maxLength={10} defaultValue={v('code', c?.code)} disabled={Boolean(c)} placeholder="JAU" /></FormField>
      <FormField id={`cl-name-${id}`} label="Nom *" errors={e.name}><Input id={`cl-name-${id}`} name="name" maxLength={60} defaultValue={v('name', c?.name)} placeholder="Jaune HV" /></FormField>
      <FormField id={`cl-hex-${id}`} label="Teinte (#RRGGBB)" errors={e.hex}><Input id={`cl-hex-${id}`} name="hex" maxLength={7} defaultValue={v('hex', c?.hex)} placeholder="#e6e600" /></FormField>
      <FormField id={`cl-pan-${id}`} label="Pantone" errors={e.pantone}><Input id={`cl-pan-${id}`} name="pantone" maxLength={30} defaultValue={v('pantone', c?.pantone)} placeholder="PMS 389 C" /></FormField>
    </div>
  )
}

function RowActions({ table, id, active, used, canWrite, edit }: { table: 'sizes' | 'colors'; id: string; active: boolean; used: number; canWrite: boolean; edit: React.ReactNode }) {
  const [t, tAction] = useActionState(toggleCatalogAction, null)
  const [d, dAction] = useActionState(deleteCatalogAction, null)
  if (!canWrite) return null
  return (
    <div className="flex items-center justify-end gap-1">
      {edit}
      <form action={tAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="table" value={table} /><input type="hidden" name="active" value={String(!active)} />
        <Button type="submit" variant="ghost" size="sm">{active ? 'Désactiver' : 'Activer'}</Button></form>
      {used === 0 && <form action={dAction} onSubmit={(e) => { if (!window.confirm('Supprimer cet élément ?')) e.preventDefault() }}><input type="hidden" name="id" value={id} /><input type="hidden" name="table" value={table} />
        <Button type="submit" variant="ghost" size="sm" aria-label="Supprimer"><Trash2 className="h-4 w-4 text-danger-text" /></Button></form>}
      {((t && !t.ok) || (d && !d.ok)) && <span role="alert" className="text-xs text-danger-text">{(t && !t.ok ? t.message : d?.message)}</span>}
    </div>
  )
}

/** Catalogues de tailles et de couleurs de la société. Un élément utilisé se désactive ; un élément inutilisé peut être supprimé. */
export function CatalogManager({ sizes, colors, usage, canWrite }: { sizes: CatalogSize[]; colors: CatalogColor[]; usage: { sizes: Record<string, number>; colors: Record<string, number> }; canWrite: boolean }) {
  const [seed, seedAction] = useActionState(seedDefaultsAction, null)
  return (
    <div className="space-y-6">
      {canWrite && (
        <form action={seedAction} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white p-3 shadow-card">
          <p className="text-sm text-ink-soft">Tailles standard (XS → 4XL, 36 → 60) et couleurs courantes du vêtement professionnel. Les éléments existants sont conservés.</p>
          <SubmitButton variant="secondary" size="sm" pendingText="Chargement…">Charger le catalogue standard</SubmitButton>
          {seed && <Alert tone={seed.ok ? 'success' : 'error'}>{seed.message}</Alert>}
        </form>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-labelledby="sizes-h" className="space-y-2">
          <div className="flex items-center justify-between"><h2 id="sizes-h" className="text-base font-semibold">Tailles <span className="text-sm font-normal text-ink-soft">({sizes.length})</span></h2>
            {canWrite && <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouvelle taille</>} triggerVariant="primary" title="Nouvelle taille" action={saveSizeAction} submit="Ajouter">{(st) => <SizeFields st={st} />}</ActionDialog>}</div>
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card"><table className="w-full min-w-[26rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-2 font-semibold">Code</th><th className="px-2 py-2 font-semibold">Libellé</th><th className="px-2 py-2 font-semibold">Groupe</th><th className="px-2 py-2 text-right font-semibold">Variantes</th><th className="px-2 py-2" /></tr></thead>
            <tbody className="divide-y divide-line">{sizes.map((s) => (
              <tr key={s.id} className={cn(!s.active && 'text-ink-faint')}>
                <td className="px-3 py-1.5 font-mono font-semibold">{s.code}</td><td className="px-2 py-1.5">{s.label}</td><td className="px-2 py-1.5">{SIZE_GROUPS.find((g) => g.value === s.size_group)?.label.split(' ')[0]}{!s.active && <Badge tone="neutral" className="ml-2">Inactive</Badge>}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{usage.sizes[s.id] ?? 0}</td>
                <td className="px-2 py-1.5"><RowActions table="sizes" id={s.id} active={s.active} used={usage.sizes[s.id] ?? 0} canWrite={canWrite}
                  edit={<ActionDialog trigger={<Pencil className="h-4 w-4" />} triggerVariant="ghost" triggerLabel={`Modifier la taille ${s.code}`} title={`Modifier la taille ${s.code}`} action={saveSizeAction} hidden={{ id: s.id }} submit="Enregistrer">{(st) => <SizeFields st={st} s={s} />}</ActionDialog>} /></td>
              </tr>))}</tbody></table></div>
        </section>
        <section aria-labelledby="colors-h" className="space-y-2">
          <div className="flex items-center justify-between"><h2 id="colors-h" className="text-base font-semibold">Couleurs <span className="text-sm font-normal text-ink-soft">({colors.length})</span></h2>
            {canWrite && <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouvelle couleur</>} triggerVariant="primary" title="Nouvelle couleur" action={saveColorAction} submit="Ajouter">{(st) => <ColorFields st={st} />}</ActionDialog>}</div>
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card"><table className="w-full min-w-[26rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-2 font-semibold">Couleur</th><th className="px-2 py-2 font-semibold">Code</th><th className="px-2 py-2 font-semibold">Pantone</th><th className="px-2 py-2 text-right font-semibold">Variantes</th><th className="px-2 py-2" /></tr></thead>
            <tbody className="divide-y divide-line">{colors.map((c) => (
              <tr key={c.id} className={cn(!c.active && 'text-ink-faint')}>
                <td className="px-3 py-1.5"><span className="mr-2 inline-block h-4 w-4 rounded-full border border-line-strong align-middle" style={{ background: c.hex ?? '#e1dfdd' }} aria-hidden />{c.name}{!c.active && <Badge tone="neutral" className="ml-2">Inactive</Badge>}</td>
                <td className="px-2 py-1.5 font-mono">{c.code}</td><td className="px-2 py-1.5 text-ink-soft">{c.pantone ?? '—'}</td><td className="px-2 py-1.5 text-right tabular-nums">{usage.colors[c.id] ?? 0}</td>
                <td className="px-2 py-1.5"><RowActions table="colors" id={c.id} active={c.active} used={usage.colors[c.id] ?? 0} canWrite={canWrite}
                  edit={<ActionDialog trigger={<Pencil className="h-4 w-4" />} triggerVariant="ghost" triggerLabel={`Modifier la couleur ${c.name}`} title={`Modifier la couleur ${c.name}`} action={saveColorAction} hidden={{ id: c.id }} submit="Enregistrer">{(st) => <ColorFields st={st} c={c} />}</ActionDialog>} /></td>
              </tr>))}</tbody></table></div>
        </section>
      </div>
    </div>
  )
}

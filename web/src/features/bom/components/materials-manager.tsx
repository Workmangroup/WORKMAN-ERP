'use client'

import { useActionState, useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { MATERIAL_CATEGORIES, UNITS, formatUnitPrice, label, unitLabel } from '@/lib/bom/options'
import { archiveMaterialAction, deleteMaterialAction, saveMaterialAction } from '../actions'
import type { MaterialRow } from '../types'

type Dlg = null | 'new' | { edit: MaterialRow } | { remove: MaterialRow }

/** Catalogue des composants : création / modification (avec prix si costs.read), archivage, suppression. */
export function MaterialsManager({ rows, suppliers, canWrite, costs }: { rows: MaterialRow[]; suppliers: { id: string; name: string }[]; canWrite: boolean; costs: boolean }) {
  const [dlg, setDlg] = useState<Dlg>(null)
  const close = () => setDlg(null)
  const title = dlg === 'new' ? 'Nouveau composant' : dlg && 'edit' in dlg ? `Modifier ${dlg.edit.code}` : dlg && 'remove' in dlg ? `Supprimer ${dlg.remove.code} ?` : ''

  return (
    <>
      {canWrite && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setDlg('new')}><Plus className="h-4 w-4" /> Nouveau composant</Button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun composant ne correspond.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
              <tr>
                <th className="px-4 py-2 font-semibold">Code</th><th className="px-2 py-2 font-semibold">Désignation</th><th className="px-2 py-2 font-semibold">Catégorie</th>
                <th className="px-2 py-2 font-semibold">Unité</th>{costs && <th className="px-2 py-2 text-right font-semibold">Prix unitaire</th>}
                <th className="px-2 py-2 font-semibold">Fournisseur</th><th className="px-2 py-2 text-right font-semibold">Utilisé</th>{canWrite && <th className="w-28 px-4 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((m) => (
                <tr key={m.id} className={m.archived_at ? 'bg-canvas/60 text-ink-soft' : ''}>
                  <td className="px-4 py-2 font-mono text-xs font-semibold text-brand-700">{m.code}</td>
                  <td className="px-2 py-2"><span className="font-medium">{m.name}</span>{m.color && <span className="ml-2 text-xs text-ink-soft">{m.color}</span>}{m.archived_at && <Badge className="ml-2">archivé</Badge>}</td>
                  <td className="px-2 py-2">{label(MATERIAL_CATEGORIES, m.category)}</td>
                  <td className="px-2 py-2">{unitLabel(m.unit)}</td>
                  {costs && <td className="px-2 py-2 text-right tabular-nums">{m.unit_cost === null ? <span className="text-warn-text">À renseigner</span> : formatUnitPrice(m.unit_cost)}</td>}
                  <td className="px-2 py-2">{m.supplier_name ?? '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{m.usage_count}</td>
                  {canWrite && (
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        {!m.archived_at && <Button variant="ghost" size="sm" aria-label={`Modifier ${m.code}`} title="Modifier" onClick={() => setDlg({ edit: m })}><Pencil className="h-4 w-4" /></Button>}
                        <form action={archiveMaterialAction}>
                          <input type="hidden" name="id" value={m.id} /><input type="hidden" name="archive" value={m.archived_at ? '0' : '1'} />
                          <Button type="submit" variant="ghost" size="sm" aria-label={m.archived_at ? `Restaurer ${m.code}` : `Archiver ${m.code}`} title={m.archived_at ? 'Restaurer' : 'Archiver'}>
                            {m.archived_at ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                          </Button>
                        </form>
                        {m.usage_count === 0 && <Button variant="ghost" size="sm" aria-label={`Supprimer ${m.code}`} title="Supprimer" onClick={() => setDlg({ remove: m })}><Trash2 className="h-4 w-4 text-danger-text" /></Button>}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={dlg !== null} onClose={close} title={title}>
        {dlg === 'new' && <MaterialForm suppliers={suppliers} costs={costs} onDone={close} />}
        {dlg && typeof dlg === 'object' && 'edit' in dlg && <MaterialForm material={dlg.edit} suppliers={suppliers} costs={costs} onDone={close} />}
        {dlg && typeof dlg === 'object' && 'remove' in dlg && <DeleteMaterial material={dlg.remove} onDone={close} />}
      </Dialog>
    </>
  )
}

function MaterialForm({ material, suppliers, costs, onDone }: { material?: MaterialRow; suppliers: { id: string; name: string }[]; costs: boolean; onDone: () => void }) {
  const [state, action] = useActionState(saveMaterialAction, null)
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])
  const errs = state?.fieldErrors ?? {}
  const v = (k: string, fb: string | null | undefined = '') => state?.values?.[k] ?? fb ?? ''
  const locked = Boolean(material && material.usage_count > 0)
  return (
    <form action={action} className="space-y-3" noValidate>
      {material && <input type="hidden" name="id" value={material.id} />}
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <FormField id="m-name" label="Désignation *" errors={errs.name}>
        <Input id="m-name" name="name" maxLength={160} defaultValue={v('name', material?.name)} placeholder="Tissu jaune HV 120 g" autoFocus aria-invalid={Boolean(errs.name)} />
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="m-category" label="Catégorie *" errors={errs.category}>
          <Select id="m-category" name="category" defaultValue={v('category', material?.category ?? 'fabric')}>{MATERIAL_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>
        </FormField>
        <FormField id="m-unit" label="Unité *" errors={errs.unit} hint={locked ? 'Verrouillée : composant déjà utilisé.' : 'Unité de la quantité et du prix.'}>
          {locked && <input type="hidden" name="unit" value={material!.unit} />}
          <Select id="m-unit" name={locked ? undefined : 'unit'} defaultValue={v('unit', material?.unit ?? 'm')} disabled={locked}>{UNITS.map((u) => <option key={u.value} value={u.value}>{u.long} ({u.label})</option>)}</Select>
        </FormField>
        <FormField id="m-color" label="Couleur" errors={errs.color}>
          <Input id="m-color" name="color" maxLength={60} defaultValue={v('color', material?.color)} placeholder="Jaune HV" />
        </FormField>
        {costs ? (
          <FormField id="m-cost" label={`Prix unitaire (€ / ${unitLabel(material?.unit ?? 'm')})`} errors={errs.unit_cost} hint="Confidentiel : visible avec « Voir les coûts ».">
            <Input id="m-cost" name="unit_cost" inputMode="decimal" defaultValue={v('unit_cost', material?.unit_cost === null || material?.unit_cost === undefined ? '' : String(material.unit_cost).replace('.', ','))} placeholder="8,50" aria-invalid={Boolean(errs.unit_cost)} />
          </FormField>
        ) : <p className="self-end text-xs text-ink-soft">Le prix est renseigné par l’achat.</p>}
      </div>
      <FormField id="m-supplier" label="Fournisseur habituel" errors={errs.supplier_id}>
        <Select id="m-supplier" name="supplier_id" defaultValue={v('supplier_id', material?.supplier_id)}><option value="">— Aucun —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
      </FormField>
      <FormField id="m-desc" label="Description" errors={errs.description}>
        <Textarea id="m-desc" name="description" rows={2} maxLength={500} defaultValue={v('description', material?.description)} />
      </FormField>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Annuler</Button><SubmitButton pendingText="Enregistrement…">{material ? 'Enregistrer' : 'Créer'}</SubmitButton></div>
    </form>
  )
}

function DeleteMaterial({ material, onDone }: { material: MaterialRow; onDone: () => void }) {
  const [state, action] = useActionState(deleteMaterialAction, null)
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={material.id} />
      {state && !state.ok && <Alert tone="error">{state.message}</Alert>}
      <p className="text-sm">« {material.name} » sera supprimé définitivement (son prix aussi). Possible uniquement s’il n’est utilisé dans aucune nomenclature ; sinon, archivez-le.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onDone}>Annuler</Button><SubmitButton variant="danger" pendingText="Suppression…">Supprimer</SubmitButton></div>
    </form>
  )
}

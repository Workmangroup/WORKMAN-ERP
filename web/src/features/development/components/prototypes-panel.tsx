'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { formatMoney } from '@/lib/bom/options'
import { COST_KINDS, PROTO_NEXT, PROTO_STATUS, daysUntil, label } from '@/lib/development/options'
import { fmtDay } from '@/features/orders/status'
import { addCostAction, addPrototypeAction, deleteCostAction, prototypeStatusAction } from '../actions'
import type { ProtoCost, Prototype } from '../types'
import { ActionDialog } from '@/components/common/action-dialog'

const today = () => new Date().toISOString().slice(0, 10)

/** Prototypes numérotés (v1, v2…) avec statut, retour d'essayage et coûts (visibles seulement avec le droit « coûts »). */
export function PrototypesPanel({ projectId, prototypes, costs, canWrite, canCosts, canSeeCosts, owners }: {
  projectId: string; prototypes: Prototype[]; costs: ProtoCost[]; canWrite: boolean; canCosts: boolean; canSeeCosts: boolean; owners: { id: string; name: string }[]
}) {
  const ownerName = new Map(owners.map((o) => [o.id, o.name]))
  const total = costs.reduce((a, c) => a + c.amount, 0)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{prototypes.length} prototype(s){canSeeCosts && <> · coût total des prototypes : <strong className="tabular-nums text-ink">{formatMoney(total)}</strong></>}</p>
        {canWrite && (
          <ActionDialog trigger={<><Plus className="h-4 w-4" /> Nouveau prototype</>} triggerVariant="primary" title="Nouveau prototype" action={addPrototypeAction} hidden={{ project_id: projectId }} submit="Ajouter">
            {(st) => (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2"><FormField id="pp-name" label="Intitulé" errors={st?.fieldErrors?.name}><Input id="pp-name" name="name" maxLength={160} defaultValue={st?.values?.name} placeholder="Prototype coupe ajustée" /></FormField></div>
                <FormField id="pp-owner" label="Responsable" errors={st?.fieldErrors?.owner_id}><Select id="pp-owner" name="owner_id" defaultValue={st?.values?.owner_id ?? ''}><option value="">—</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></FormField>
                <FormField id="pp-due" label="Échéance" errors={st?.fieldErrors?.due_date}><Input id="pp-due" name="due_date" type="date" defaultValue={st?.values?.due_date} /></FormField>
                <div className="sm:col-span-2"><FormField id="pp-desc" label="Description / modifications" errors={st?.fieldErrors?.description}><Textarea id="pp-desc" name="description" rows={3} maxLength={2000} defaultValue={st?.values?.description} /></FormField></div>
              </div>
            )}
          </ActionDialog>
        )}
      </div>

      {prototypes.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucun prototype. Créez le premier pour avancer vers l’échantillon.</p> : (
        <ul className="space-y-3">
          {prototypes.map((p) => {
            const mine = costs.filter((c) => c.prototype_id === p.id)
            const late = (p.status === 'planned' || p.status === 'in_progress') && (daysUntil(p.due_date) ?? 0) < 0 && p.due_date
            return (
              <li key={p.id} className="rounded-md border border-line bg-white p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">Prototype v{p.version_no}{p.name ? ` — ${p.name}` : ''}<Badge tone={PROTO_STATUS[p.status].tone}>{PROTO_STATUS[p.status].label}</Badge>{late && <Badge tone="danger">En retard</Badge>}</p>
                    <p className="mt-0.5 text-xs text-ink-soft">{[p.owner_id && `Resp. ${ownerName.get(p.owner_id) ?? '—'}`, p.due_date && `échéance ${fmtDay(p.due_date)}`, p.started_on && `démarré ${fmtDay(p.started_on)}`, p.completed_on && `terminé ${fmtDay(p.completed_on)}`].filter(Boolean).join(' · ') || 'Aucune date'}</p>
                    {p.description && <p className="mt-1 whitespace-pre-wrap text-sm">{p.description}</p>}
                    {p.feedback && <p className="mt-1 rounded-sm bg-canvas p-2 text-sm"><span className="font-medium">Retour : </span>{p.feedback}</p>}
                  </div>
                  {canWrite && (PROTO_NEXT[p.status] ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {PROTO_NEXT[p.status].map((n) => (
                        <ActionDialog key={n.to} trigger={n.label} triggerVariant={n.to === 'rejected' ? 'ghost' : 'secondary'} triggerClassName={n.to === 'rejected' ? 'text-danger-text' : undefined}
                          title={`${n.label} — prototype v${p.version_no}`} action={prototypeStatusAction} hidden={{ id: p.id, project_id: projectId, status: n.to }} submit={n.label} submitVariant={n.to === 'rejected' ? 'danger' : 'primary'}>
                          {() => <FormField id={`fb-${p.id}-${n.to}`} label="Retour d’essayage / commentaire (facultatif)"><Textarea id={`fb-${p.id}-${n.to}`} name="feedback" rows={3} maxLength={1000} /></FormField>}
                        </ActionDialog>
                      ))}
                    </div>
                  )}
                </div>

                {canSeeCosts && (
                  <div className="mt-3 border-t border-line pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold">Coûts du prototype <span className="ml-1 tabular-nums text-ink-soft">{formatMoney(mine.reduce((a, c) => a + c.amount, 0))}</span></p>
                      {canCosts && (
                        <ActionDialog trigger={<><Plus className="h-3.5 w-3.5" /> Ajouter un coût</>} title={`Coût — prototype v${p.version_no}`} action={addCostAction} hidden={{ project_id: projectId, prototype_id: p.id }} submit="Ajouter">
                          {(st) => (
                            <div className="grid gap-3 sm:grid-cols-2">
                              <FormField id={`ck-${p.id}`} label="Type *" errors={st?.fieldErrors?.kind}><Select id={`ck-${p.id}`} name="kind" defaultValue={st?.values?.kind ?? 'material'}>{COST_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></FormField>
                              <FormField id={`cd-${p.id}`} label="Date" errors={st?.fieldErrors?.incurred_on}><Input id={`cd-${p.id}`} name="incurred_on" type="date" defaultValue={st?.values?.incurred_on ?? today()} /></FormField>
                              <div className="sm:col-span-2"><FormField id={`cx-${p.id}`} label="Description *" errors={st?.fieldErrors?.description}><Input id={`cx-${p.id}`} name="description" maxLength={200} defaultValue={st?.values?.description} placeholder="Tissu jaune HV, couture, transport…" /></FormField></div>
                              <FormField id={`cq-${p.id}`} label="Quantité *" errors={st?.fieldErrors?.quantity}><Input id={`cq-${p.id}`} name="quantity" inputMode="decimal" defaultValue={st?.values?.quantity ?? '1'} /></FormField>
                              <FormField id={`cu-${p.id}`} label="Coût unitaire *" errors={st?.fieldErrors?.unit_cost}><Input id={`cu-${p.id}`} name="unit_cost" inputMode="decimal" defaultValue={st?.values?.unit_cost} placeholder="0,00" /></FormField>
                            </div>
                          )}
                        </ActionDialog>
                      )}
                    </div>
                    {mine.length > 0 && (
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full min-w-[30rem] text-sm">
                          <tbody className="divide-y divide-line">
                            {mine.map((c) => (
                              <tr key={c.id}>
                                <td className="py-1.5 pr-2 text-ink-soft">{fmtDay(c.incurred_on)}</td><td className="py-1.5 pr-2"><Badge>{label(COST_KINDS, c.kind)}</Badge></td><td className="py-1.5 pr-2">{c.description}</td>
                                <td className="py-1.5 pr-2 text-right tabular-nums text-ink-soft">{c.quantity} × {formatMoney(c.unit_cost)}</td><td className="py-1.5 pr-2 text-right font-medium tabular-nums">{formatMoney(c.amount)}</td>
                                {canCosts && <td className="w-8 py-1.5 text-right"><form action={deleteCostAction} onSubmit={(e) => { if (!window.confirm('Supprimer ce coût ?')) e.preventDefault() }}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="project_id" value={projectId} /><Button type="submit" variant="ghost" size="sm" aria-label="Supprimer le coût"><Trash2 className="h-3.5 w-3.5 text-danger-text" /></Button></form></td>}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {!canSeeCosts && <p className="text-xs text-ink-faint">Les coûts de prototype sont réservés aux utilisateurs habilités.</p>}
    </div>
  )
}

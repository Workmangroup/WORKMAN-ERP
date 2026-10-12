import { Minus, Pencil, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { SECTION_LABELS, VERSION_STATUS, describePath, showValue, type ChangeRow } from '@/lib/products/options'
import { formatDateTime } from '@/lib/utils'
import type { Comparison } from '../services/products.service'

const TONE = {
  added: { label: 'Ajouté', cls: 'bg-success/10 text-success-text', Icon: Plus },
  removed: { label: 'Retiré', cls: 'bg-danger/10 text-danger-text', Icon: Minus },
  changed: { label: 'Modifié', cls: 'bg-warn/10 text-warn-text', Icon: Pencil },
} as const

/** Écarts entre deux versions, regroupés par rubrique ; les éléments (couleur, variante…) ajoutés ou retirés sont listés une seule fois. */
export function CompareView({ cmp }: { cmp: Comparison }) {
  const bySection = new Map<string, ChangeRow[]>()
  for (const c of cmp.changes) bySection.set(c.section, [...(bySection.get(c.section) ?? []), c])
  const side = (v: Comparison['a'], who: string) => (
    <div className="rounded-md border border-line bg-white p-3 text-sm shadow-card">
      <p className="flex flex-wrap items-center gap-2 font-semibold">{who} · Version {v.version_no}<Badge tone={VERSION_STATUS[v.status as keyof typeof VERSION_STATUS].tone}>{VERSION_STATUS[v.status as keyof typeof VERSION_STATUS].label}</Badge></p>
      {v.change_note && <p className="mt-1 text-ink-soft">« {v.change_note} »</p>}
      <p className="mt-1 text-xs text-ink-soft">{v.validated_at ? `Validée le ${formatDateTime(v.validated_at)}` : v.status === 'draft' ? 'Brouillon : l’entête, les certifications et les documents sont lus en direct.' : ''}</p>
    </div>
  )
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">{side(cmp.a, 'Avant')}{side(cmp.b, 'Après')}</div>
      <div className="flex flex-wrap gap-2 text-sm" aria-label="Résumé des écarts">
        <Badge tone="success">{cmp.summary.added} ajout(s)</Badge><Badge tone="danger">{cmp.summary.removed} retrait(s)</Badge><Badge tone="warning">{cmp.summary.changed} modification(s)</Badge>
      </div>
      {cmp.changes.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune différence entre ces deux versions.</p> : (
        [...bySection.entries()].map(([section, rows]) => (
          <Card key={section}>
            <CardHeader><CardTitle>{SECTION_LABELS[section] ?? section} <span className="ml-1 text-xs font-normal text-ink-soft">{rows.length} écart(s)</span></CardTitle></CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-line">
                {rows.map((r) => {
                  const d = describePath(r.path)
                  const t = TONE[r.change]
                  const whole = r.path.endsWith(']')
                  return (
                    <li key={r.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                      <span className={`inline-flex w-24 shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${t.cls}`}><t.Icon className="h-3 w-3" aria-hidden />{t.label}</span>
                      <span className="min-w-0 flex-1">
                        {d.item && <span className="font-semibold">{d.item}</span>}{d.item && d.field && <span className="text-ink-soft"> › </span>}{d.field && <span className={d.item ? '' : 'font-semibold'}>{d.field}</span>}
                        {whole && <span className="text-ink-soft"> ({r.change === 'added' ? 'nouvel élément' : 'élément retiré'})</span>}
                      </span>
                      {!whole && (
                        <span className="flex items-center gap-2 tabular-nums">
                          <span className={r.change === 'added' ? 'text-ink-faint' : 'text-danger-text line-through decoration-danger/50'}>{showValue(r.path, r.a)}</span>
                          <span aria-hidden>→</span>
                          <span className={r.change === 'removed' ? 'text-ink-faint' : 'font-semibold text-success-text'}>{showValue(r.path, r.b)}</span>
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}

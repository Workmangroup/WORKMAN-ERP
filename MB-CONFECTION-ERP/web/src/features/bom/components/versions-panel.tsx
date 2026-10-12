'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, FilePlus2, Pencil, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SubmitButton } from '@/components/auth/submit-button'
import { BOM_VERSION_STATUS, formatMoney } from '@/lib/bom/options'
import { formatDateTime } from '@/lib/utils'
import { discardDraftAction, newVersionAction, validateVersionAction } from '../actions'
import type { BomVersion } from '../types'

export interface VersionRow extends BomVersion {
  author?: string
  validator?: string
  summary: string
  /** Coût de revient figé (costs.read). */
  frozen_total: number | null
}

export function VersionsPanel({ bomId, versions, canWrite, canValidate, locked, activeVersionId, costs }: {
  bomId: string; versions: VersionRow[]; canWrite: boolean; canValidate: boolean; locked: boolean; activeVersionId: string | null; costs: boolean
}) {
  const [dialog, setDialog] = useState<null | 'new' | { validate: VersionRow }>(null)
  const close = () => setDialog(null)
  const [nState, nAction] = useActionState(newVersionAction, null)
  const [vState, vAction] = useActionState(validateVersionAction, null)
  const draft = versions.find((v) => v.status === 'draft')
  const activeNo = versions.find((v) => v.id === activeVersionId)?.version_no

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">
          La production et les nomenclatures parentes utilisent la <strong className="text-ink">version validée</strong>
          {activeNo ? ` (v${activeNo})` : ' — aucune pour l’instant'}. Une version validée est figée avec son coût de revient.
        </p>
        {canWrite && !locked && !draft && <Button size="sm" onClick={() => setDialog('new')}><FilePlus2 className="h-4 w-4" /> Nouvelle version</Button>}
      </div>

      <ul className="space-y-3">
        {versions.map((v) => (
          <li key={v.id} className="rounded-md border border-line bg-white p-4 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  Version {v.version_no}
                  <Badge tone={BOM_VERSION_STATUS[v.status].tone}>{BOM_VERSION_STATUS[v.status].label}</Badge>
                  {v.id === activeVersionId && <Badge tone="brand">Utilisée en production</Badge>}
                  {costs && v.frozen_total !== null && <Badge tone="neutral">Coût figé {formatMoney(v.frozen_total)}</Badge>}
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">Créée le {formatDateTime(v.created_at)}{v.author ? ` par ${v.author}` : ''}</p>
                {v.change_note && <p className="mt-1 text-sm">« {v.change_note} »</p>}
                <p className="mt-1 text-xs text-ink-soft">{v.summary}</p>
                {v.validated_at && <p className="mt-1 text-xs text-success-text">Validée le {formatDateTime(v.validated_at)}{v.validator ? ` par ${v.validator}` : ''}{v.validation_comment ? ` — « ${v.validation_comment} »` : ''}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={v.status === 'draft' && canWrite && !locked ? `/bom/${bomId}?tab=composition&v=${v.id}` : `/bom/${bomId}?v=${v.id}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  {v.status === 'draft' && canWrite && !locked ? <><Pencil className="h-4 w-4" /> Modifier</> : 'Consulter'}
                </Link>
                {v.status === 'draft' && canValidate && !locked && <Button size="sm" onClick={() => setDialog({ validate: v })}><CheckCircle2 className="h-4 w-4" /> Valider</Button>}
                {v.status === 'draft' && v.version_no > 1 && canWrite && !locked && (
                  <form action={discardDraftAction} onSubmit={(e) => { if (!window.confirm(`Abandonner le brouillon de la version ${v.version_no} ?`)) e.preventDefault() }}>
                    <input type="hidden" name="version_id" value={v.id} /><input type="hidden" name="bom_id" value={bomId} />
                    <Button type="submit" variant="ghost" size="sm" aria-label="Abandonner le brouillon"><Trash2 className="h-4 w-4 text-danger-text" /></Button>
                  </form>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={dialog === 'new'} onClose={close} title="Nouvelle version de la nomenclature">
        <form action={nAction} className="space-y-4">
          <input type="hidden" name="bom_id" value={bomId} />
          {nState && !nState.ok && <Alert tone="error">{nState.message}</Alert>}
          <p className="text-sm text-ink-soft">Le brouillon démarre avec les composants, opérations et paramètres de coût de la dernière version. La version validée reste utilisée jusqu’à la validation du brouillon.</p>
          <div>
            <label htmlFor="note" className="mb-1 block text-sm font-semibold">Ce qui change (facultatif)</label>
            <Input id="note" name="note" maxLength={500} placeholder="Tissu plus large, zip YKK…" autoFocus />
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Création…">Créer le brouillon</SubmitButton></div>
        </form>
      </Dialog>

      <Dialog open={typeof dialog === 'object' && dialog !== null} onClose={close} title={typeof dialog === 'object' && dialog ? `Valider la version ${dialog.validate.version_no}` : ''}>
        {typeof dialog === 'object' && dialog && (
          <form action={vAction} className="space-y-4">
            <input type="hidden" name="bom_id" value={bomId} /><input type="hidden" name="version_id" value={dialog.validate.id} />
            {vState && !vState.ok && <Alert tone="error">{vState.message}</Alert>}
            <p className="text-sm text-ink-soft">La validation <strong className="text-ink">fige</strong> les composants, opérations et paramètres de coût, calcule et enregistre le coût de revient, et met la version précédente en « obsolète ». Tous les composants doivent avoir un prix.</p>
            <div>
              <label htmlFor="comment" className="mb-1 block text-sm font-semibold">Commentaire de validation (facultatif)</label>
              <Textarea id="comment" name="comment" rows={3} maxLength={500} />
            </div>
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Validation…">Valider la version</SubmitButton></div>
          </form>
        )}
      </Dialog>
    </div>
  )
}

'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, FilePlus2, GitCompare, Pencil, Trash2, XCircle } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { SubmitButton } from '@/components/auth/submit-button'
import { VERSION_STATUS } from '@/lib/products/options'
import { formatDateTime } from '@/lib/utils'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { discardDraftAction, newVersionAction, validateVersionAction, versionStepAction } from '../actions'
import type { ProductVersion } from '../types'

export interface VersionRow extends ProductVersion { author?: string; validator?: string; summary: string }

/** Liste des versions de la fiche, création d'une nouvelle version, validation du brouillon, accès à la comparaison. */
export function VersionsPanel({ productId, versions, canWrite, canValidate, locked, activeVersionId }: {
  productId: string; versions: VersionRow[]; canWrite: boolean; canValidate: boolean; locked: boolean; activeVersionId: string | null
}) {
  const [dialog, setDialog] = useState<null | 'new' | { validate: VersionRow }>(null)
  const [rejectTarget, setRejectTarget] = useState<VersionRow | null>(null)
  const [rState, rAction] = useActionState(versionStepAction, null)
  const close = () => setDialog(null)
  const [nState, nAction] = useActionState(newVersionAction, null)
  const [vState, vAction] = useActionState(validateVersionAction, null)
  const draft = versions.find((v) => v.status === 'draft')
  const sorted = [...versions].sort((a, b) => a.version_no - b.version_no)
  const latest = versions[0]
  const prev = versions[1]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">
          La référence est la <strong className="text-ink">version validée</strong>{activeVersionId ? ` (v${versions.find((v) => v.id === activeVersionId)?.version_no})` : ' — aucune pour l’instant'}. Une version validée est figée avec un instantané des certifications et documents.
        </p>
        {canWrite && !locked && !draft && <Button size="sm" onClick={() => setDialog('new')}><FilePlus2 className="h-4 w-4" /> Nouvelle version</Button>}
      </div>

      {versions.length >= 2 && (
        <form action={`/products/${productId}/compare`} className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div><label htmlFor="cmp-a" className="mb-1 block text-sm font-semibold">Comparer</label>
            <Select id="cmp-a" name="a" defaultValue={prev?.id} className="w-44">{sorted.map((v) => <option key={v.id} value={v.id}>Version {v.version_no} ({VERSION_STATUS[v.status].label.toLowerCase()})</option>)}</Select></div>
          <div><label htmlFor="cmp-b" className="mb-1 block text-sm font-semibold">avec</label>
            <Select id="cmp-b" name="b" defaultValue={latest?.id} className="w-44">{sorted.map((v) => <option key={v.id} value={v.id}>Version {v.version_no} ({VERSION_STATUS[v.status].label.toLowerCase()})</option>)}</Select></div>
          <Button type="submit" variant="secondary"><GitCompare className="h-4 w-4" /> Comparer</Button>
        </form>
      )}

      <ul className="space-y-3">
        {versions.map((v) => (
          <li key={v.id} className="rounded-md border border-line bg-white p-4 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  Version {v.version_no}<Badge tone={VERSION_STATUS[v.status].tone}>{VERSION_STATUS[v.status].label}</Badge>
                  {v.id === activeVersionId && <Badge tone="brand">Version de référence</Badge>}
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">Créée le {formatDateTime(v.created_at)}{v.author ? ` par ${v.author}` : ''}</p>
                {v.change_note && <p className="mt-1 text-sm">« {v.change_note} »</p>}
                <p className="mt-1 text-xs text-ink-soft">{v.summary}</p>
                {v.validated_at && <p className="mt-1 text-xs text-success-text">Validée le {formatDateTime(v.validated_at)}{v.validator ? ` par ${v.validator}` : ''}{v.validation_comment ? ` — « ${v.validation_comment} »` : ''}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {v.version_no > 1 && <Link href={`/products/${productId}/compare?a=${versions.find((x) => x.version_no === v.version_no - 1)?.id}&b=${v.id}`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}><GitCompare className="h-4 w-4" /> Écarts avec v{v.version_no - 1}</Link>}
                <Link href={v.status === 'draft' && canWrite && !locked ? `/products/${productId}/spec?v=${v.id}` : `/products/${productId}?tab=tech&v=${v.id}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  {v.status === 'draft' && canWrite && !locked ? <><Pencil className="h-4 w-4" /> Modifier la fiche</> : 'Consulter'}
                </Link>
                {v.status === 'draft' && canWrite && !locked && <RpcButton action={versionStepAction} fields={{ product_id: productId, version_id: v.id, step: 'prototype' }} variant="secondary" size="sm" pendingText="…">Prototype</RpcButton>}
                {(v.status === 'draft' || v.status === 'prototype') && canWrite && !locked && <RpcButton action={versionStepAction} fields={{ product_id: productId, version_id: v.id, step: 'review' }} size="sm" pendingText="Envoi…">Demander la revue</RpcButton>}
                {v.status === 'review' && canValidate && !locked && <Button size="sm" onClick={() => setDialog({ validate: v })}><CheckCircle2 className="h-4 w-4" /> Approuver</Button>}
                {v.status === 'review' && canValidate && !locked && <Button size="sm" variant="secondary" onClick={() => setRejectTarget(v)}><XCircle className="h-4 w-4" /> Rejeter</Button>}
                {v.status === 'draft' && v.version_no > 1 && canWrite && !locked && (
                  <form action={discardDraftAction} onSubmit={(e) => { if (!window.confirm(`Abandonner le brouillon de la version ${v.version_no} ?`)) e.preventDefault() }}>
                    <input type="hidden" name="version_id" value={v.id} /><input type="hidden" name="product_id" value={productId} />
                    <Button type="submit" variant="ghost" size="sm" aria-label="Abandonner le brouillon"><Trash2 className="h-4 w-4 text-danger-text" /></Button>
                  </form>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={dialog === 'new'} onClose={close} title="Nouvelle version de la fiche">
        <form action={nAction} className="space-y-4">
          <input type="hidden" name="product_id" value={productId} />
          {nState && !nState.ok && <Alert tone="error">{nState.message}</Alert>}
          <p className="text-sm text-ink-soft">Le brouillon démarre avec le contenu de la dernière version. La version validée reste la référence jusqu’à la validation du brouillon.</p>
          <div><label htmlFor="note" className="mb-1 block text-sm font-semibold">Ce qui change (facultatif)</label><Input id="note" name="note" maxLength={500} placeholder="Tissu 260 g, nouveau coloris…" autoFocus /></div>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Création…">Créer le brouillon</SubmitButton></div>
        </form>
      </Dialog>

      <Dialog open={rejectTarget !== null} onClose={() => setRejectTarget(null)} title={rejectTarget ? `Rejeter la version ${rejectTarget.version_no}` : ''}>
        {rejectTarget && (
          <form action={rAction} className="space-y-4">
            <input type="hidden" name="product_id" value={productId} />
            <input type="hidden" name="version_id" value={rejectTarget.id} />
            <input type="hidden" name="step" value="reject" />
            {rState && !rState.ok && <Alert tone="error">{rState.message}</Alert>}
            <p className="text-sm text-ink-soft">La version retourne en brouillon, modifiable par le rédacteur, avec ce motif.</p>
            <div><label htmlFor="reject-note" className="mb-1 block text-sm font-semibold">Motif du rejet *</label><Textarea id="reject-note" name="note" rows={3} maxLength={500} /></div>
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setRejectTarget(null)}>Annuler</Button><SubmitButton pendingText="Rejet…">Rejeter la version</SubmitButton></div>
          </form>
        )}
      </Dialog>
      <Dialog open={typeof dialog === 'object' && dialog !== null} onClose={close} title={typeof dialog === 'object' && dialog ? `Approuver la version ${dialog.validate.version_no}` : ''}>
        {typeof dialog === 'object' && dialog && (
          <form action={vAction} className="space-y-4">
            <input type="hidden" name="product_id" value={productId} />
            <input type="hidden" name="version_id" value={dialog.validate.id} />
            {vState && !vState.ok && <Alert tone="error">{vState.message}</Alert>}
            <p className="text-sm text-ink-soft">Une fois validée, la version est figée et devient la référence ; un instantané des certifications, documents et de l’entête du produit est conservé avec elle. L’ancienne version validée passe en « obsolète ».</p>
            <div><label htmlFor="comment" className="mb-1 block text-sm font-semibold">Commentaire de validation (facultatif)</label><Textarea id="comment" name="comment" rows={3} maxLength={500} /></div>
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Validation…">Valider la version</SubmitButton></div>
          </form>
        )}
      </Dialog>
    </div>
  )
}

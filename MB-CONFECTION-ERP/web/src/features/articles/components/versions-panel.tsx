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
import { SPEC_SECTIONS, VERSION_STATUS } from '@/lib/articles/options'
import { formatDateTime } from '@/lib/utils'
import { discardDraftAction, newVersionAction, validateVersionAction } from '../actions'
import type { ArticleVersion } from '../types'

export interface VersionRow extends ArticleVersion {
  author?: string
  validator?: string
  summary: string
}

/** Liste des versions de la fiche, création d'une nouvelle version, validation du brouillon. */
export function VersionsPanel({
  articleId,
  versions,
  canWrite,
  canValidate,
  locked,
  activeVersionId,
}: {
  articleId: string
  versions: VersionRow[]
  canWrite: boolean
  canValidate: boolean
  locked: boolean
  activeVersionId: string | null
}) {
  const [dialog, setDialog] = useState<null | 'new' | { validate: VersionRow }>(null)
  const close = () => setDialog(null)
  const [nState, nAction] = useActionState(newVersionAction, null)
  const [vState, vAction] = useActionState(validateVersionAction, null)
  const draft = versions.find((v) => v.status === 'draft')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">
          La production utilise la <strong className="text-ink">version validée</strong>
          {activeVersionId ? ` (v${versions.find((v) => v.id === activeVersionId)?.version_no})` : ' — aucune pour l’instant'}. Une version validée est figée.
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
                  <Badge tone={VERSION_STATUS[v.status].tone}>{VERSION_STATUS[v.status].label}</Badge>
                  {v.id === activeVersionId && <Badge tone="brand">Utilisée en production</Badge>}
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">Créée le {formatDateTime(v.created_at)}{v.author ? ` par ${v.author}` : ''}</p>
                {v.change_note && <p className="mt-1 text-sm">« {v.change_note} »</p>}
                <p className="mt-1 text-xs text-ink-soft">{v.summary}</p>
                {v.validated_at && (
                  <p className="mt-1 text-xs text-success-text">Validée le {formatDateTime(v.validated_at)}{v.validator ? ` par ${v.validator}` : ''}{v.validation_comment ? ` — « ${v.validation_comment} »` : ''}</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={v.status === 'draft' && canWrite && !locked ? `/articles/${articleId}/spec?v=${v.id}` : `/articles/${articleId}?v=${v.id}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  {v.status === 'draft' && canWrite && !locked ? <><Pencil className="h-4 w-4" /> Modifier la fiche</> : 'Consulter'}
                </Link>
                {v.status === 'draft' && canValidate && !locked && <Button size="sm" onClick={() => setDialog({ validate: v })}><CheckCircle2 className="h-4 w-4" /> Valider</Button>}
                {v.status === 'draft' && v.version_no > 1 && canWrite && !locked && (
                  <form action={discardDraftAction} onSubmit={(e) => { if (!window.confirm(`Abandonner le brouillon de la version ${v.version_no} ?`)) e.preventDefault() }}>
                    <input type="hidden" name="version_id" value={v.id} /><input type="hidden" name="article_id" value={articleId} />
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
          <input type="hidden" name="article_id" value={articleId} />
          {nState && !nState.ok && <Alert tone="error">{nState.message}</Alert>}
          <p className="text-sm text-ink-soft">Le brouillon démarre avec le contenu de la dernière version. La version validée reste utilisée en production jusqu’à la validation du brouillon.</p>
          <div>
            <label htmlFor="note" className="mb-1 block text-sm font-semibold">Ce qui change (facultatif)</label>
            <Input id="note" name="note" maxLength={500} placeholder="Ajout du coloris orange, norme EN 343…" autoFocus />
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Création…">Créer le brouillon</SubmitButton></div>
        </form>
      </Dialog>

      <Dialog open={typeof dialog === 'object' && dialog !== null} onClose={close} title={typeof dialog === 'object' && dialog ? `Valider la version ${dialog.validate.version_no}` : ''}>
        {typeof dialog === 'object' && dialog && (
          <form action={vAction} className="space-y-4">
            <input type="hidden" name="article_id" value={articleId} />
            <input type="hidden" name="version_id" value={dialog.validate.id} />
            {vState && !vState.ok && <Alert tone="error">{vState.message}</Alert>}
            <p className="text-sm text-ink-soft">
              Une fois validée, la version est figée ({Object.values(SPEC_SECTIONS).join(', ').toLowerCase()}) et devient celle utilisée en production. L’ancienne version validée passe en « obsolète ».
            </p>
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

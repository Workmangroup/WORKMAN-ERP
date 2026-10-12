'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, Copy, Pencil, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SubmitButton } from '@/components/auth/submit-button'
import { archiveBomAction, deleteBomAction, duplicateBomAction, restoreBomAction } from '../actions'
import type { ArticleOption } from '../services/bom.service'

type Dlg = null | 'duplicate' | 'archive' | 'delete'

/** Actions d'en-tête : modifier, dupliquer, archiver / restaurer, supprimer. */
export function BomActions({
  id, name, kind, archived, canWrite, canDelete, articles, versions, defaultVersion, usedBy,
}: {
  id: string
  name: string
  kind: 'product' | 'subassembly'
  archived: boolean
  canWrite: boolean
  canDelete: boolean
  articles: ArticleOption[]
  versions: { id: string; version_no: number; status: string }[]
  defaultVersion: string | null
  usedBy: { code: string }[]
}) {
  const [dlg, setDlg] = useState<Dlg>(null)
  const close = () => setDlg(null)
  const [dupState, dupAction] = useActionState(duplicateBomAction, null)
  const [arState, arAction] = useActionState(archiveBomAction, null)
  const [delState, delAction] = useActionState(deleteBomAction, null)
  if (!canWrite) return null
  const errs = dupState?.fieldErrors ?? {}

  return (
    <>
      {!archived && <Link href={`/bom/${id}/edit`} className={buttonVariants({ variant: 'command', size: 'sm' })}><Pencil className="h-4 w-4" /> Modifier</Link>}
      <Button variant="command" size="sm" onClick={() => setDlg('duplicate')}><Copy className="h-4 w-4" /> Dupliquer</Button>
      {archived ? (
        <form action={restoreBomAction}><input type="hidden" name="id" value={id} /><SubmitButton variant="command" size="sm" pendingText="Restauration…"><ArchiveRestore className="h-4 w-4" /> Restaurer</SubmitButton></form>
      ) : (
        <Button variant="command" size="sm" onClick={() => setDlg('archive')}><Archive className="h-4 w-4" /> Archiver</Button>
      )}
      {canDelete && !archived && <Button variant="command" size="sm" className="text-danger-text" onClick={() => setDlg('delete')}><Trash2 className="h-4 w-4" /> Supprimer</Button>}

      <Dialog open={dlg === 'duplicate'} onClose={close} title={`Dupliquer « ${name} »`}>
        <form action={dupAction} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          {dupState && !dupState.ok && <Alert tone="error">{dupState.message}</Alert>}
          <p className="text-sm text-ink-soft">Crée une nouvelle nomenclature (version 1 en brouillon) avec les composants, opérations et paramètres de coût de la version choisie.</p>
          <div>
            <label htmlFor="dup-name" className="mb-1 block text-sm font-semibold">Nom de la copie *</label>
            <Input id="dup-name" name="name" defaultValue={`${name} (copie)`} maxLength={160} autoFocus aria-invalid={Boolean(errs.name)} />
          </div>
          <div>
            <label htmlFor="dup-version" className="mb-1 block text-sm font-semibold">Version source</label>
            <Select id="dup-version" name="version_id" defaultValue={defaultVersion ?? ''}>
              {versions.map((v) => <option key={v.id} value={v.id}>Version {v.version_no} ({v.status === 'validated' ? 'validée' : v.status === 'draft' ? 'brouillon' : 'obsolète'})</option>)}
            </Select>
          </div>
          {kind === 'product' && (
            <div>
              <label htmlFor="dup-article" className="mb-1 block text-sm font-semibold">Article de la copie</label>
              <Select id="dup-article" name="article_id" defaultValue="">
                <option value="">— Aucun (modèle) —</option>
                {articles.map((a) => <option key={a.id} value={a.id}>{a.internal_ref} — {a.name} · {a.client_name}</option>)}
              </Select>
              <p className="mt-1 text-xs text-ink-soft">Seuls les articles sans nomenclature active sont proposés.</p>
            </div>
          )}
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Duplication…">Dupliquer</SubmitButton></div>
        </form>
      </Dialog>

      <Dialog open={dlg === 'archive'} onClose={close} title={`Archiver « ${name} » ?`}>
        <form action={arAction} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          {arState && !arState.ok && <Alert tone="error">{arState.message}</Alert>}
          {usedBy.length > 0 && <Alert tone="warning">Utilisée comme sous-ensemble par {usedBy.map((u) => u.code).join(', ')} : l’archivage sera refusé tant qu’elle y figure.</Alert>}
          <p className="text-sm text-ink-soft">Une nomenclature archivée devient lecture seule et n’est plus proposée comme sous-ensemble. Elle reste consultable et restaurable.</p>
          <div>
            <label htmlFor="reason" className="mb-1 block text-sm font-semibold">Motif (facultatif)</label>
            <Input id="reason" name="reason" maxLength={300} autoFocus />
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Archivage…">Archiver</SubmitButton></div>
        </form>
      </Dialog>

      <Dialog open={dlg === 'delete'} onClose={close} title={`Supprimer « ${name} » ?`}>
        <form action={delAction} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          {delState && !delState.ok && <Alert tone="error">{delState.message}</Alert>}
          <Alert tone="warning">Possible uniquement si aucune version n’a jamais été validée et si elle n’est utilisée nulle part. Sinon, archivez-la.</Alert>
          <div>
            <label htmlFor="confirm" className="mb-1 block text-sm font-semibold">Tapez SUPPRIMER pour confirmer</label>
            <Input id="confirm" name="confirm" autoComplete="off" />
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton variant="danger" pendingText="Suppression…">Supprimer</SubmitButton></div>
        </form>
      </Dialog>
    </>
  )
}

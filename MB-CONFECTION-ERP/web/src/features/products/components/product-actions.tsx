'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, Copy, Pencil, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/auth/submit-button'
import { archiveProductAction, deleteProductAction, duplicateProductAction, restoreProductAction } from '../actions'

type Dlg = null | 'duplicate' | 'archive' | 'delete'

export function ProductActions({ id, code, name, status, canWrite, canArchive, canDelete }: {
  id: string; code: string; name: string; status: 'draft' | 'active' | 'archived'; canWrite: boolean; canArchive: boolean; canDelete: boolean
}) {
  const [dlg, setDlg] = useState<Dlg>(null)
  const close = () => setDlg(null)
  const [dup, dupAction] = useActionState(duplicateProductAction, null)
  const [arc, arcAction] = useActionState(archiveProductAction, null)
  const [res, resAction] = useActionState(restoreProductAction, null)
  const [del, delAction] = useActionState(deleteProductAction, null)
  const archived = status === 'archived'
  return (
    <>
      {canWrite && !archived && <Link href={`/products/${id}/edit`} className={buttonVariants({ variant: 'command', size: 'sm' })}><Pencil className="h-4 w-4" /> Modifier</Link>}
      {canWrite && <Button variant="command" size="sm" onClick={() => setDlg('duplicate')}><Copy className="h-4 w-4" /> Dupliquer</Button>}
      {canArchive && !archived && <Button variant="command" size="sm" onClick={() => setDlg('archive')}><Archive className="h-4 w-4" /> Archiver</Button>}
      {canArchive && archived && (
        <form action={resAction}><input type="hidden" name="id" value={id} /><SubmitButton variant="command" size="sm" pendingText="Restauration…"><ArchiveRestore className="h-4 w-4" /> Restaurer</SubmitButton></form>
      )}
      {canDelete && !archived && <Button variant="command" size="sm" className="text-danger-text" onClick={() => setDlg('delete')}><Trash2 className="h-4 w-4" /> Supprimer</Button>}
      {res && !res.ok && <span role="alert" className="text-xs text-danger-text">{res.message}</span>}

      <Dialog open={dlg === 'duplicate'} onClose={close} title={`Dupliquer ${code}`}>
        <form action={dupAction} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          {dup && !dup.ok && <Alert tone="error">{dup.message}</Alert>}
          <p className="text-sm text-ink-soft">Un nouveau produit (nouveau code) est créé avec la fiche technique de la dernière version en brouillon v1 : couleurs, tailles, variantes (SKU re-préfixés), mesures, entretien, packaging. Photos, documents, certifications et article lié ne sont pas copiés.</p>
          <div>
            <label htmlFor="dup-name" className="mb-1 block text-sm font-semibold">Désignation de la copie</label>
            <Input id="dup-name" name="name" maxLength={160} defaultValue={`Copie de ${name}`.slice(0, 160)} autoFocus />
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Duplication…">Dupliquer</SubmitButton></div>
        </form>
      </Dialog>

      <Dialog open={dlg === 'archive'} onClose={close} title={`Archiver ${code} ?`}>
        <form action={arcAction} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          {arc && !arc.ok && <Alert tone="error">{arc.message}</Alert>}
          <Alert tone="warning">Un produit archivé passe en lecture seule (fiche, photos, documents, certifications). Tout l’historique est conservé et le produit peut être restauré.</Alert>
          <div>
            <label htmlFor="reason" className="mb-1 block text-sm font-semibold">Motif (facultatif)</label>
            <Input id="reason" name="reason" maxLength={300} placeholder="Fin de série, remplacé par PRD-0042…" autoFocus />
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={close}>Annuler</Button><SubmitButton pendingText="Archivage…">Archiver</SubmitButton></div>
        </form>
      </Dialog>

      <Dialog open={dlg === 'delete'} onClose={close} title={`Supprimer « ${code} » ?`}>
        <form action={delAction} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          {del && !del.ok && <Alert tone="error">{del.message}</Alert>}
          <Alert tone="warning">Possible uniquement tant qu’aucune version n’a été validée. Fiche, versions, photos, certifications et liens documentaires sont supprimés ; les documents de la GED sont conservés.</Alert>
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

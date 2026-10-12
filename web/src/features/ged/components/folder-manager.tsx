'use client'

import { useActionState, useState } from 'react'
import { FolderPlus, Pencil, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/auth/submit-button'
import { createFolderAction, deleteFolderAction, renameFolderAction } from '../actions'

/** Nouveau dossier (sous le dossier courant) + renommer / supprimer le dossier courant s'il n'est pas système. */
export function FolderManager({
  clientId,
  current,
  canWrite,
}: {
  clientId: string
  current?: { id: string; name: string; system: boolean }
  canWrite: boolean
}) {
  const [dialog, setDialog] = useState<null | 'new' | 'rename' | 'delete'>(null)
  const close = () => setDialog(null)
  const [cState, cAction] = useActionState(async (p: Parameters<typeof createFolderAction>[0], fd: FormData) => {
    const r = await createFolderAction(p, fd)
    if (r?.ok) close()
    return r
  }, null)
  const [rState, rAction] = useActionState(async (p: Parameters<typeof renameFolderAction>[0], fd: FormData) => {
    const r = await renameFolderAction(p, fd)
    if (r?.ok) close()
    return r
  }, null)
  const [dState, dAction] = useActionState(deleteFolderAction, null)

  if (!canWrite) return null
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setDialog('new')}><FolderPlus className="h-4 w-4" /> Nouveau dossier</Button>
      {current && !current.system && (
        <>
          <Button variant="secondary" size="sm" onClick={() => setDialog('rename')}><Pencil className="h-4 w-4" /> Renommer</Button>
          <Button variant="secondary" size="sm" onClick={() => setDialog('delete')} className="text-danger-text"><Trash2 className="h-4 w-4" /> Supprimer</Button>
        </>
      )}

      <Dialog open={dialog === 'new'} onClose={close} title={current ? `Nouveau dossier dans « ${current.name} »` : 'Nouveau dossier'}>
        <form action={cAction} className="space-y-4">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="parent_id" value={current?.id ?? ''} />
          {cState && !cState.ok && <Alert tone="error">{cState.message}</Alert>}
          <div>
            <label htmlFor="folder-name" className="mb-1 block text-sm font-semibold">Nom du dossier</label>
            <Input id="folder-name" name="name" required maxLength={80} autoFocus />
            {cState?.fieldErrors?.name && <p className="mt-1 text-xs text-danger-text">{cState.fieldErrors.name[0]}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
            <SubmitButton pendingText="Création…">Créer</SubmitButton>
          </div>
        </form>
      </Dialog>

      {current && (
        <>
          <Dialog open={dialog === 'rename'} onClose={close} title="Renommer le dossier">
            <form action={rAction} className="space-y-4">
              <input type="hidden" name="client_id" value={clientId} />
              <input type="hidden" name="id" value={current.id} />
              {rState && !rState.ok && <Alert tone="error">{rState.message}</Alert>}
              <Input name="name" defaultValue={current.name} required maxLength={80} autoFocus aria-label="Nouveau nom" />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
                <SubmitButton pendingText="Enregistrement…">Renommer</SubmitButton>
              </div>
            </form>
          </Dialog>

          <Dialog open={dialog === 'delete'} onClose={close} title={`Supprimer « ${current.name} » ?`}>
            <form action={dAction} className="space-y-4">
              <input type="hidden" name="client_id" value={clientId} />
              <input type="hidden" name="id" value={current.id} />
              {dState && !dState.ok && <Alert tone="error">{dState.message}</Alert>}
              <p className="text-sm text-ink-soft">Le dossier doit être vide (sans document, sans corbeille ni sous-dossier).</p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
                <SubmitButton variant="danger" pendingText="Suppression…">Supprimer</SubmitButton>
              </div>
            </form>
          </Dialog>
        </>
      )}
    </>
  )
}

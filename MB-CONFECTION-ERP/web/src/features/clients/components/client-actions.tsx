'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, Pencil, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SubmitButton } from '@/components/auth/submit-button'
import { archiveClientAction, deleteClientAction, restoreClientAction } from '../actions'

/** Barre de commandes de la fiche client : modifier, archiver, restaurer, supprimer. */
export function ClientActions({
  clientId,
  clientName,
  archived,
  canWrite,
  canDelete,
}: {
  clientId: string
  clientName: string
  archived: boolean
  canWrite: boolean
  canDelete: boolean
}) {
  const [dialog, setDialog] = useState<null | 'archive' | 'restore' | 'delete'>(null)
  const close = () => setDialog(null)
  const [aState, aAction] = useActionState(archiveClientAction, null)
  const [rState, rAction] = useActionState(restoreClientAction, null)
  const [dState, dAction] = useActionState(deleteClientAction, null)

  return (
    <>
      {canWrite && !archived && (
        <Link href={`/clients/${clientId}/edit`} className={buttonVariants({ variant: 'command', size: 'sm' })}>
          <Pencil className="h-4 w-4" /> Modifier
        </Link>
      )}
      {canDelete && !archived && (
        <Button variant="command" size="sm" onClick={() => setDialog('archive')}><Archive className="h-4 w-4" /> Archiver</Button>
      )}
      {canDelete && archived && (
        <>
          <Button variant="command" size="sm" onClick={() => setDialog('restore')}><ArchiveRestore className="h-4 w-4" /> Restaurer</Button>
          <Button variant="command" size="sm" onClick={() => setDialog('delete')} className="text-danger-text"><Trash2 className="h-4 w-4" /> Supprimer définitivement</Button>
        </>
      )}

      <Dialog open={dialog === 'archive'} onClose={close} title={`Archiver « ${clientName} » ?`}>
        <form action={aAction} className="space-y-4">
          <input type="hidden" name="id" value={clientId} />
          {aState && !aState.ok && <Alert tone="error">{aState.message}</Alert>}
          <p className="text-sm text-ink-soft">
            Le client disparaît des listes courantes et ne peut plus être modifié. Ses données et son historique sont conservés ; vous pourrez le restaurer.
          </p>
          <div>
            <label htmlFor="reason" className="mb-1 block text-sm font-semibold">Motif (facultatif)</label>
            <Textarea id="reason" name="reason" rows={3} maxLength={300} placeholder="Ex. Fin de collaboration, doublon…" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
            <SubmitButton pendingText="Archivage…">Archiver le client</SubmitButton>
          </div>
        </form>
      </Dialog>

      <Dialog open={dialog === 'restore'} onClose={close} title={`Restaurer « ${clientName} » ?`}>
        <form action={rAction} className="space-y-4">
          <input type="hidden" name="id" value={clientId} />
          {rState && !rState.ok && <Alert tone="error">{rState.message}</Alert>}
          <p className="text-sm text-ink-soft">Le client redevient actif et modifiable.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
            <SubmitButton pendingText="Restauration…">Restaurer le client</SubmitButton>
          </div>
        </form>
      </Dialog>

      <Dialog open={dialog === 'delete'} onClose={close} title="Suppression définitive">
        <form action={dAction} className="space-y-4">
          <input type="hidden" name="id" value={clientId} />
          {dState && !dState.ok && <Alert tone="error">{dState.message}</Alert>}
          <Alert tone="warning">
            Cette action est irréversible : contacts, adresses et documents de « {clientName} » seront supprimés. Une trace reste dans le journal d’audit.
          </Alert>
          <div>
            <label htmlFor="confirm" className="mb-1 block text-sm font-semibold">Tapez SUPPRIMER pour confirmer</label>
            <Input id="confirm" name="confirm" autoComplete="off" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>Annuler</Button>
            <SubmitButton variant="danger" pendingText="Suppression…">Supprimer définitivement</SubmitButton>
          </div>
        </form>
      </Dialog>
    </>
  )
}

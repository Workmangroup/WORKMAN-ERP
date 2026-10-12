'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Pencil, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/auth/submit-button'
import { deleteArticleAction } from '../actions'

export function ArticleActions({ id, reference, canWrite, canDelete }: { id: string; reference: string; canWrite: boolean; canDelete: boolean }) {
  const [open, setOpen] = useState(false)
  const [state, action] = useActionState(deleteArticleAction, null)
  return (
    <>
      {canWrite && <Link href={`/articles/${id}/edit`} className={buttonVariants({ variant: 'command', size: 'sm' })}><Pencil className="h-4 w-4" /> Modifier</Link>}
      {canDelete && <Button variant="command" size="sm" className="text-danger-text" onClick={() => setOpen(true)}><Trash2 className="h-4 w-4" /> Supprimer</Button>}
      <Dialog open={open} onClose={() => setOpen(false)} title={`Supprimer « ${reference} » ?`}>
        <form action={action} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          {state && !state.ok && <Alert tone="error">{state.message}</Alert>}
          <Alert tone="warning">Possible uniquement tant qu’aucune version n’a été validée. Fiche, versions et photos sont supprimées ; les documents GED rattachés sont conservés et détachés.</Alert>
          <div>
            <label htmlFor="confirm" className="mb-1 block text-sm font-semibold">Tapez SUPPRIMER pour confirmer</label>
            <Input id="confirm" name="confirm" autoComplete="off" />
          </div>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Annuler</Button><SubmitButton variant="danger" pendingText="Suppression…">Supprimer</SubmitButton></div>
        </form>
      </Dialog>
    </>
  )
}

'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { Check, ClipboardCheck, History, Send, Trash2, X } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import {
  addCommentAction, emptyTrashAction, purgeDocumentAction, restoreVersionAction, reviewDocumentAction,
  submitDocumentAction, updateDocumentAction,
} from '../actions'

export interface FolderOption { id: string; label: string }

export function MetaForm({
  doc,
  folders,
  articles,
  canWrite,
}: {
  doc: { id: string; title: string; description: string | null; tags: string[]; valid_until: string | null; folder_id: string; article_id?: string | null }
  folders: FolderOption[]
  /** Articles du client (rattachement facultatif). Absent = champ masqué. */
  articles?: { id: string; label: string }[]
  canWrite: boolean
}) {
  const [state, formAction] = useActionState(updateDocumentAction, null)
  const errs = state?.fieldErrors ?? {}
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="id" value={doc.id} />
      {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
      <FormField id="m-title" label="Titre" errors={errs.title}>
        <Input id="m-title" name="title" defaultValue={doc.title} disabled={!canWrite} required maxLength={160} />
      </FormField>
      <FormField id="m-folder" label="Dossier" errors={errs.folder_id}>
        <Select id="m-folder" name="folder_id" defaultValue={doc.folder_id} disabled={!canWrite}>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </Select>
      </FormField>
      {articles && (
        <FormField id="m-article" label="Article concerné" errors={errs.article_id} hint="Rattache le document à un article du client (module Articles).">
          <Select id="m-article" name="article_id" defaultValue={doc.article_id ?? ''} disabled={!canWrite}>
            <option value="">— Aucun —</option>
            {articles.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </Select>
        </FormField>
      )}
      <FormField id="m-desc" label="Description" errors={errs.description}>
        <Textarea id="m-desc" name="description" rows={3} defaultValue={doc.description ?? ''} disabled={!canWrite} maxLength={2000} />
      </FormField>
      <FormField id="m-tags" label="Mots-clés" errors={errs.tags} hint="Séparés par des virgules (10 maximum).">
        <Input id="m-tags" name="tags" defaultValue={doc.tags.join(', ')} disabled={!canWrite} />
      </FormField>
      <FormField id="m-valid" label="Valide jusqu’au" errors={errs.valid_until} hint="Alerte avant expiration (contrats, certificats…).">
        <Input id="m-valid" name="valid_until" type="date" defaultValue={doc.valid_until ?? ''} disabled={!canWrite} />
      </FormField>
      {canWrite && <SubmitButton pendingText="Enregistrement…">Enregistrer</SubmitButton>}
    </form>
  )
}

/** Soumission à validation / validation / rejet. */
export function ReviewPanel({
  docId,
  clientId,
  status,
  canWrite,
  canValidate,
}: {
  docId: string
  clientId: string
  status: 'draft' | 'pending_review' | 'validated' | 'rejected'
  canWrite: boolean
  canValidate: boolean
}) {
  const [sState, sAction] = useActionState(submitDocumentAction, null)
  const [rState, rAction] = useActionState(reviewDocumentAction, null)
  const [rejecting, setRejecting] = useState(false)

  return (
    <div className="space-y-3">
      {sState && !sState.ok && <Alert tone="error">{sState.message}</Alert>}
      {rState && !rState.ok && <Alert tone="error">{rState.message}</Alert>}

      {(status === 'draft' || status === 'rejected') && canWrite && (
        <form action={sAction}>
          <input type="hidden" name="id" value={docId} /><input type="hidden" name="client_id" value={clientId} />
          <SubmitButton pendingText="Envoi…" className="w-full"><Send className="h-4 w-4" /> Soumettre pour validation</SubmitButton>
        </form>
      )}
      {status === 'pending_review' && !canValidate && <p className="text-sm text-ink-soft">En attente de validation par un responsable.</p>}

      {status === 'pending_review' && canValidate && (
        <form action={rAction} className="space-y-3">
          <input type="hidden" name="id" value={docId} /><input type="hidden" name="client_id" value={clientId} />
          {rejecting && (
            <FormField id="r-comment" label="Motif du rejet *" errors={rState?.fieldErrors?.comment}>
              <Textarea id="r-comment" name="comment" rows={3} required minLength={3} maxLength={1000} autoFocus placeholder="Ex. Signature manquante page 3" />
            </FormField>
          )}
          {!rejecting && (
            <Textarea name="comment" rows={2} maxLength={1000} placeholder="Commentaire de validation (facultatif)" aria-label="Commentaire de validation" />
          )}
          <div className="flex flex-wrap gap-2">
            {!rejecting ? (
              <>
                <SubmitButton name="decision" value="approve" pendingText="Validation…"><Check className="h-4 w-4" /> Valider</SubmitButton>
                <Button type="button" variant="secondary" onClick={() => setRejecting(true)}><X className="h-4 w-4" /> Rejeter…</Button>
              </>
            ) : (
              <>
                <SubmitButton name="decision" value="reject" variant="danger" pendingText="Rejet…"><X className="h-4 w-4" /> Confirmer le rejet</SubmitButton>
                <Button type="button" variant="secondary" onClick={() => setRejecting(false)}>Annuler</Button>
              </>
            )}
          </div>
        </form>
      )}
      {sState?.ok && <p className="text-xs text-success-text">{sState.message}</p>}
      {rState?.ok && <p className="text-xs text-success-text">{rState.message}</p>}
      {status === 'validated' && <p className="flex items-center gap-1.5 text-sm text-success-text"><ClipboardCheck className="h-4 w-4" /> Cette version est validée. Toute nouvelle version devra être revalidée.</p>}
    </div>
  )
}

export function CommentForm({ docId, clientId }: { docId: string; clientId: string }) {
  const [state, formAction] = useActionState(addCommentAction, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.ok) ref.current?.reset() }, [state])
  return (
    <form ref={ref} action={formAction} className="space-y-2">
      <input type="hidden" name="document_id" value={docId} /><input type="hidden" name="client_id" value={clientId} />
      {state && !state.ok && <Alert tone="error">{state.message}</Alert>}
      <Textarea name="body" rows={3} required maxLength={2000} placeholder="Ajouter un commentaire…" aria-label="Nouveau commentaire" />
      <div className="flex justify-end"><SubmitButton size="sm" pendingText="Publication…">Publier</SubmitButton></div>
    </form>
  )
}

export function RestoreVersionButton({ docId, versionId, versionNo }: { docId: string; versionId: string; versionNo: number }) {
  const [state, formAction] = useActionState(restoreVersionAction, null)
  return (
    <form action={formAction} onSubmit={(e) => { if (!window.confirm(`Créer une nouvelle version identique à la version ${versionNo} ?`)) e.preventDefault() }}>
      <input type="hidden" name="document_id" value={docId} /><input type="hidden" name="version_id" value={versionId} />
      <SubmitButton size="sm" variant="secondary" pendingText="Copie…"><History className="h-4 w-4" /> Restaurer</SubmitButton>
      {state && !state.ok && <p className="mt-1 text-xs text-danger-text">{state.message}</p>}
    </form>
  )
}

export function PurgeButton({ id, clientId, title }: { id: string; clientId: string; title: string }) {
  const [state, formAction] = useActionState(purgeDocumentAction, null)
  return (
    <form action={formAction} onSubmit={(e) => { if (!window.confirm(`Supprimer définitivement « ${title} » et toutes ses versions ? Cette action est irréversible.`)) e.preventDefault() }}>
      <input type="hidden" name="id" value={id} /><input type="hidden" name="client_id" value={clientId} />
      <SubmitButton size="sm" variant="danger" pendingText="Suppression…"><Trash2 className="h-4 w-4" /> Supprimer</SubmitButton>
      {state && !state.ok && <p className="mt-1 text-xs text-danger-text">{state.message}</p>}
    </form>
  )
}

export function EmptyTrashButton({ clientId, count }: { clientId: string; count: number }) {
  const [open, setOpen] = useState(false)
  const [state, formAction] = useActionState(async (p: Parameters<typeof emptyTrashAction>[0], fd: FormData) => {
    const r = await emptyTrashAction(p, fd)
    if (r?.ok) setOpen(false)
    return r
  }, null)
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)} disabled={count === 0}><Trash2 className="h-4 w-4" /> Vider la corbeille</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Vider la corbeille ?">
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="client_id" value={clientId} />
          {state && !state.ok && <Alert tone="error">{state.message}</Alert>}
          <Alert tone="warning">{count} document(s) et toutes leurs versions seront supprimés définitivement. Une trace reste dans le journal.</Alert>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Annuler</Button>
            <SubmitButton variant="danger" pendingText="Suppression…">Vider définitivement</SubmitButton>
          </div>
        </form>
      </Dialog>
    </>
  )
}

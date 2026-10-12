'use client'

import { useActionState, useEffect, useState } from 'react'
import { Download, FileText, Paperclip, Plus, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { SUPPLIER_DOC_TYPES, label } from '@/lib/suppliers/options'
import { formatDateTime } from '@/lib/utils'
import { deleteSupplierDocumentAction, uploadSupplierDocumentAction } from '../actions'
import type { SupplierDocument } from '../types'

const fmtSize = (n: number) => (n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(0)} Ko` : `${(n / 1048576).toFixed(1)} Mo`)

function expiry(valid: string | null) {
  if (!valid) return null
  const days = Math.ceil((new Date(valid + 'T23:59:59').getTime() - Date.now()) / 86_400_000)
  if (days < 0) return { tone: 'danger' as const, text: `Expiré le ${new Date(valid).toLocaleDateString('fr-FR')}` }
  if (days <= 60) return { tone: 'warning' as const, text: `Expire dans ${days} j` }
  return { tone: 'neutral' as const, text: `Valide jusqu’au ${new Date(valid).toLocaleDateString('fr-FR')}` }
}

function UploadForm({ supplierId, onDone }: { supplierId: string; onDone: () => void }) {
  const [state, formAction] = useActionState(uploadSupplierDocumentAction, null)
  const errs = state?.fieldErrors ?? {}
  useEffect(() => { if (state?.ok) onDone() }, [state, onDone])
  return (
    <form action={formAction} className="space-y-4 rounded-md border border-brand-200 bg-brand-50/40 p-4" noValidate>
      <input type="hidden" name="supplier_id" value={supplierId} />
      {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="sd-title" label="Titre *" errors={errs.title}><Input id="sd-title" name="title" required defaultValue={state?.values?.title ?? ''} /></FormField>
        <FormField id="sd-type" label="Type *" errors={errs.doc_type}>
          <Select id="sd-type" name="doc_type" defaultValue={state?.values?.doc_type ?? 'price_list'}>
            {SUPPLIER_DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </FormField>
        <FormField id="sd-valid" label="Valide jusqu’au" errors={errs.valid_until} hint="Contrats, tarifs, certificats.">
          <Input id="sd-valid" name="valid_until" type="date" defaultValue={state?.values?.valid_until ?? ''} />
        </FormField>
        <FormField id="sd-file" label="Fichier *" errors={errs.file} hint="PDF, image, Word, Excel, texte — 10 Mo maximum.">
          <input id="sd-file" name="file" type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv"
            className="block w-full text-sm file:mr-3 file:rounded-sm file:border-0 file:bg-brand-500 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white hover:file:bg-brand-600" />
        </FormField>
      </div>
      <FormField id="sd-notes" label="Notes" errors={errs.notes}><Input id="sd-notes" name="notes" defaultValue={state?.values?.notes ?? ''} /></FormField>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>Annuler</Button>
        <SubmitButton pendingText="Envoi en cours…">Envoyer le document</SubmitButton>
      </div>
    </form>
  )
}

export function SupplierDocumentsPanel({ supplierId, documents, canWrite, locked }: { supplierId: string; documents: SupplierDocument[]; canWrite: boolean; locked: boolean }) {
  const [adding, setAdding] = useState(false)
  const editable = canWrite && !locked
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{documents.length} document(s)</p>
        {editable && !adding && <Button size="sm" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Ajouter un document</Button>}
      </div>
      {adding && <UploadForm supplierId={supplierId} onDone={() => setAdding(false)} />}
      <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
        {documents.map((d) => {
          const exp = expiry(d.valid_until)
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <FileText className="h-5 w-5 shrink-0 text-brand-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{d.title}</p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
                  <Badge>{label(SUPPLIER_DOC_TYPES, d.doc_type)}</Badge>
                  <span className="inline-flex items-center gap-1"><Paperclip className="h-3 w-3" />{d.file_name} · {fmtSize(d.size_bytes)}</span>
                  <span>Ajouté le {formatDateTime(d.created_at)}</span>
                  {exp && <Badge tone={exp.tone}>{exp.text}</Badge>}
                </p>
                {d.notes && <p className="mt-1 text-xs text-ink-soft">{d.notes}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <a href={`/suppliers/${supplierId}/documents/${d.id}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}><Download className="h-4 w-4" /> Télécharger</a>
                {editable && (
                  <form action={deleteSupplierDocumentAction} onSubmit={(e) => { if (!window.confirm(`Supprimer « ${d.title} » ?`)) e.preventDefault() }}>
                    <input type="hidden" name="id" value={d.id} /><input type="hidden" name="supplier_id" value={supplierId} />
                    <Button variant="ghost" size="sm" type="submit" aria-label={`Supprimer ${d.title}`}><Trash2 className="h-4 w-4 text-danger-text" /></Button>
                  </form>
                )}
              </div>
            </li>
          )
        })}
        {documents.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-soft">Aucun document. {editable ? 'Ajoutez le contrat, les tarifs ou les certificats.' : ''}</li>}
      </ul>
    </div>
  )
}

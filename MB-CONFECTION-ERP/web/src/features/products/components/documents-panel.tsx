'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Link2, Unlink } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SubmitButton } from '@/components/auth/submit-button'
import { humanSize } from '@/lib/ged/constants'
import { DOC_KINDS, label } from '@/lib/products/options'
import { ExpiryBadge, FileIcon, StatusBadge } from '@/features/ged/components/badges'
import { Uploader } from '@/features/ged/components/uploader'
import { linkDocumentsAction, unlinkDocumentAction } from '../actions'
import type { ProductDocument } from '../types'

/** Documents de la GED rattachés au produit, classés par type (patronages, fiches techniques, rapports d'essai…). */
export function DocumentsPanel({ productId, clientId, docs, kinds, intro, folders, linkable, editable, canUpload }: {
  productId: string
  clientId: string
  docs: ProductDocument[]
  /** Types proposés (et affichés) dans cet onglet. */
  kinds: readonly string[]
  intro: string
  folders: { id: string; label: string }[]
  linkable: { id: string; title: string; folder: string }[]
  editable: boolean
  canUpload: boolean
}) {
  const options = DOC_KINDS.filter((k) => kinds.includes(k.value))
  const [kind, setKind] = useState<(typeof DOC_KINDS)[number]['value']>(options[0]?.value ?? 'other')
  const [revision, setRevision] = useState('')
  const [folder, setFolder] = useState(folders[0]?.id ?? '')
  const [open, setOpen] = useState(false)
  const [lState, lAction] = useActionState(async (p: Parameters<typeof linkDocumentsAction>[0], fd: FormData) => {
    const r = await linkDocumentsAction(p, fd)
    if (r?.ok) setOpen(false)
    return r
  }, null)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{docs.length} document(s) — {intro}</p>
        <div className="flex gap-2">
          {editable && linkable.length > 0 && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Link2 className="h-4 w-4" /> Rattacher un document existant</Button>}
          <Link href={`/ged/${clientId}`} className={buttonVariants({ size: 'sm', variant: 'secondary' })}><ExternalLink className="h-4 w-4" /> Ouvrir la GED du client</Link>
        </div>
      </div>

      {editable && canUpload && folders.length > 0 && (
        <div className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><label htmlFor="pd-kind" className="mb-1 block text-sm font-semibold">Type de document</label>
              <Select id="pd-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{options.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></div>
            <div><label htmlFor="pd-rev" className="mb-1 block text-sm font-semibold">Révision (facultatif)</label><Input id="pd-rev" maxLength={30} value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="Rév. C" /></div>
            <div><label htmlFor="pd-folder" className="mb-1 block text-sm font-semibold">Dossier de la GED</label>
              <Select id="pd-folder" value={folder} onChange={(e) => setFolder(e.target.value)}>{folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select></div>
          </div>
          <Uploader key={`${folder}|${kind}|${revision}`} clientId={clientId} folderId={folder} productId={productId} productKind={kind} productRevision={revision} />
        </div>
      )}

      <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
        {docs.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <FileIcon mime={d.mime_type} className="h-5 w-5" />
            <div className="min-w-0 flex-1">
              <Link href={`/ged/${d.client_id}/${d.ged_document_id}`} className="block truncate font-semibold text-brand-700 hover:underline">{d.title}</Link>
              <p className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                <Badge tone="brand">{label(DOC_KINDS, d.kind)}</Badge>{d.revision && <Badge tone="neutral">{d.revision}</Badge>}
                <span>{d.file_name} · {humanSize(d.size_bytes)} · v{d.version_count}</span><StatusBadge status={d.status as never} /><ExpiryBadge validUntil={d.valid_until} />
              </p>
            </div>
            {editable && (
              <form action={unlinkDocumentAction} onSubmit={(e) => { if (!window.confirm(`Détacher « ${d.title} » du produit ? Le document reste dans la GED.`)) e.preventDefault() }}>
                <input type="hidden" name="id" value={d.id} /><input type="hidden" name="product_id" value={productId} />
                <Button type="submit" variant="ghost" size="sm" aria-label={`Détacher ${d.title}`}><Unlink className="h-4 w-4" /> Détacher</Button>
              </form>
            )}
          </li>
        ))}
        {docs.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-soft">Aucun document rattaché.</li>}
      </ul>

      <Dialog open={open} onClose={() => setOpen(false)} title="Rattacher des documents de la GED">
        <form action={lAction} className="space-y-4">
          <input type="hidden" name="product_id" value={productId} />
          {lState && !lState.ok && <Alert tone="error">{lState.message}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label htmlFor="lk-kind" className="mb-1 block text-sm font-semibold">Type</label>
              <Select id="lk-kind" name="kind" defaultValue={options[0]?.value}>{options.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></div>
            <div><label htmlFor="lk-rev" className="mb-1 block text-sm font-semibold">Révision (facultatif)</label><Input id="lk-rev" name="revision" maxLength={30} /></div>
          </div>
          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {linkable.map((d) => (
              <li key={d.id}><label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-canvas"><Checkbox name="doc" value={d.id} /><span className="min-w-0 flex-1 truncate">{d.title}</span><span className="text-xs text-ink-faint">{d.folder}</span></label></li>
            ))}
          </ul>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Annuler</Button><SubmitButton pendingText="Rattachement…">Rattacher</SubmitButton></div>
        </form>
      </Dialog>
    </div>
  )
}

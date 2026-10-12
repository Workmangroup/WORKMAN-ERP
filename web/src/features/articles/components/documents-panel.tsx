'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Link2, Unlink } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog } from '@/components/ui/dialog'
import { Select } from '@/components/ui/select'
import { SubmitButton } from '@/components/auth/submit-button'
import { humanSize } from '@/lib/ged/constants'
import { ExpiryBadge, FileIcon, StatusBadge } from '@/features/ged/components/badges'
import { Uploader } from '@/features/ged/components/uploader'
import { linkDocumentsAction, unlinkDocumentAction } from '../actions'
import type { LinkedDocument } from '../types'

/** Documents de la GED rattachés à l'article : dépôt direct, rattachement de documents existants, détachement. */
export function ArticleDocuments({
  articleId,
  clientId,
  docs,
  folders,
  unlinked,
  canWrite,
  locked,
}: {
  articleId: string
  clientId: string
  docs: LinkedDocument[]
  folders: { id: string; label: string }[]
  unlinked: { id: string; title: string; folder: string }[]
  canWrite: boolean
  locked: boolean
}) {
  const [folder, setFolder] = useState(folders[0]?.id ?? '')
  const [open, setOpen] = useState(false)
  const [lState, lAction] = useActionState(async (p: Parameters<typeof linkDocumentsAction>[0], fd: FormData) => {
    const r = await linkDocumentsAction(p, fd)
    if (r?.ok) setOpen(false)
    return r
  }, null)
  const editable = canWrite && !locked

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{docs.length} document(s) de la GED rattaché(s) à cet article (patronages, certificats, BAT, fiches techniques…).</p>
        <div className="flex gap-2">
          {editable && unlinked.length > 0 && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Link2 className="h-4 w-4" /> Rattacher un document existant</Button>}
          <Link href={`/ged/${clientId}`} className={buttonVariants({ size: 'sm', variant: 'secondary' })}><ExternalLink className="h-4 w-4" /> Ouvrir la GED du client</Link>
        </div>
      </div>

      {editable && folders.length > 0 && (
        <div className="space-y-2 rounded-md border border-line bg-white p-4 shadow-card">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="art-folder" className="text-sm font-semibold">Déposer dans le dossier</label>
            <Select id="art-folder" value={folder} onChange={(e) => setFolder(e.target.value)} className="w-56">{folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>
          </div>
          <Uploader key={folder} clientId={clientId} folderId={folder} articleId={articleId} />
        </div>
      )}

      <ul className="divide-y divide-line rounded-md border border-line bg-white shadow-card">
        {docs.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <FileIcon mime={d.mime_type} className="h-5 w-5" />
            <div className="min-w-0 flex-1">
              <Link href={`/ged/${d.client_id}/${d.id}`} className="block truncate font-semibold text-brand-700 hover:underline">{d.title}</Link>
              <p className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                <span>{d.file_name} · {humanSize(d.size_bytes)} · v{d.version_count}</span><StatusBadge status={d.status} /><ExpiryBadge validUntil={d.valid_until} />
              </p>
            </div>
            {editable && (
              <form action={unlinkDocumentAction} onSubmit={(e) => { if (!window.confirm(`Détacher « ${d.title} » de l’article ? Le document reste dans la GED.`)) e.preventDefault() }}>
                <input type="hidden" name="id" value={d.id} /><input type="hidden" name="article_id" value={articleId} />
                <Button type="submit" variant="ghost" size="sm" aria-label={`Détacher ${d.title}`}><Unlink className="h-4 w-4" /> Détacher</Button>
              </form>
            )}
          </li>
        ))}
        {docs.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-soft">Aucun document rattaché.</li>}
      </ul>

      <Dialog open={open} onClose={() => setOpen(false)} title="Rattacher des documents de la GED">
        <form action={lAction} className="space-y-4">
          <input type="hidden" name="article_id" value={articleId} />
          {lState && !lState.ok && <Alert tone="error">{lState.message}</Alert>}
          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {unlinked.map((d) => (
              <li key={d.id}><label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-canvas"><Checkbox name="doc" value={d.id} /><span className="min-w-0 flex-1 truncate">{d.title}</span><span className="text-xs text-ink-faint">{d.folder}</span></label></li>
            ))}
          </ul>
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>Annuler</Button><SubmitButton pendingText="Rattachement…">Rattacher</SubmitButton></div>
        </form>
      </Dialog>
    </div>
  )
}

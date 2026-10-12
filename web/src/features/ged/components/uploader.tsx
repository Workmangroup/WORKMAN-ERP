'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, CircleAlert, Loader2, Trash2, UploadCloud, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'
import { ACCEPT_ATTR, GED_BUCKET, MAX_FILE_BYTES, extensionOf, fileTypeOf, humanSize } from '@/lib/ged/constants'
import { cn } from '@/lib/utils'
import { finalizeUploadAction, prepareUploadAction } from '../actions'

type Status = 'ready' | 'working' | 'done' | 'error' | 'skipped'
interface Item {
  id: string
  file: File
  title: string
  status: Status
  message?: string
}

const sha256 = async (file: File) => {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const stem = (n: string) => n.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/_+/g, ' ').trim()

function validate(file: File): string | null {
  if (!fileTypeOf(file.name)) return `Format « .${extensionOf(file.name) || '?'} » non autorisé`
  if (file.size === 0) return 'Fichier vide'
  if (file.size > MAX_FILE_BYTES) return `Trop volumineux (${humanSize(file.size)}, 25 Mo max.)`
  return null
}

/**
 * Dépôt de fichiers : glisser-déposer ou sélection. Le fichier part directement vers Supabase Storage
 * (URL signée générée côté serveur) puis est contrôlé et enregistré (versionnement inclus).
 */
export function Uploader({
  clientId,
  folderId,
  documentId,
  mode = 'create',
  articleId,
  productId,
  productKind,
  productRevision,
  devProjectId,
  devKind,
  disabled = false,
  disabledReason,
}: {
  clientId: string
  folderId?: string
  documentId?: string
  /** Rattache automatiquement les nouveaux documents à cet article (module Articles). */
  articleId?: string
  /** Rattache automatiquement les nouveaux documents à ce produit (module PDM). */
  productId?: string
  productKind?: 'tech_sheet' | 'pattern' | 'marker' | 'grading' | 'sample_approval' | 'test_report' | 'label' | 'packaging' | 'other'
  productRevision?: string
  /** Rattache automatiquement les nouveaux documents à ce projet de développement produit. */
  devProjectId?: string
  devKind?: 'request' | 'tech_pack' | 'photo' | 'bat' | 'sample_report' | 'approval' | 'other'
  mode?: 'create' | 'version'
  disabled?: boolean
  disabledReason?: string
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<Item[]>([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const single = mode === 'version'

  const patch = (id: string, p: Partial<Item>) => setItems((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i)))

  const addFiles = useCallback((list: FileList | File[]) => {
    const files = [...list].slice(0, single ? 1 : 50)
    const next: Item[] = files.map((file) => {
      const err = validate(file)
      return { id: crypto.randomUUID(), file, title: stem(file.name), status: err ? 'error' : 'ready', message: err ?? undefined }
    })
    setItems((cur) => (single ? next : [...cur, ...next]))
  }, [single])

  async function uploadOne(item: Item) {
    patch(item.id, { status: 'working', message: 'Analyse du fichier…' })
    try {
      const hash = await sha256(item.file)
      const prep = await prepareUploadAction({
        mode, clientId, folderId, documentId, fileName: item.file.name, size: item.file.size, sha256: hash,
      })
      if (!prep.ok) return patch(item.id, { status: 'error', message: prep.message })
      if (prep.duplicate && !window.confirm(
        mode === 'version'
          ? `Ce fichier est identique à un document existant (« ${prep.duplicate.title} »). L’ajouter quand même comme version ?`
          : `Un document identique existe déjà : « ${prep.duplicate.title} ». Le téléverser quand même ?`,
      )) return patch(item.id, { status: 'skipped', message: 'Ignoré (doublon)' })

      patch(item.id, { message: 'Envoi en cours…' })
      const supabase = createClient()
      const { error } = await supabase.storage.from(GED_BUCKET).uploadToSignedUrl(prep.path, prep.token, item.file, {
        contentType: fileTypeOf(item.file.name)!.mime,
      })
      if (error) return patch(item.id, { status: 'error', message: 'Échec de l’envoi du fichier.' })

      patch(item.id, { message: 'Vérification…' })
      const fin = await finalizeUploadAction({
        mode, clientId, folderId, documentId: prep.documentId, versionId: prep.versionId, path: prep.path,
        fileName: item.file.name, sha256: hash, title: item.title, note: note || undefined, articleId, productId, productKind, productRevision: productRevision || undefined, devProjectId, devKind,
      })
      if (!fin.ok) return patch(item.id, { status: 'error', message: fin.message })
      patch(item.id, { status: 'done', message: fin.version ? `Version ${fin.version} ajoutée` : 'Téléversé' })
    } catch {
      patch(item.id, { status: 'error', message: 'Erreur inattendue pendant l’envoi.' })
    }
  }

  async function start() {
    setBusy(true)
    for (const item of items.filter((i) => i.status === 'ready')) await uploadOne(item) // séquentiel : ménage le réseau
    setBusy(false)
    router.refresh()
  }

  const ready = items.filter((i) => i.status === 'ready').length
  const finished = items.length > 0 && items.every((i) => i.status !== 'ready' && i.status !== 'working')

  if (disabled) {
    return disabledReason ? <p className="rounded-md border border-dashed border-line-strong px-4 py-3 text-sm text-ink-soft">{disabledReason}</p> : null
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy && e.dataTransfer.files.length) addFiles(e.dataTransfer.files) }}
      className={cn('rounded-md border-2 border-dashed bg-white transition-colors', dragging ? 'border-brand-500 bg-brand-50' : 'border-line-strong')}
    >
      <input ref={inputRef} type="file" multiple={!single} accept={ACCEPT_ATTR} className="sr-only" tabIndex={-1}
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />

      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}
        className="flex w-full flex-col items-center gap-1 px-4 py-5 text-center text-sm disabled:opacity-60">
        <UploadCloud className={cn('h-7 w-7', dragging ? 'text-brand-500' : 'text-ink-faint')} aria-hidden />
        <span className="font-semibold text-ink">
          {single ? 'Glissez la nouvelle version ici' : 'Glissez-déposez vos fichiers ici'} <span className="font-normal text-brand-600">ou parcourez</span>
        </span>
        <span className="text-xs text-ink-soft">PDF, images, Word, Excel, DXF, PLT, AI… — 25 Mo maximum par fichier</span>
      </button>

      {items.length > 0 && (
        <div className="space-y-3 border-t border-line p-4">
          {single && (
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note de version (facultatif) : ce qui a changé…" maxLength={500} aria-label="Note de version" disabled={busy} />
          )}
          <ul className="space-y-2">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 rounded-sm bg-canvas px-3 py-2 text-sm">
                {i.status === 'working' ? <Loader2 className="h-4 w-4 animate-spin text-brand-500" aria-label="En cours" />
                  : i.status === 'done' ? <CheckCircle2 className="h-4 w-4 text-success-text" aria-label="Terminé" />
                  : i.status === 'error' ? <CircleAlert className="h-4 w-4 text-danger-text" aria-label="Erreur" />
                  : null}
                {!single && i.status === 'ready' ? (
                  <Input value={i.title} onChange={(e) => patch(i.id, { title: e.target.value })} className="h-8 min-w-48 flex-1" aria-label={`Titre de ${i.file.name}`} />
                ) : (
                  <span className="min-w-0 flex-1 truncate font-medium">{single ? i.file.name : i.title}</span>
                )}
                <span className="text-xs text-ink-soft">{humanSize(i.file.size)}</span>
                {i.message && <span className={cn('text-xs', i.status === 'error' ? 'text-danger-text' : i.status === 'done' ? 'text-success-text' : 'text-ink-soft')}>{i.message}</span>}
                {i.status !== 'working' && (
                  <button type="button" onClick={() => setItems((c) => c.filter((x) => x.id !== i.id))} className="rounded-sm p-1 text-ink-faint hover:bg-white hover:text-danger-text" aria-label={`Retirer ${i.file.name}`}>
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {finished ? (
              <Button variant="secondary" size="sm" onClick={() => setItems([])}><Trash2 className="h-4 w-4" /> Effacer la liste</Button>
            ) : (
              <Button size="sm" onClick={start} disabled={busy || ready === 0}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {busy ? 'Envoi…' : `Téléverser ${ready} fichier${ready > 1 ? 's' : ''}`}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

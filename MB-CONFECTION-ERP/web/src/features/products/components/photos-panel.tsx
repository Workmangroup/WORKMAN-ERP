'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { ImagePlus, Star, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SubmitButton } from '@/components/auth/submit-button'
import { PHOTO_VIEWS, label } from '@/lib/products/options'
import { cn } from '@/lib/utils'
import { deletePhotoAction, setMainPhotoAction, uploadPhotoAction } from '../actions'
import type { ProductPhoto } from '../types'

export function PhotosPanel({ productId, clientId, photos, colors, editable }: { productId: string; clientId: string; photos: ProductPhoto[]; colors: string[]; editable: boolean }) {
  const [state, formAction] = useActionState(uploadPhotoAction, null)
  const formRef = useRef<HTMLFormElement>(null)
  const [dragging, setDragging] = useState(false)
  const [lightbox, setLightbox] = useState<ProductPhoto | null>(null)
  const [filter, setFilter] = useState('')
  useEffect(() => { if (state?.ok) formRef.current?.reset() }, [state])
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLightbox(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightbox])
  const shown = filter ? photos.filter((p) => p.color === filter) : photos
  const used = [...new Set(photos.map((p) => p.color).filter(Boolean))] as string[]

  return (
    <div className="space-y-4">
      {editable && (
        <form ref={formRef} action={formAction} className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
          <input type="hidden" name="product_id" value={productId} />
          <input type="hidden" name="client_id" value={clientId} />
          {state?.message && <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
          <label onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={() => setDragging(false)}
            className={cn('relative flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-4 py-6 text-center text-sm transition-colors', dragging ? 'border-brand-500 bg-brand-50' : 'border-line-strong hover:bg-canvas')}>
            <ImagePlus className="h-7 w-7 text-ink-faint" aria-hidden />
            <span className="font-semibold">Glissez des photos ici <span className="font-normal text-brand-600">ou parcourez</span></span>
            <span className="text-xs text-ink-soft">JPG, PNG ou WebP — 8 Mo maximum, 30 photos par produit</span>
            <input type="file" name="file" accept=".jpg,.jpeg,.png,.webp" multiple aria-label="Choisir des photos" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
          </label>
          <div className="grid gap-3 sm:grid-cols-[10rem_12rem_1fr_auto] sm:items-end">
            <div><label htmlFor="ph-view" className="mb-1 block text-sm font-semibold">Vue</label>
              <Select id="ph-view" name="view" defaultValue="front">{PHOTO_VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</Select></div>
            <div><label htmlFor="ph-color" className="mb-1 block text-sm font-semibold">Coloris</label>
              <Select id="ph-color" name="color" defaultValue=""><option value="">— Tous / non précisé —</option>{colors.map((c) => <option key={c} value={c}>{c}</option>)}</Select></div>
            <div><label htmlFor="ph-cap" className="mb-1 block text-sm font-semibold">Légende (facultatif)</label><Input id="ph-cap" name="caption" maxLength={200} /></div>
            <SubmitButton pendingText="Envoi…">Ajouter les photos</SubmitButton>
          </div>
        </form>
      )}

      {used.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-soft">Coloris :</span>
          <Button type="button" size="sm" variant={filter === '' ? 'primary' : 'secondary'} onClick={() => setFilter('')}>Tous</Button>
          {used.map((c) => <Button key={c} type="button" size="sm" variant={filter === c ? 'primary' : 'secondary'} onClick={() => setFilter(c)}>{c}</Button>)}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune photo. {editable ? 'Ajoutez la face, le dos et les détails du produit.' : ''}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((p) => (
            <li key={p.id} className="overflow-hidden rounded-md border border-line bg-white shadow-card">
              <button type="button" onClick={() => setLightbox(p)} className="relative block aspect-[4/5] w-full bg-canvas" aria-label={`Agrandir ${p.file_name}`}>
                {/* eslint-disable-next-line */}
                <img src={`/products/photo/${p.id}`} alt={p.caption || `${label(PHOTO_VIEWS, p.view)} — ${p.file_name}`} loading="lazy" className="h-full w-full object-cover" />
                {p.is_main && <Badge tone="brand" className="absolute left-2 top-2"><Star className="mr-1 h-3 w-3" /> Principale</Badge>}
              </button>
              <div className="space-y-1.5 p-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-1"><span className="flex flex-wrap gap-1"><Badge>{label(PHOTO_VIEWS, p.view)}</Badge>{p.color && <Badge tone="neutral">{p.color}</Badge>}</span><span className="text-ink-faint">{Math.round(p.size_bytes / 1024)} Ko</span></div>
                {p.caption && <p className="text-ink-soft">{p.caption}</p>}
                {editable && (
                  <div className="flex items-center justify-between gap-1">
                    {!p.is_main ? (
                      <form action={setMainPhotoAction}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="product_id" value={productId} />
                        <Button type="submit" variant="ghost" size="sm"><Star className="h-3.5 w-3.5" /> Principale</Button></form>
                    ) : <span />}
                    <form action={deletePhotoAction} onSubmit={(e) => { if (!window.confirm('Supprimer cette photo ?')) e.preventDefault() }}>
                      <input type="hidden" name="id" value={p.id} /><input type="hidden" name="product_id" value={productId} />
                      <Button type="submit" variant="ghost" size="sm" aria-label="Supprimer la photo"><Trash2 className="h-3.5 w-3.5 text-danger-text" /></Button>
                    </form>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label={lightbox.file_name} onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line */}
          <img src={`/products/photo/${lightbox.id}`} alt={lightbox.caption || lightbox.file_name} className="max-h-full max-w-full rounded-md object-contain" />
          <button type="button" onClick={() => setLightbox(null)} className="absolute right-4 top-4 rounded-md bg-white/90 px-3 py-1.5 text-sm font-semibold" autoFocus>Fermer</button>
        </div>
      )}
    </div>
  )
}

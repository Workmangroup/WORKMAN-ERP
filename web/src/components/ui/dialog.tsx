'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Boîte de dialogue modale basée sur <dialog> (focus piégé, Échap, accessible). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  className?: string
}) {
  const ref = React.useRef<HTMLDialogElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="dialog-title"
      className={cn('m-auto w-[calc(100%-2rem)] max-w-lg rounded-md p-0 shadow-pop backdrop:bg-black/40', className)}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id="dialog-title" className="text-base font-semibold">{title}</h2>
        <button type="button" onClick={onClose} className="rounded-sm p-1 text-ink-soft hover:bg-canvas" aria-label="Fermer">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-5">{open ? children : null}</div>
    </dialog>
  )
}

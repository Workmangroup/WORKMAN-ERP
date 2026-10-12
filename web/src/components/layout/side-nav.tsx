'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { ErpSidebar } from './erp-sidebar'

/** Navigation latérale (≥ md) : menu compact, sous-menus repliables, favoris. */
export function SideNav() {
  return (
    <nav aria-label="Menu latéral" className="hidden w-60 shrink-0 overflow-y-auto border-r border-line bg-surface md:sticky md:top-12 md:block md:h-[calc(100vh-3rem)]">
      <ErpSidebar />
    </nav>
  )
}

/** Menu tiroir pour mobile et tablette portrait (< md). */
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => setOpen(false), [pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-9 items-center justify-center rounded-sm text-white hover:bg-white/10"
        aria-label="Ouvrir le menu"
        aria-expanded={open}
      >
        <Menu className="h-5 w-5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu principal">
          <button type="button" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} aria-label="Fermer le menu" />
          <nav className="absolute inset-y-0 left-0 w-72 max-w-[85%] overflow-y-auto bg-surface shadow-pop">
            <div className="flex h-12 items-center justify-between bg-shell px-4 text-white">
              <span className="font-semibold">WORKMAN <span className="font-normal text-white/70">ERP 360</span></span>
              <button type="button" onClick={() => setOpen(false)} className="rounded-sm p-1 hover:bg-white/10" aria-label="Fermer"><X className="h-5 w-5" /></button>
            </div>
            <ErpSidebar onNavigate={() => setOpen(false)} />
          </nav>
        </div>
      )}
    </div>
  )
}

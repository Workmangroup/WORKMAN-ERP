'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, useTransition } from 'react'
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react'
import { initials } from '@/lib/utils'
import { ROUTES } from '@/lib/auth/constants'
import { useAuth } from '@/features/auth'
import { signOutAction } from '@/features/auth/actions'

export function UserMenu() {
  const { profile, roles, user } = useAuth()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white hover:bg-brand-400"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu du compte"
      >
        {initials(profile.full_name)}
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-10 z-40 w-72 rounded-md border border-line bg-white text-ink shadow-pop">
          <div className="flex items-center gap-3 border-b border-line p-4">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-500 text-base font-semibold text-white">
              {initials(profile.full_name)}
            </span>
            <div className="min-w-0">
              <p className="truncate font-semibold">{profile.full_name}</p>
              <p className="truncate text-xs text-ink-soft">{user.email}</p>
              <p className="truncate text-xs text-ink-faint">{roles.map((r) => r.label).join(', ') || 'Aucun rôle'}</p>
            </div>
          </div>
          <div className="py-1 text-sm">
            <Link role="menuitem" href={ROUTES.security} onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 hover:bg-canvas">
              <ShieldCheck className="h-4 w-4 text-ink-soft" /> Compte et sécurité
            </Link>
            <Link role="menuitem" href={`${ROUTES.security}#mot-de-passe`} onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 hover:bg-canvas">
              <KeyRound className="h-4 w-4 text-ink-soft" /> Changer le mot de passe
            </Link>
            <button
              role="menuitem"
              disabled={pending}
              onClick={() => startTransition(() => void signOutAction())}
              className="flex w-full items-center gap-2 border-t border-line px-4 py-2 text-left hover:bg-canvas disabled:opacity-50"
            >
              <LogOut className="h-4 w-4 text-ink-soft" /> {pending ? 'Déconnexion…' : 'Se déconnecter'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

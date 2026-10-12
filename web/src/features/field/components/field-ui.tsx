'use client'

import { useState, useTransition, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowLeft, Factory, Home, Maximize, Minimize, Moon, Package, ScanLine, Shirt, Sun, ClipboardCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FieldIcon, FieldTile } from '@/lib/field/logic'
import { clampStep } from '@/lib/field/logic'
import type { FieldResult } from '../actions'

const ICON: Record<FieldIcon, typeof Factory> = { scan: ScanLine, factory: Factory, check: ClipboardCheck, package: Package, fabric: Shirt, boxes: Package }

/** En-tête terrain : retour, accueil, plein écran et mode atelier sombre. Zones de toucher de 56 px minimum. */
export function FieldHeader({ name }: { name: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false
    return document.documentElement.getAttribute('data-theme') === 'dark'
  })
  const [full, setFull] = useState(false)
  const home = pathname === '/atelier'

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light')
    try { window.localStorage.setItem('mb-field-theme', next ? 'dark' : 'light') } catch { /* stockage indisponible */ }
  }
  const toggleFull = async () => {
    try {
      if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); setFull(true) }
      else { await document.exitFullscreen(); setFull(false) }
    } catch { /* plein écran refusé par le navigateur */ }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-shell text-white">
      <div className="mx-auto flex h-16 max-w-4xl items-center gap-2 px-3 sm:px-6">
        {!home && (
          <button type="button" onClick={() => router.back()} aria-label="Retour" className="flex h-14 w-14 items-center justify-center rounded-md bg-white/10 active:bg-white/20">
            <ArrowLeft className="h-7 w-7" aria-hidden />
          </button>
        )}
        <Link href="/atelier" aria-label="Accueil atelier" className="flex h-14 items-center gap-2 rounded-md px-3 text-lg font-semibold active:bg-white/10">
          <Home className="h-6 w-6" aria-hidden /> <span className="hidden sm:inline">Atelier</span>
        </Link>
        <p className="ml-auto truncate text-sm text-white/70 sm:text-base">{name}</p>
        <button type="button" onClick={toggleTheme} aria-pressed={dark} aria-label={dark ? 'Passer en mode clair' : 'Passer en mode sombre atelier'}
          className="flex h-14 w-14 items-center justify-center rounded-md bg-white/10 active:bg-white/20">
          {dark ? <Sun className="h-6 w-6" aria-hidden /> : <Moon className="h-6 w-6" aria-hidden />}
        </button>
        <button type="button" onClick={toggleFull} aria-pressed={full} aria-label={full ? 'Quitter le plein écran' : 'Plein écran'}
          className="hidden h-14 w-14 items-center justify-center rounded-md bg-white/10 active:bg-white/20 md:flex">
          {full ? <Minimize className="h-6 w-6" aria-hidden /> : <Maximize className="h-6 w-6" aria-hidden />}
        </button>
      </div>
    </header>
  )
}

/** Grande tuile d'accueil : toute la surface est cliquable, libellé lisible à distance. */
export function TileLink({ tile }: { tile: FieldTile }) {
  const Icon = ICON[tile.icon]
  return (
    <Link href={tile.href} className="flex min-h-[9rem] flex-col justify-between gap-4 rounded-lg border border-line bg-surface p-5 shadow-card transition active:scale-[0.99] active:bg-brand-50 sm:min-h-[11rem]">
      <span className="flex h-14 w-14 items-center justify-center rounded-md bg-brand-50 text-brand-700"><Icon className="h-8 w-8" aria-hidden /></span>
      <span>
        <span className="block text-xl font-semibold">{tile.label}</span>
        <span className="block text-base text-ink-soft">{tile.hint}</span>
      </span>
    </Link>
  )
}

/** Bouton de grande taille (60 px), pour usage au gant. Variante « danger » pour les actions à risque. */
export function BigButton({ children, onClick, disabled, tone = 'primary', type = 'button', className }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: 'primary' | 'secondary' | 'danger' | 'success'; type?: 'button' | 'submit'; className?: string
}) {
  const TONE = {
    primary: 'bg-brand-500 text-white active:bg-brand-600',
    secondary: 'border-2 border-brand-500 bg-surface text-brand-700 active:bg-brand-50',
    danger: 'bg-danger text-white active:opacity-90',
    success: 'bg-success text-white active:opacity-90',
  }[tone]
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={cn('flex min-h-[60px] w-full items-center justify-center gap-2 rounded-lg px-5 text-lg font-semibold transition disabled:opacity-40 active:scale-[0.99]', TONE, className)}>
      {children}
    </button>
  )
}

/** Compteur à gros boutons « − » et « + » (pas au clavier) ; la valeur reste lisible. */
export function Stepper({ label, value, onChange, step = 1, min = 0, max = 1_000_000 }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number
}) {
  const set = (v: number) => onChange(clampStep(Number(v.toFixed(2)), min, max))
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="mb-2 text-base font-medium text-ink-soft">{label}</p>
      <div className="grid grid-cols-[4.5rem_1fr_4.5rem] items-center gap-2">
        <button type="button" onClick={() => set(value - step)} aria-label={`Diminuer ${label}`} className="h-16 rounded-md bg-canvas text-3xl font-bold active:bg-line">−</button>
        <output className="text-center text-3xl font-bold tabular-nums" aria-live="polite">{value}</output>
        <button type="button" onClick={() => set(value + step)} aria-label={`Augmenter ${label}`} className="h-16 rounded-md bg-brand-500 text-3xl font-bold text-white active:bg-brand-600">+</button>
      </div>
    </div>
  )
}

/** Exécute une action serveur et affiche le résultat en grand. Évite les doubles envois (connexion lente). */
export function useFieldAction() {
  const [result, setResult] = useState<FieldResult | null>(null)
  const [pending, start] = useTransition()
  const run = (fn: () => Promise<FieldResult>, after?: () => void) => {
    if (pending) return
    start(async () => {
      const r = await fn()
      setResult(r)
      if (r.ok && r.href) { /* navigation gérée par l'appelant */ }
      if (r.ok && after) after()
    })
  }
  return { result, pending, run, clear: () => setResult(null) }
}

export function FieldFeedback({ result, pending }: { result: FieldResult | null; pending?: boolean }) {
  if (pending) return <p role="status" className="rounded-lg bg-brand-50 px-4 py-3 text-lg text-brand-700">Enregistrement en cours…</p>
  if (!result) return null
  return (
    <p role={result.ok ? 'status' : 'alert'} className={cn('rounded-lg px-4 py-3 text-lg font-medium', result.ok ? 'bg-success-bg text-success-text' : 'bg-danger-bg text-danger-text')}>
      {result.ok ? result.message ?? 'Fait.' : result.message}
    </p>
  )
}

'use client'

import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { mergeOrder, type WidgetId } from '@/lib/command-center/logic'

export interface WidgetItem { id: WidgetId; label: string; node: ReactNode }

const KEY = 'mb-command-layout:v1'

interface Stored { order: string[]; hidden: string[] }

/** Lit la mise en page enregistrée dans ce navigateur. Toute erreur (stockage bloqué, JSON invalide) donne la mise en page par défaut. */
function readStored(): Stored | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Stored>
    return { order: Array.isArray(v.order) ? v.order : [], hidden: Array.isArray(v.hidden) ? v.hidden : [] }
  } catch {
    return null
  }
}

function writeStored(s: Stored) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Stockage indisponible : la mise en page reste valable pour la session.
  }
}

/**
 * Grille de widgets réordonnable (glisser-déposer, ou flèches au clavier) et masquable.
 * La mise en page est enregistrée dans le navigateur (pas sur le compte) ; « Réinitialiser » la remet par défaut.
 */
export function WidgetLayout({ items }: { items: WidgetItem[] }) {
  const available = items.map((i) => i.id)
  const [order, setOrder] = useState<WidgetId[]>(available)
  const [hidden, setHidden] = useState<WidgetId[]>([])
  const [dragging, setDragging] = useState<WidgetId | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const s = readStored()
    if (s) {
      setOrder(mergeOrder(s.order, available))
      setHidden(s.hidden.filter((id): id is WidgetId => available.includes(id as WidgetId)))
    }
    setReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lecture initiale uniquement
  }, [])

  const save = (nextOrder: WidgetId[], nextHidden: WidgetId[]) => {
    setOrder(nextOrder)
    setHidden(nextHidden)
    writeStored({ order: nextOrder, hidden: nextHidden })
  }
  const move = (id: WidgetId, delta: number) => {
    const i = order.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    save(next, hidden)
  }
  const toggle = (id: WidgetId) => save(order, hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id])
  const reset = () => {
    try { window.localStorage.removeItem(KEY) } catch { /* sans effet */ }
    setOrder(available)
    setHidden([])
  }
  const drop = (target: WidgetId) => {
    if (!dragging || dragging === target) return
    const next = order.filter((id) => id !== dragging)
    next.splice(next.indexOf(target), 0, dragging)
    save(next, hidden)
    setDragging(null)
  }

  const byId = new Map(items.map((i) => [i.id, i]))
  const visible = order.filter((id) => !hidden.includes(id))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
        <span>Glissez les blocs ou utilisez les flèches. La mise en page est enregistrée dans ce navigateur.</span>
        <button type="button" onClick={reset} className="inline-flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 hover:text-ink">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />Réinitialiser
        </button>
      </div>

      {hidden.length > 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Blocs masqués">
          {hidden.map((id) => (
            <button key={id} type="button" onClick={() => toggle(id)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-3 py-1 text-xs text-ink-soft hover:text-ink">
              <Eye className="h-3.5 w-3.5" aria-hidden />Afficher « {byId.get(id)?.label} »
            </button>
          ))}
        </div>
      )}

      <div className={cn('grid gap-4 xl:grid-cols-2', !ready && 'opacity-95')}>
        {visible.map((id, index) => {
          const item = byId.get(id)
          if (!item) return null
          const wide = id === 'briefing' || id === 'agenda' || id === 'validations' || id === 'alerts'
          return (
            <section key={id} aria-label={item.label}
              draggable
              onDragStart={(e: DragEvent) => { setDragging(id); e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={(e: DragEvent) => { if (dragging) e.preventDefault() }}
              onDrop={(e: DragEvent) => { e.preventDefault(); drop(id) }}
              onDragEnd={() => setDragging(null)}
              className={cn('relative min-w-0 rounded-lg border border-line bg-surface p-4 shadow-card transition-shadow duration-200 motion-reduce:transition-none',
                wide && 'xl:col-span-2', dragging === id && 'opacity-60 ring-2 ring-brand-500')}>
              <header className="mb-3 flex items-center justify-between gap-2">
                <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                  <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-ink-faint" aria-hidden />
                  <span className="truncate">{item.label}</span>
                </h2>
                <div className="flex shrink-0 items-center gap-1">
                  <IconBtn label={`Monter ${item.label}`} disabled={index === 0} onClick={() => move(id, -1)}><ArrowUp className="h-3.5 w-3.5" aria-hidden /></IconBtn>
                  <IconBtn label={`Descendre ${item.label}`} disabled={index === visible.length - 1} onClick={() => move(id, 1)}><ArrowDown className="h-3.5 w-3.5" aria-hidden /></IconBtn>
                  <IconBtn label={`Masquer ${item.label}`} onClick={() => toggle(id)}><EyeOff className="h-3.5 w-3.5" aria-hidden /></IconBtn>
                </div>
              </header>
              {item.node}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-soft transition-colors duration-150 hover:text-ink disabled:opacity-40 motion-reduce:transition-none">
      {children}
    </button>
  )
}

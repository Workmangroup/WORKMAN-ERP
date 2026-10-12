import Link from 'next/link'
import { Folder, FolderOpen, Layers, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GedFolder } from '../types'

/** Arborescence des dossiers d'un client (dossiers système + sous-dossiers) avec compteurs. */
export function FolderTree({
  clientId,
  folders,
  counts,
  trash,
  activeFolder,
  view,
}: {
  clientId: string
  folders: GedFolder[]
  counts: Map<string, number>
  trash: number
  activeFolder?: string
  view: 'all' | 'folder' | 'trash'
}) {
  const children = (parent: string | null) => folders.filter((f) => f.parent_id === parent).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'fr'))
  const total = [...counts.values()].reduce((a, b) => a + b, 0)

  // total d'un dossier = ses documents + ceux de ses sous-dossiers
  const sum = (id: string): number => (counts.get(id) ?? 0) + children(id).reduce((n, c) => n + sum(c.id), 0)

  const item = 'flex items-center gap-2 rounded-sm px-2.5 py-2 text-sm'
  const render = (parent: string | null, depth: number): React.ReactNode =>
    children(parent).map((f) => {
      const active = view === 'folder' && activeFolder === f.id
      return (
        <li key={f.id}>
          <Link
            href={`/ged/${clientId}?folder=${f.id}`}
            aria-current={active ? 'page' : undefined}
            style={{ paddingLeft: `${0.625 + depth * 0.9}rem` }}
            className={cn(item, 'hover:bg-canvas', active ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink')}
          >
            {active ? <FolderOpen className="h-4 w-4 shrink-0" aria-hidden /> : <Folder className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="text-xs text-ink-faint">{sum(f.id)}</span>
          </Link>
          {children(f.id).length > 0 && <ul>{render(f.id, depth + 1)}</ul>}
        </li>
      )
    })

  return (
    <nav aria-label="Dossiers" className="rounded-md border border-line bg-white p-2 shadow-card">
      <ul className="space-y-0.5">
        <li>
          <Link href={`/ged/${clientId}`} aria-current={view === 'all' ? 'page' : undefined}
            className={cn(item, 'hover:bg-canvas', view === 'all' ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink')}>
            <Layers className="h-4 w-4 shrink-0" aria-hidden /> <span className="flex-1">Tous les documents</span>
            <span className="text-xs text-ink-faint">{total}</span>
          </Link>
        </li>
        {render(null, 0)}
        <li className="mt-1 border-t border-line pt-1">
          <Link href={`/ged/${clientId}?view=trash`} aria-current={view === 'trash' ? 'page' : undefined}
            className={cn(item, 'hover:bg-canvas', view === 'trash' ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-soft')}>
            <Trash2 className="h-4 w-4 shrink-0" aria-hidden /> <span className="flex-1">Corbeille</span>
            <span className="text-xs text-ink-faint">{trash}</span>
          </Link>
        </li>
      </ul>
    </nav>
  )
}

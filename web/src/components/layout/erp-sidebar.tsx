'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Award, BadgeCheck, Boxes, Briefcase, ChevronDown, Crown, FileText, Factory, FolderOpen, KeyRound, Landmark, Layers,
  LayoutDashboard, Palette, Scissors, ScrollText, Settings, Shirt, ShoppingCart, Sparkles, Star, Truck, UserPlus, Users,
  UsersRound, Workflow,
} from 'lucide-react'
import { useAuth } from '@/features/auth'
import { cn } from '@/lib/utils'
import { isActivePath, visibleTree, type NavIcon, type NavLeaf, type VisibleNode } from '@/lib/navigation/tree'

const ICONS: Record<NavIcon, React.ElementType> = {
  dashboard: LayoutDashboard, briefcase: Briefcase, 'user-plus': UserPlus, 'users-round': UsersRound, folder: FolderOpen,
  'file-text': FileText, award: Award, scissors: Scissors, shirt: Shirt, layers: Layers, palette: Palette,
  'shopping-cart': ShoppingCart, boxes: Boxes, workflow: Workflow, factory: Factory, 'badge-check': BadgeCheck, truck: Truck,
  landmark: Landmark, sparkles: Sparkles, crown: Crown, settings: Settings, users: Users, 'key-round': KeyRound, 'scroll-text': ScrollText,
}

const FAV_KEY = 'mb-nav-favorites'
const OPEN_KEY = 'mb-nav-open'

/** Lecture/écriture localStorage protégées : navigation privée ou stockage bloqué ne doivent jamais casser le menu. */
function readJson<T>(key: string, fallback: T): T {
  try { const raw = window.localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback } catch { return fallback }
}
function writeJson(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* stockage indisponible : préférence non conservée */ }
}

/** Barre latérale : menu compact, sous-menus repliables, favoris par utilisateur, animations discrètes. */
export function ErpSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const { permissions } = useAuth()
  const tree = useMemo(() => visibleTree(permissions), [permissions])
  const leaves = useMemo(() => tree.flatMap((n) => n.children.map((c) => ({ ...c, group: n.label }))), [tree])

  const [favorites, setFavorites] = useState<string[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setFavorites(readJson<string[]>(FAV_KEY, []))
    setOpen(readJson<Record<string, boolean>>(OPEN_KEY, {}))
    setLoaded(true)
  }, [])

  // Le groupe de la page courante s'ouvre automatiquement.
  useEffect(() => {
    const active = tree.find((n) => n.children.some((c) => isActivePath(pathname, c.href)))
    if (active) setOpen((o) => (o[active.id] ? o : { ...o, [active.id]: true }))
  }, [pathname, tree])

  useEffect(() => { if (loaded) writeJson(OPEN_KEY, open) }, [open, loaded])
  useEffect(() => { if (loaded) writeJson(FAV_KEY, favorites) }, [favorites, loaded])

  const toggleFav = (id: string) => setFavorites((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))
  const favLeaves = favorites.map((id) => leaves.find((l) => l.id === id)).filter((x): x is (NavLeaf & { group: string }) => Boolean(x))

  return (
    <nav aria-label="Navigation principale" className="py-2 text-[13px]">
      {favLeaves.length > 0 && (
        <section aria-label="Favoris" className="mb-1">
          <p className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Favoris</p>
          <ul>
            {favLeaves.map((l) => (
              <LeafRow key={`fav-${l.id}`} leaf={l} pathname={pathname} starred onToggleStar={() => toggleFav(l.id)} onNavigate={onNavigate} />
            ))}
          </ul>
        </section>
      )}

      {tree.map((node) => (
        <NodeView
          key={node.id}
          node={node}
          pathname={pathname}
          expanded={node.children.length === 0 ? false : Boolean(open[node.id])}
          onToggle={() => setOpen((o) => ({ ...o, [node.id]: !o[node.id] }))}
          favorites={favorites}
          onToggleStar={toggleFav}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  )
}

function NodeView({ node, pathname, expanded, onToggle, favorites, onToggleStar, onNavigate }: {
  node: VisibleNode; pathname: string; expanded: boolean; onToggle: () => void
  favorites: string[]; onToggleStar: (id: string) => void; onNavigate?: () => void
}) {
  const Icon = ICONS[node.icon]
  if (node.children.length === 0) {
    const active = node.href ? isActivePath(pathname, node.href) : false
    return (
      <ul className="px-2">
        <li>
          <Link
            href={node.href ?? '#'}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors duration-150 motion-reduce:transition-none',
              active ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink hover:bg-canvas')}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden /> {node.label}
          </Link>
        </li>
      </ul>
    )
  }
  const hasActive = node.children.some((c) => isActivePath(pathname, c.href))
  return (
    <div className="px-2 pt-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn('flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-canvas motion-reduce:transition-none',
          hasActive ? 'font-semibold text-brand-700' : 'text-ink')}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1">{node.label}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-ink-faint transition-transform duration-200 motion-reduce:transition-none', expanded ? 'rotate-0' : '-rotate-90')} aria-hidden />
      </button>
      {/* Sous-menu : hauteur animée sans JavaScript de mesure (grid-rows 0fr → 1fr). */}
      <div className={cn('grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none', expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <ul className="overflow-hidden pl-3">
          {node.children.map((leaf) => (
            <LeafRow key={leaf.id} leaf={leaf} pathname={pathname} starred={favorites.includes(leaf.id)} onToggleStar={() => onToggleStar(leaf.id)} onNavigate={onNavigate} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function LeafRow({ leaf, pathname, starred, onToggleStar, onNavigate }: {
  leaf: NavLeaf; pathname: string; starred: boolean; onToggleStar: () => void; onNavigate?: () => void
}) {
  const active = isActivePath(pathname, leaf.href)
  if (!leaf.ready) {
    return (
      <li className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-ink-faint" title="Page prévue, bientôt disponible">
        <span className="flex-1 truncate">{leaf.label}</span>
        <span className="rounded-sm bg-canvas px-1.5 text-[10px] uppercase tracking-wide">bientôt</span>
      </li>
    )
  }
  return (
    <li className="group flex items-center rounded-md transition-colors duration-150 hover:bg-canvas motion-reduce:transition-none">
      <Link
        href={leaf.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-1.5', active ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink')}
      >
        <span className="truncate">{leaf.label}</span>
      </Link>
      <button
        type="button"
        onClick={onToggleStar}
        aria-pressed={starred}
        aria-label={starred ? `Retirer « ${leaf.label} » des favoris` : `Ajouter « ${leaf.label} » aux favoris`}
        className={cn('mr-1 rounded p-1 transition-opacity duration-150 focus-visible:opacity-100 motion-reduce:transition-none',
          starred ? 'opacity-100 text-warn-text' : 'opacity-0 text-ink-faint group-hover:opacity-100')}
      >
        <Star className={cn('h-3.5 w-3.5', starred && 'fill-current')} aria-hidden />
      </button>
    </li>
  )
}

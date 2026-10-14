/**
 * Arborescence de la barre latérale. Donnée pure (sans React) : testable et partagée par le menu et la recherche rapide.
 * Les codes de permission sont ceux de `lib/rbac/permissions.ts` (vérifiés par tests/unit/navigation.test.mjs).
 * `ready: false` = page prévue, pas encore livrée (affichée « bientôt », non cliquable).
 */

export type NavIcon =
  | 'dashboard' | 'briefcase' | 'user-plus' | 'users-round' | 'folder' | 'file-text' | 'award' | 'scissors'
  | 'shirt' | 'layers' | 'palette' | 'shopping-cart' | 'boxes' | 'workflow' | 'factory' | 'badge-check'
  | 'truck' | 'landmark' | 'sparkles' | 'crown' | 'settings' | 'users' | 'key-round' | 'scroll-text'

export interface NavLeaf {
  id: string
  label: string
  href: string
  icon: NavIcon
  /** Au moins une permission (tableau) ou une seule ; absente = tout utilisateur connecté. */
  permission?: string | string[]
  ready: boolean
}

export interface NavNode {
  id: string
  label: string
  icon: NavIcon
  /** Groupe repliable (sous-menus) ou entrée directe (pas d'enfants). */
  children?: NavLeaf[]
  href?: string
  permission?: string | string[]
  ready?: boolean
}

export const NAV_TREE: NavNode[] = [
  { id: 'dashboard', label: 'Command Center', icon: 'dashboard', href: '/command-center', ready: true },
  {
    id: 'crm', label: 'CRM', icon: 'briefcase',
    children: [
      { id: 'prospects', label: 'Prospects', href: '/commercial/prospects', icon: 'user-plus', permission: 'prospects.read', ready: true },
      { id: 'clients', label: 'Clients', href: '/clients', icon: 'users-round', permission: 'clients.read', ready: true },
      { id: 'pipeline', label: 'Pipeline', href: '/commercial/pipeline', icon: 'workflow', permission: 'prospects.read', ready: true },
      { id: 'quotes', label: 'Devis', href: '/commercial/quotes', icon: 'file-text', permission: 'quotes.read', ready: true },
      { id: 'orders', label: 'Commandes', href: '/orders', icon: 'scroll-text', permission: 'orders.read', ready: true },
      { id: 'invoices', label: 'Factures', href: '/commercial/invoices', icon: 'landmark', permission: 'invoices.read', ready: true },
      { id: 'credit-notes', label: 'Avoirs', href: '/commercial/credit-notes', icon: 'award', permission: 'invoices.read', ready: true },
    ],
  },
  {
    id: 'ged', label: 'GED', icon: 'folder',
    children: [
      { id: 'documents', label: 'Documents', href: '/ged', icon: 'file-text', permission: 'documents.read', ready: true },
      { id: 'certificates', label: 'Certificats', href: '/ged/certificats', icon: 'award', permission: 'documents.read', ready: false },
      { id: 'patterns', label: 'Patronages', href: '/ged/patronages', icon: 'scissors', permission: 'documents.read', ready: false },
    ],
  },
  {
    id: 'products', label: 'Produits', icon: 'shirt',
    children: [
      { id: 'pdm', label: 'Product Master', href: '/products', icon: 'layers', permission: 'products.read', ready: true },
      { id: 'articles', label: 'Articles client', href: '/articles', icon: 'shirt', permission: 'articles.read', ready: true },
      { id: 'variants', label: 'Variantes', href: '/variants', icon: 'palette', permission: 'variants.read', ready: true },
    ],
  },
  { id: 'purchases', label: 'Achats', icon: 'shopping-cart', href: '/purchases', permission: ['purchases.read', 'purchases.request'], ready: true },
  { id: 'stock', label: 'Stocks', icon: 'boxes', href: '/stock', permission: 'stock.read', ready: true },
  { id: 'mrp', label: 'MRP', icon: 'workflow', href: '/mrp', permission: 'mrp.read', ready: true },
  { id: 'production', label: 'Production', icon: 'factory', href: '/production', permission: 'production.read', ready: true },
  { id: 'quality', label: 'Qualité', icon: 'badge-check', href: '/quality', permission: 'quality.read', ready: true },
  { id: 'shipping', label: 'Expédition', icon: 'truck', href: '/shipments', permission: 'shipments.read', ready: true },
  { id: 'finance', label: 'Finance', icon: 'landmark', href: '/finance', permission: 'finance.read', ready: true },
  { id: 'ai', label: 'IA Assistant', icon: 'sparkles', href: '/copilot', permission: 'copilot.use', ready: true },
  { id: 'ceo', label: 'CEO Copilot', icon: 'crown', href: '/dashboard/dg', permission: 'dashboard.executive', ready: true },
  { id: 'strategy', label: 'Recommandations', icon: 'sparkles', href: '/strategie', permission: 'dashboard.executive', ready: true },
  {
    id: 'admin', label: 'Administration', icon: 'settings',
    children: [
      { id: 'users', label: 'Utilisateurs', href: '/admin/users', icon: 'users', permission: 'users.read', ready: true },
      { id: 'roles', label: 'Rôles et permissions', href: '/admin/roles', icon: 'key-round', permission: 'roles.read', ready: true },
      { id: 'permissions', label: 'Matrice des permissions', href: '/admin/permissions', icon: 'key-round', permission: 'roles.read', ready: true },
      { id: 'warehouse-access', label: 'Entrepôts et accès', href: '/admin/entrepots', icon: 'boxes', permission: 'warehouses.all', ready: true },
      { id: 'audit', label: 'Journal d’audit', href: '/admin/audit', icon: 'scroll-text', permission: 'audit.read', ready: true },
    ],
  },
]

const allowed = (permission: string | string[] | undefined, granted: readonly string[]): boolean => {
  if (!permission) return true
  return Array.isArray(permission) ? permission.some((p) => granted.includes(p)) : granted.includes(permission)
}

export interface VisibleNode {
  id: string
  label: string
  icon: NavIcon
  href?: string
  ready: boolean
  children: NavLeaf[]
}

/** Arborescence filtrée par les permissions : un groupe sans enfant visible disparaît. */
export function visibleTree(granted: readonly string[]): VisibleNode[] {
  const out: VisibleNode[] = []
  for (const node of NAV_TREE) {
    if (node.children) {
      const kids = node.children.filter((c) => allowed(c.permission, granted))
      if (kids.length) out.push({ id: node.id, label: node.label, icon: node.icon, ready: true, children: kids })
    } else if (allowed(node.permission, granted)) {
      out.push({ id: node.id, label: node.label, icon: node.icon, href: node.href, ready: node.ready ?? true, children: [] })
    }
  }
  return out
}

/** Pages navigables (liées à un écran réel), aplaties pour la recherche rapide et les favoris. */
export interface PageEntry { id: string; label: string; href: string; group: string; icon: NavIcon }

export function visiblePages(granted: readonly string[]): PageEntry[] {
  const pages: PageEntry[] = []
  for (const node of visibleTree(granted)) {
    if (node.children.length === 0) {
      if (node.ready && node.href) pages.push({ id: node.id, label: node.label, href: node.href, group: node.label, icon: node.icon })
      continue
    }
    for (const leaf of node.children) {
      if (leaf.ready) pages.push({ id: leaf.id, label: leaf.label, href: leaf.href, group: node.label, icon: leaf.icon })
    }
  }
  return pages
}

/** Recherche rapide : sans accents ni casse ; chaque mot doit apparaître dans le libellé ou le groupe. */
export function searchPages(pages: PageEntry[], query: string, limit = 8): PageEntry[] {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return pages
    .filter((p) => { const hay = norm(`${p.label} ${p.group}`); return words.every((w) => hay.includes(w)) })
    .slice(0, limit)
}

/** Vrai si le chemin courant est dans la section (page ou sous-page). */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/')
}

export interface Crumb { label: string; href?: string }

const HOME: Crumb = { label: 'Accueil', href: '/dashboard' }

/** Fil d'Ariane d'un chemin : Accueil › groupe › écran › détail. Le plus long libellé de l'arbre qui préfixe le chemin gagne. */
export function breadcrumbTrail(pathname: string): Crumb[] {
  const path = pathname.split('?')[0].replace(/\/+$/, '') || '/'
  let best: { label: string; href: string; group?: string } | null = null
  for (const node of NAV_TREE) {
    const entries = node.children
      ? node.children.map((c) => ({ label: c.label, href: c.href, group: node.label }))
      : node.href ? [{ label: node.label, href: node.href, group: undefined as string | undefined }] : []
    for (const e of entries) {
      const matches = path === e.href || path.startsWith(`${e.href}/`)
      if (matches && (!best || e.href.length > best.href.length)) best = e
    }
  }
  if (!best) return path === HOME.href ? [{ label: HOME.label }] : [HOME]
  const trail: Crumb[] = [HOME]
  if (best.group && best.group !== HOME.label) trail.push({ label: best.group })
  trail.push(path === best.href ? { label: best.label } : { label: best.label, href: best.href })
  if (path !== best.href) trail.push({ label: 'Fiche' })
  return trail
}

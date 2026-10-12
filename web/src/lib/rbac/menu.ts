import { P, type PermissionCode } from './permissions'

/**
 * Menu applicatif = source unique pour :
 *  - l'affichage de la navigation (filtrée par permission) ;
 *  - les règles d'accès des routes dans le middleware.
 * `ready: false` = module planifié (affiché grisé, route déjà protégée).
 * Fichier sans dépendance React : utilisable dans l'Edge runtime.
 */
export type MenuIcon =
  | 'dashboard' | 'shield' | 'users' | 'roles' | 'audit' | 'clients' | 'orders' | 'truck' | 'cart'
  | 'stock' | 'factory' | 'quality' | 'finance' | 'chart' | 'folder' | 'building' | 'shirt' | 'tree'

export interface MenuItem {
  id: string
  label: string
  href: string
  icon: MenuIcon
  /** Permission requise (au moins une si tableau). Absente = tout utilisateur connecté. */
  permission?: PermissionCode | PermissionCode[]
  ready: boolean
}

export interface MenuGroup {
  id: string
  label: string
  items: MenuItem[]
}

export const MENU: MenuGroup[] = [
  {
    id: 'general',
    label: 'Général',
    items: [
      { id: 'dashboard', label: 'Tableau de bord', href: '/dashboard', icon: 'dashboard', ready: true },
      { id: 'copilot', label: 'Copilote IA', href: '/copilot', icon: 'dashboard', permission: P.COPILOT_USE, ready: true },
      { id: 'account', label: 'Compte et sécurité', href: '/account/security', icon: 'shield', ready: true },
    ],
  },
  {
    id: 'commercial',
    label: 'Commercial',
    items: [
      { id: 'commercial', label: 'Commercial', href: '/commercial', icon: 'chart', permission: [P.PROSPECTS_READ, P.QUOTES_READ, P.INVOICES_READ], ready: true },
      { id: 'clients', label: 'Clients', href: '/clients', icon: 'clients', permission: P.CLIENTS_READ, ready: true },
      { id: 'development', label: 'Développement produit', href: '/development', icon: 'factory', permission: P.DEVELOPMENT_READ, ready: true },
      { id: 'warehouses', label: 'Entrepôts et accès', href: '/warehouses', icon: 'building', permission: P.STOCK_READ, ready: true },
      { id: 'subcontracting', label: 'Sous-traitance', href: '/subcontracting', icon: 'factory', permission: P.SUBCONTRACT_READ, ready: true },
      { id: 'variants', label: 'Variantes (taille / couleur)', href: '/variants', icon: 'shirt', permission: P.VARIANTS_READ, ready: true },
      { id: 'products', label: 'Produits (PDM)', href: '/products', icon: 'tree', permission: P.PRODUCTS_READ, ready: true },
      { id: 'articles', label: 'Articles', href: '/articles', icon: 'shirt', permission: P.ARTICLES_READ, ready: true },
      { id: 'orders', label: 'Commandes', href: '/orders', icon: 'orders', permission: P.ORDERS_READ, ready: true },
      { id: 'ged', label: 'GED — Documents', href: '/ged', icon: 'folder', permission: P.DOCUMENTS_READ, ready: true },
      { id: 'shipments', label: 'Expéditions', href: '/shipments', icon: 'truck', permission: P.SHIPMENTS_READ, ready: true },
    ],
  },
  {
    id: 'operations',
    label: 'Opérations',
    items: [
      { id: 'bom', label: 'Nomenclatures (BOM)', href: '/bom', icon: 'tree', permission: P.BOM_READ, ready: true },
      { id: 'bom-materials', label: 'Composants', href: '/bom/materials', icon: 'stock', permission: P.BOM_READ, ready: true },
      { id: 'suppliers', label: 'Fournisseurs', href: '/suppliers', icon: 'building', permission: P.SUPPLIERS_READ, ready: true },
      { id: 'purchases', label: 'Achats', href: '/purchases', icon: 'cart', permission: [P.PURCHASES_READ, P.PURCHASES_REQUEST], ready: true },
      { id: 'mrp', label: 'MRP — Approvisionnement', href: '/mrp', icon: 'chart', permission: P.MRP_READ, ready: true },
      { id: 'stock', label: 'Stock', href: '/stock', icon: 'stock', permission: P.STOCK_READ, ready: true },
      { id: 'production', label: 'Production', href: '/production', icon: 'factory', permission: P.PRODUCTION_READ, ready: true },
      { id: 'quality', label: 'Qualité', href: '/quality', icon: 'quality', permission: P.QUALITY_READ, ready: true },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    items: [
      { id: 'finance', label: 'Finance', href: '/finance', icon: 'finance', permission: P.FINANCE_READ, ready: true },
      { id: 'costs', label: 'Coûts et marges', href: '/costs', icon: 'chart', permission: P.COSTS_READ, ready: false },
      { id: 'reports', label: 'Rapports', href: '/reports', icon: 'chart', permission: P.REPORTS_READ, ready: false },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      { id: 'users', label: 'Utilisateurs', href: '/admin/users', icon: 'users', permission: P.USERS_READ, ready: true },
      { id: 'roles', label: 'Rôles et permissions', href: '/admin/roles', icon: 'roles', permission: P.ROLES_READ, ready: true },
      { id: 'audit', label: 'Journal d’audit', href: '/admin/audit', icon: 'audit', permission: P.AUDIT_READ, ready: true },
    ],
  },
]

const asList = (p: MenuItem['permission']): PermissionCode[] => (p === undefined ? [] : Array.isArray(p) ? p : [p])

/** Droit d'accès : aucune permission requise, ou au moins une détenue. */
export function isAllowed(permission: MenuItem['permission'], held: readonly string[]) {
  const required = asList(permission)
  return required.length === 0 || required.some((p) => held.includes(p))
}

/** Menu filtré selon les permissions de l'utilisateur (groupes vides retirés). */
export function visibleMenu(held: readonly string[]): MenuGroup[] {
  return MENU.map((g) => ({ ...g, items: g.items.filter((i) => isAllowed(i.permission, held)) })).filter((g) => g.items.length > 0)
}

export interface RouteRule {
  prefix: string
  permission: PermissionCode[]
}

/** Règles de routes dérivées du menu (+ sous-routes explicites). Plus long préfixe d'abord. */
export const ROUTE_RULES: RouteRule[] = [
  ...MENU.flatMap((g) => g.items)
    .filter((i) => i.permission !== undefined)
    .map((i) => ({ prefix: i.href, permission: asList(i.permission) })),
  { prefix: '/admin', permission: [P.USERS_READ, P.ROLES_READ, P.AUDIT_READ] },
].sort((a, b) => b.prefix.length - a.prefix.length)

export function ruleForPath(pathname: string): RouteRule | undefined {
  return ROUTE_RULES.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/'))
}

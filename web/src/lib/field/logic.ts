/** Logique terrain (pure) : tuiles d'accueil selon le profil, et reconnaissance du type d'un code scanné. */

export type FieldIcon = 'scan' | 'factory' | 'check' | 'package' | 'fabric' | 'boxes'

export interface FieldTile { id: string; label: string; hint: string; href: string; icon: FieldIcon }

/** Profils terrain, déduits des droits (pas de rôle codé en dur). Un utilisateur peut en avoir plusieurs. */
export function tilesFor(granted: readonly string[]): FieldTile[] {
  const g = (p: string) => granted.includes(p)
  const tiles: FieldTile[] = []
  if (g('shipments.write') || g('stock.write')) {
    tiles.push({ id: 'picking', label: 'Préparer et prélever', hint: 'Expéditions à préparer', href: '/atelier/picking', icon: 'package' })
  }
  if (g('purchases.read') && (g('stock.read') || g('mrp.read'))) {
    tiles.push({ id: 'fabric', label: 'Tissus à commander', hint: 'Besoins tissus et fils', href: '/atelier/tissus', icon: 'fabric' })
  }
  if (g('production.write') || g('production.plan')) {
    tiles.push({ id: 'of', label: 'Ordres du jour', hint: 'Lancer, saisir, terminer', href: '/atelier/of', icon: 'factory' })
  }
  if (g('quality.write') || g('quality.approve')) {
    tiles.push({ id: 'controls', label: 'Contrôles à faire', hint: 'Défauts et décisions', href: '/atelier/controles', icon: 'check' })
  }
  tiles.push({ id: 'scan', label: 'Scanner un code', hint: 'OF, article, bon de livraison', href: '/atelier/scan', icon: 'scan' })
  return tiles
}

export type CodeKind = 'of' | 'inspection' | 'shipment' | 'variant' | 'unknown'

/** Reconnaît le type d'un code à partir de son préfixe (OF-, QC-, SHP-/BL-, sinon SKU ou inconnu). */
export function classifyCode(raw: string): CodeKind {
  const code = raw.trim().toUpperCase()
  if (/^OF-\d{4}-\d{6}$/.test(code)) return 'of'
  if (/^QC-\d{4}-\d{6}$/.test(code)) return 'inspection'
  if (/^(SHP|BL)-\d{4}-\d{6}$/.test(code)) return 'shipment'
  if (/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(code)) return 'variant'
  return 'unknown'
}

/** Pas des boutons de saisie : valeurs rapides et bornes, pour éviter les erreurs au gant. */
export const STEP = { piece: 1, bigPiece: 10, hours: 0.5 } as const
export function clampStep(value: number, min = 0, max = 1_000_000): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

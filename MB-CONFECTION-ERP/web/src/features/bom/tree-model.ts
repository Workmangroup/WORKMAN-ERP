import { COSTING_CURRENCY, MATERIAL_CATEGORIES, formatMinutes, formatMoney, formatPct, formatQty, formatUnitPrice, label, unitLabel } from '@/lib/bom/options'
import type { TreeNode } from './types'

export type ItemKind = 'root' | 'group' | 'material' | 'bom' | 'operation' | 'overhead'

export interface TreeItem {
  id: string
  kind: ItemKind
  label: string
  /** Code (MAT-0001, BOM-0002…). */
  code?: string
  sub?: string
  /** Quantité par parent + unité. */
  qty?: number
  unit?: string
  /** Quantité nécessaire pour UNE pièce finie (pertes incluses, tous niveaux cumulés). */
  totalQty?: number
  waste?: number
  /** Contribution au coût de revient de la pièce finie (null = inconnu / non autorisé). */
  cost: number | null
  share: number | null
  missing?: boolean
  warning?: string
  href?: string
  details: [string, string][]
  children: TreeItem[]
}

const sum = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null)

/**
 * Transforme le résultat de la RPC `bom_tree` en arbre affichable :
 * produit → groupes (catégories de composants, sous-ensembles, main-d'œuvre) → lignes (sous-ensembles dépliés).
 * Les coûts sont ramenés à la pièce finie : un sous-ensemble utilisé ×2 pèse deux fois dans le total.
 */
export function buildItems(node: TreeNode, costs: boolean): TreeItem {
  const root = build(node, 1, 'r', costs, true)
  const total = root.cost ?? 0
  const walk = (it: TreeItem) => {
    it.share = it.cost !== null && total > 0 ? it.cost / total : null
    it.children.forEach(walk)
  }
  walk(root)
  return root
}

function build(node: TreeNode, mult: number, path: string, costs: boolean, isRoot: boolean): TreeItem {
  const groups: TreeItem[] = []
  const matLines = node.lines.filter((l) => l.type === 'material')
  for (const cat of MATERIAL_CATEGORIES) {
    const lines = matLines.filter((l) => l.type === 'material' && l.material.category === cat.value)
    if (!lines.length) continue
    const children: TreeItem[] = lines.map((l) => {
      if (l.type !== 'material') throw new Error('unreachable')
      const cost = costs && l.cost !== undefined && l.cost !== null ? l.cost * mult : null
      const missing = costs && (l.unit_cost === null || l.unit_cost === undefined)
      return {
        id: `${path}/${l.id}`, kind: 'material', label: l.material.name, code: l.material.code, sub: l.material.color ?? undefined,
        qty: l.qty, unit: l.unit, totalQty: l.total_qty, waste: l.waste_pct, cost, share: null, missing,
        warning: l.material.archived ? 'Composant archivé' : missing ? 'Prix manquant' : undefined,
        details: [
          ['Code', l.material.code], ['Catégorie', label(MATERIAL_CATEGORIES, l.material.category)], ['Couleur', l.material.color ?? '—'],
          ['Quantité', `${formatQty(l.qty)} ${unitLabel(l.unit)}`], ['Perte', formatPct(l.waste_pct)],
          ['Besoin par pièce finie', `${formatQty(l.total_qty)} ${unitLabel(l.unit)}`],
          ...(costs ? [['Prix unitaire', l.unit_cost === null || l.unit_cost === undefined ? 'Non renseigné' : `${formatUnitPrice(l.unit_cost)} / ${unitLabel(l.unit)}`] as [string, string], ['Coût', cost === null ? '—' : formatMoney(cost)] as [string, string]] : []),
          ...(l.note ? [['Note', l.note] as [string, string]] : []),
        ],
        children: [],
      }
    })
    groups.push({ id: `${path}/g:${cat.value}`, kind: 'group', label: cat.label, sub: `${children.length} composant(s)`, cost: sum(children.map((c) => c.cost)), share: null, details: [], children })
  }

  const subLines = node.lines.filter((l) => l.type === 'bom')
  if (subLines.length) {
    const children: TreeItem[] = subLines.map((l) => {
      if (l.type !== 'bom') throw new Error('unreachable')
      const inner = l.node ? build(l.node, mult * l.qty, `${path}/${l.id}`, costs, false) : null
      const cost = costs && l.cost !== undefined && l.cost !== null ? l.cost * mult : null
      return {
        id: `${path}/${l.id}`, kind: 'bom', label: l.child.name, code: l.child.code, sub: l.node ? `v${l.node.version.no}` : 'Aucune version validée',
        qty: l.qty, unit: 'pc', totalQty: l.total_qty, cost: inner?.cost ?? cost, share: null, href: `/bom/${l.child.id}`,
        warning: l.child.archived ? 'Sous-ensemble archivé' : !l.node ? 'Aucune version validée' : undefined,
        missing: Boolean(l.node && costs && l.node.totals && l.node.totals.missing.length > 0),
        details: [
          ['Code', l.child.code], ['Quantité par parent', formatQty(l.qty)], ['Quantité par pièce finie', formatQty(l.total_qty)],
          ...(l.node ? [['Version utilisée', `v${l.node.version.no} (validée)`] as [string, string]] : []),
          ...(costs ? [['Coût (matière + main-d’œuvre)', cost === null ? '—' : formatMoney(cost)] as [string, string]] : []),
          ...(l.note ? [['Note', l.note] as [string, string]] : []),
        ],
        children: inner ? inner.children : [],
      }
    })
    groups.push({ id: `${path}/g:sub`, kind: 'group', label: 'Sous-ensembles', sub: `${children.length}`, cost: sum(children.map((c) => c.cost)), share: null, details: [], children })
  }

  if (node.operations.length) {
    const rate = node.hourly_rate
    const children: TreeItem[] = node.operations.map((o) => {
      const cost = costs && o.cost !== undefined ? o.cost * mult : null
      return {
        id: `${path}/${o.id}`, kind: 'operation', label: o.name, qty: o.minutes, unit: 'min', totalQty: o.total_minutes, cost, share: null,
        details: [
          ['Opération', o.name], ['Durée', formatMinutes(o.minutes)], ['Durée par pièce finie', formatMinutes(o.total_minutes)],
          ...(costs && rate !== undefined ? [['Taux horaire', `${formatMoney(rate)} / h`] as [string, string], ['Coût', cost === null ? '—' : formatMoney(cost)] as [string, string]] : []),
        ],
        children: [],
      }
    })
    const minutes = node.operations.reduce((a, o) => a + o.total_minutes, 0)
    groups.push({ id: `${path}/g:ops`, kind: 'group', label: 'Main-d’œuvre', sub: formatMinutes(minutes), cost: sum(children.map((c) => c.cost)), share: null, details: [], children })
  }

  const children = [...groups]
  const t = node.totals
  if (isRoot && costs && t && t.overhead > 0) {
    children.push({
      id: `${path}/overhead`, kind: 'overhead', label: `Frais généraux (${formatPct(node.overhead_pct)})`, cost: t.overhead, share: null,
      details: [['Base', formatMoney(t.material + t.labor)], ['Taux', formatPct(node.overhead_pct)], ['Montant', formatMoney(t.overhead)]], children: [],
    })
  }
  return {
    id: path, kind: isRoot ? 'root' : 'bom', label: node.bom.name, code: node.bom.code, sub: `v${node.version.no}`,
    cost: isRoot && costs && t ? t.total : sum(groups.map((g) => g.cost)), share: null, missing: Boolean(costs && t && t.missing.length > 0),
    details: [['Code', node.bom.code], ['Version', `v${node.version.no}`], ...(costs && t ? [
      ['Matière', formatMoney(t.material)] as [string, string], ['Main-d’œuvre', formatMoney(t.labor)] as [string, string],
      ['Frais généraux', formatMoney(t.overhead)] as [string, string], [`Coût de revient (${COSTING_CURRENCY})`, formatMoney(t.total)] as [string, string]] : [])],
    children,
  }
}

/** Ventilation du coût par catégorie de composant / main-d'œuvre / frais généraux (tous niveaux cumulés). */
export function costBreakdown(root: TreeItem): { key: string; label: string; cost: number }[] {
  const acc = new Map<string, { label: string; cost: number }>()
  const add = (key: string, lbl: string, c: number | null) => { if (c) acc.set(key, { label: lbl, cost: (acc.get(key)?.cost ?? 0) + c }) }
  const walk = (it: TreeItem) => {
    if (it.kind === 'group' && it.id.includes('/g:') && !it.id.endsWith('/g:sub')) {
      const key = it.id.slice(it.id.lastIndexOf('/g:') + 3)
      add(key, it.label, it.children.reduce((a, c) => a + (c.cost ?? 0), 0))
      return
    }
    if (it.kind === 'overhead') add('overhead', 'Frais généraux', it.cost)
    it.children.forEach(walk)
  }
  walk(root)
  return [...acc.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.cost - a.cost)
}

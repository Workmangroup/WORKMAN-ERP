/** Calculs purs des matrices d'administration (droits et entrepôts). Sans React ni base : testables seuls. */

export interface PermRef { code: string; module: string; label: string }

/** Regroupe les permissions par module, dans l'ordre d'apparition, pour une matrice lisible. */
export function groupByModule(perms: PermRef[]): { module: string; perms: PermRef[] }[] {
  const out = new Map<string, PermRef[]>()
  for (const p of perms) out.set(p.module, [...(out.get(p.module) ?? []), p])
  return [...out.entries()].map(([module, list]) => ({ module, perms: list.sort((a, b) => a.code.localeCompare(b.code)) }))
}

/** Bascule une permission d'un rôle : renvoie la nouvelle liste triée, sans doublon. */
export function togglePermission(current: readonly string[], code: string, on: boolean): string[] {
  const set = new Set(current)
  if (on) set.add(code)
  else set.delete(code)
  return [...set].sort()
}

/** Différence entre deux ensembles de permissions : ce qui est ajouté et ce qui est retiré. */
export function permissionDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const b = new Set(before)
  const a = new Set(after)
  return { added: [...a].filter((x) => !b.has(x)).sort(), removed: [...b].filter((x) => !a.has(x)).sort() }
}

export type WarehouseRole = 'viewer' | 'operator' | 'manager'
export type AccessChoice = 'none' | WarehouseRole

/** Bilan d'accès d'un utilisateur : entrepôts accessibles et refusés (ce qu'on lit en un coup d'œil). */
export function accessSummary(
  warehouses: { id: string; name: string }[],
  grants: Record<string, WarehouseRole | undefined>,
): { allowed: { id: string; name: string; role: WarehouseRole }[]; denied: { id: string; name: string }[] } {
  const allowed: { id: string; name: string; role: WarehouseRole }[] = []
  const denied: { id: string; name: string }[] = []
  for (const w of warehouses) {
    const r = grants[w.id]
    if (r) allowed.push({ id: w.id, name: w.name, role: r })
    else denied.push({ id: w.id, name: w.name })
  }
  return { allowed, denied }
}

/** Choix de la cellule entrepôt → action à exécuter (affecter, changer de rôle, ou retirer). */
export function warehouseAction(current: AccessChoice, next: AccessChoice): 'none' | 'assign' | 'revoke' {
  if (current === next) return 'none'
  return next === 'none' ? 'revoke' : 'assign'
}

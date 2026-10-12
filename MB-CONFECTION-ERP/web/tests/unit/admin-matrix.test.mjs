// Tests unitaires des matrices d'administration : node tests/unit/admin-matrix.test.mjs
import { groupByModule, togglePermission, permissionDiff, accessSummary, warehouseAction } from '../../src/lib/admin/matrix.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

const perms = [
  { code: 'stock.write', module: 'stock', label: 'x' },
  { code: 'quality.read', module: 'quality', label: 'x' },
  { code: 'stock.adjust', module: 'stock', label: 'x' },
]
const groups = groupByModule(perms)
ok('groupement par module, modules dans l’ordre d’apparition', groups.map((g) => g.module).join() === 'stock,quality')
ok('permissions triées dans chaque module', groups[0].perms.map((p) => p.code).join() === 'stock.adjust,stock.write')

ok('activer une permission ajoute sans doublon', togglePermission(['a.read'], 'a.read', true).join() === 'a.read')
ok('désactiver retire la permission', togglePermission(['a.read', 'b.write'], 'a.read', false).join() === 'b.write')
ok('liste résultante triée', togglePermission(['z.read'], 'a.read', true).join() === 'a.read,z.read')

const diff = permissionDiff(['a.read', 'b.write'], ['b.write', 'c.read'])
ok('diff : ajouté et retiré', diff.added.join() === 'c.read' && diff.removed.join() === 'a.read')
ok('diff identique : rien', permissionDiff(['a'], ['a']).added.length === 0 && permissionDiff(['a'], ['a']).removed.length === 0)

const wh = [{ id: 'w1', name: 'Magasin tissus' }, { id: 'w2', name: 'Fournitures' }, { id: 'w3', name: 'Produits finis' }]
const s = accessSummary(wh, { w1: 'manager', w2: undefined })
ok('bilan : entrepôt accessible avec son rôle', s.allowed.length === 1 && s.allowed[0].role === 'manager')
ok('bilan : entrepôts non accordés listés comme refusés', s.denied.map((d) => d.name).join() === 'Fournitures,Produits finis')

ok('cellule : même choix, aucune action', warehouseAction('viewer', 'viewer') === 'none')
ok('cellule : choisir un rôle affecte', warehouseAction('none', 'operator') === 'assign')
ok('cellule : changer de rôle réaffecte', warehouseAction('viewer', 'manager') === 'assign')
ok('cellule : « aucun » retire l’accès', warehouseAction('manager', 'none') === 'revoke')

console.log(failed === 0 ? 'OK' : `${failed} échec(s)`)
process.exitCode = failed === 0 ? 0 : 1

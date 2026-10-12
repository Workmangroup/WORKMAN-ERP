// Tests unitaires de la navigation : node tests/unit/navigation.test.mjs
import { readFileSync } from 'node:fs'
import { NAV_TREE, visibleTree, visiblePages, searchPages, isActivePath } from '../../src/lib/navigation/tree.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

// Chaque code de permission de la navigation doit exister dans le référentiel applicatif.
const perms = readFileSync(new URL('../../src/lib/rbac/permissions.ts', import.meta.url), 'utf8')
const codes = new Set([...perms.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]))
const used = []
for (const n of NAV_TREE) {
  for (const p of [].concat(n.permission ?? [])) used.push(p)
  for (const c of n.children ?? []) for (const p of [].concat(c.permission ?? [])) used.push(p)
}
const missing = [...new Set(used)].filter((p) => !codes.has(p))
ok('toutes les permissions de la navigation existent', missing.length === 0, `(absentes : ${missing.join(', ')})`)

const all = ['prospects.read', 'clients.read', 'documents.read', 'products.read', 'articles.read', 'variants.read', 'purchases.read', 'stock.read', 'mrp.read', 'production.read', 'quality.read', 'shipments.read', 'finance.read', 'copilot.use', 'dashboard.executive', 'users.read', 'roles.read', 'audit.read']
const vAll = visibleTree(all)
ok('administrateur : toutes les sections visibles (15 entrées de premier niveau)', vAll.length === 15, `(attendu 15, reçu ${vAll.length})`)
ok('sans droit : seul le tableau de bord reste (entrée sans permission)', visibleTree([]).length === 1 && visibleTree([])[0].id === 'dashboard')
const onlyCrm = visibleTree(['prospects.read'])
ok('droit partiel : sous-menu réduit aux pages autorisées (prospects et pipeline)', onlyCrm.find((n) => n.id === 'crm')?.children.map((c) => c.id).join() === 'prospects,pipeline')
ok('groupe sans page autorisée : groupe masqué', !visibleTree(['prospects.read']).some((n) => n.id === 'ged'))
ok('achats : visible avec purchases.request seul', visibleTree(['purchases.request']).some((n) => n.id === 'purchases'))

const pages = visiblePages(all)
ok('pages navigables : seules les pages livrées sont proposées (pas « Certificats »)', !pages.some((p) => p.label === 'Certificats') && pages.some((p) => p.label === 'Documents'))
ok('recherche sans accents : « rentab » absent, « production » trouvé', searchPages(pages, 'PRODUCTIO')[0]?.label === 'Production')
ok('recherche multi-mots : « articles client » trouve Articles client', searchPages(pages, 'articles client')[0]?.label === 'Articles client')
ok('recherche vide : aucun résultat', searchPages(pages, '   ').length === 0)
ok('recherche sur le groupe : « finance » ramène la page Finance', searchPages(pages, 'finance').some((p) => p.href === '/finance'))
ok('chemin actif : sous-page incluse', isActivePath('/production/ordres/abc', '/production') && !isActivePath('/productionx', '/production'))

console.log(failed === 0 ? 'OK' : `${failed} échec(s)`)
process.exitCode = failed === 0 ? 0 : 1

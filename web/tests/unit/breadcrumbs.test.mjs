// Tests unitaires du fil d'Ariane : node tests/unit/breadcrumbs.test.mjs
import { breadcrumbTrail } from '../../src/lib/navigation/tree.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }
const labels = (p) => breadcrumbTrail(p).map((c) => c.label)

ok('accueil seul sur le tableau de bord', labels('/dashboard').join(' › ') === 'Accueil', labels('/dashboard').join(' › '))
ok('écran de liste : accueil › groupe › écran', breadcrumbTrail('/clients').length >= 2 && breadcrumbTrail('/clients').at(-1).label === 'Clients', JSON.stringify(breadcrumbTrail('/clients')))
ok('fiche détaillée : ajoute « Fiche » après l’écran', labels('/clients/0000-1111').at(-1) === 'Fiche' && labels('/clients/0000-1111').includes('Clients'), labels('/clients/0000-1111').join(' › '))
ok('dernier élément sans lien (page courante)', breadcrumbTrail('/clients').at(-1).href === undefined)
ok('chemin inconnu : accueil', labels('/inconnu/page').join(' › ') === 'Accueil')
ok('paramètres de requête ignorés', labels('/clients?page=2').at(-1) === 'Clients')
ok('barre finale ignorée', labels('/clients/').at(-1) === 'Clients')

if (failed) { console.log(`\n${failed} échec(s)`); process.exit(1) }
console.log('\nOK')

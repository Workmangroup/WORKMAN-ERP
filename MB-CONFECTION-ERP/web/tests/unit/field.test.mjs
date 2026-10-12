// Tests unitaires de la logique terrain : node tests/unit/field.test.mjs
import { tilesFor, classifyCode, clampStep } from '../../src/lib/field/logic.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

const ids = (g) => tilesFor(g).map((t) => t.id).join()
ok('magasinier : préparation et scan', ids(['shipments.write']) === 'picking,scan', ids(['shipments.write']))
ok('responsable tissus : tissus et scan', ids(['purchases.read', 'stock.read']) === 'fabric,scan', ids(['purchases.read', 'stock.read']))
ok('chef de production : ordres du jour', ids(['production.write']) === 'of,scan', ids(['production.write']))
ok('contrôleur qualité : contrôles', ids(['quality.write']) === 'controls,scan', ids(['quality.write']))
ok('sans droit métier : seul le scan reste', ids([]) === 'scan')
ok('profil cumulé : toutes les tuiles métier', ids(['shipments.write', 'purchases.read', 'stock.read', 'production.plan', 'quality.approve']) === 'picking,fabric,of,controls,scan')
ok('chaque tuile a une cible terrain', tilesFor(['quality.write']).every((t) => t.href.startsWith('/atelier/')))

ok('code OF reconnu', classifyCode('OF-2026-000012') === 'of')
ok('code contrôle reconnu (minuscules acceptées)', classifyCode('qc-2026-000003') === 'inspection')
ok('bon de livraison reconnu', classifyCode('BL-2026-000007') === 'shipment')
ok('SKU variante reconnu', classifyCode('PRD-0001-JAU-S') === 'variant')
ok('texte libre : inconnu', classifyCode('?') === 'unknown' && classifyCode('') === 'unknown')

ok('pas de stepper au-delà du maximum', clampStep(15, 0, 10) === 10)
ok('pas de stepper sous le minimum', clampStep(-3, 0) === 0)
ok('valeur non numérique : minimum', clampStep(Number.NaN, 2) === 2)

console.log(failed === 0 ? 'OK' : `${failed} échec(s)`)
process.exitCode = failed === 0 ? 0 : 1

// Tests unitaires du moteur du copilote (sans base) : node tests/unit/copilot-engine.test.mjs
import { detectIntent, normalize } from '../../src/features/copilot/engine/intents.ts'
import { linearTrend, addMonths } from '../../src/features/copilot/engine/forecast.ts'
import { answerToPrintHtml } from '../../src/features/copilot/engine/export.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

ok('normalisation : accents et casse', normalize('Rentabilité des CLIENTS ?') === 'rentabilite des clients')
const cases = [
  ['Quelle est la rentabilité des clients ?', 'profit_client'],
  ['Quelle est la rentabilité des produits ?', 'profit_product'],
  ['Quelle marge sur la veste HV ?', 'profit_product'],
  ['Que dois-je acheter ?', 'purchase'],
  ['Quels achats faut-il commander ?', 'purchase'],
  ['Que dois-je produire cette semaine ?', 'production_suggest'],
  ['Quelle est la prévision de chiffre d’affaires ?', 'forecast'],
  ['Quelles sont les alertes importantes ?', 'alerts'],
  ['Fais une analyse de la situation', 'analysis'],
  ['Où en est la trésorerie ?', 'finance'],
  ['Combien de créances en retard ?', 'finance'],
  ['Quel est mon chiffre d’affaires ce mois-ci ?', 'ca'],
  ['État du stock de fils ?', 'stock'],
  ['Quels besoins MRP ?', 'mrp'],
  ['Y a-t-il des défauts qualité ?', 'quality'],
  ['Où sont mes colis expédiés ?', 'shipping'],
  ['Quels ordres de fabrication sont en retard ?', 'late_orders'],
  ['Quels tissus commander ?', 'fabric_purchase'],
  ['Quels OF seront en retard ?', 'late_orders'],
  ['Quels clients sont les plus rentables ?', 'profit_client'],
  ['bonjour', 'help'],
  ['', 'help'],
]
for (const [q, want] of cases) {
  const got = detectIntent(q)
  ok(`intention « ${q} » → ${want}`, got === want, `(reçu ${got})`)
}

const flat = linearTrend([100, 100, 100, 100], 2)
ok('tendance plate : prévision constante', flat.next.every((v) => Math.abs(v - 100) < 1e-9) && flat.slope === 0)
const up = linearTrend([100, 110, 120, 130], 2)
ok('tendance haussière +10 par mois : 140 puis 150', Math.abs(up.next[0] - 140) < 1e-9 && Math.abs(up.next[1] - 150) < 1e-9 && Math.abs(up.r2 - 1) < 1e-9)
const down = linearTrend([30, 20, 10], 3)
ok('projection bornée à zéro', down.next.every((v) => v >= 0))
ok('série vide : prévision nulle', linearTrend([], 2).next.every((v) => v === 0))
ok('addMonths passe l’année', addMonths('2026-11', 3) === '2027-02')

const html = answerToPrintHtml({ title: 'OF <en retard>', text: ['Deux & trois'], recommendations: ['Replanifier OF-1'], sources: ['x'] }, 'Quels OF ?', '08/10/2026')
ok('export PDF : titre et texte échappés', html.includes('OF &lt;en retard&gt;') && html.includes('Deux &amp; trois'))
ok('export PDF : actions recommandées incluses', html.includes('Replanifier OF-1') && html.includes('Actions recommandées'))

console.log(failed === 0 ? 'OK' : `${failed} échec(s)`)
process.exitCode = failed === 0 ? 0 : 1

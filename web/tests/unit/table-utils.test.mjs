// Tests unitaires des tableaux : node tests/unit/table-utils.test.mjs
import { matchesSearch, matchesFilters, sortRows, pageWindow, paginate, toCsv, toSpreadsheetXml, toPrintHtml } from '../../src/lib/data/table-utils.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

const rows = [
  { n: 'OF-2026-000002', art: 'Veste HV', qty: 50, status: 'done', due: '2026-10-20' },
  { n: 'OF-2026-000010', art: 'Pantalon ripstop', qty: 120, status: 'launched', due: null },
  { n: 'OF-2026-000001', art: 'Polo brodé', qty: 8, status: 'planned', due: '2026-09-01' },
]

ok('recherche sans accents et multi-mots', matchesSearch(rows[1], 'PANTALON ripst', ['art']))
ok('recherche : un mot absent exclut la ligne', !matchesSearch(rows[0], 'veste polo', ['art']))
ok('recherche vide : tout passe', matchesSearch(rows[0], '  ', ['art']))
ok('recherche limitée aux colonnes recherchables', !matchesSearch(rows[0], 'done', ['art']))

ok('filtre : valeur dans l’ensemble', matchesFilters(rows[0], { status: ['done', 'launched'] }))
ok('filtre : valeur hors ensemble refusée', !matchesFilters(rows[2], { status: ['done'] }))
ok('filtre vide : pas de restriction', matchesFilters(rows[2], { status: [] }))

const byQty = sortRows(rows, { col: 'qty', dir: 'desc' }).map((r) => r.qty)
ok('tri numérique décroissant', byQty.join() === '120,50,8', byQty.join())
const byN = sortRows(rows, { col: 'n', dir: 'asc' }).map((r) => r.n)
ok('tri texte naturel (000001 < 000002 < 000010)', byN.join() === 'OF-2026-000001,OF-2026-000002,OF-2026-000010', byN.join())
const byDue = sortRows(rows, { col: 'due', dir: 'asc' }).map((r) => r.due)
ok('valeurs vides toujours en fin de tri', byDue[byDue.length - 1] === null)
ok('sans tri : ordre d’origine', sortRows(rows, null)[0].n === rows[0].n)

ok('pagination : fenêtre avec points de suspension', pageWindow(5, 20).join(' ') === '1 … 4 5 6 … 20', pageWindow(5, 20).join(' '))
ok('pagination : début de liste sans points inutiles', pageWindow(1, 20).join(' ') === '1 2 … 20', pageWindow(1, 20).join(' '))
ok('pagination : une seule page', pageWindow(1, 1).join() === '1')
const p = paginate(Array.from({ length: 23 }, (_, i) => i), 3, 10)
ok('tranche : dernière page partielle', p.rows.length === 3 && p.from === 21 && p.to === 23 && p.pages === 3)
ok('tranche : page hors limites ramenée à la dernière', paginate([1, 2], 9, 10).page === 1)
ok('tranche : aucune ligne', paginate([], 1, 10).from === 0)

ok('CSV : séparateur point-virgule et guillemets échappés', toCsv(['A', 'B'], [['x;y', 'say "hi"']]) === 'A;B\r\n"x;y";"say ""hi"""')
ok('CSV : nombres et vides', toCsv(['N'], [[12.5], [null]]) === 'N\r\n12.5\r\n')
const xml = toSpreadsheetXml('OF', ['Numéro', 'Quantité'], [['OF-1 & <2>', 120], [null, 8]])
ok('Excel XML : en-tête gras, nombres typés, texte échappé', xml.includes('ss:Type="Number">120<') && xml.includes('OF-1 &amp; &lt;2&gt;') && xml.includes('ss:Bold="1"'))
ok('Excel XML : nom de feuille limité à 31 caractères', toSpreadsheetXml('x'.repeat(50), ['a'], []).includes('Name="' + 'x'.repeat(31) + '"'))
const html = toPrintHtml('Ordres <test>', ['A'], [['<b>']])
ok('impression : titre et cellules échappés', html.includes('Ordres &lt;test&gt;') && html.includes('&lt;b&gt;') && html.includes('@page'))

console.log(failed === 0 ? 'OK' : `${failed} échec(s)`)
process.exitCode = failed === 0 ? 0 : 1

// Tests unitaires des imports : parsing CSV, clé d'idempotence, export des rejets. node tests/unit/imports-csv.test.mjs
import { parseCsv, importKey, rejectsToCsv } from '../../src/lib/imports/csv.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }
const throws = (fn) => { try { fn(); return null } catch (e) { return e.message } }

const semi = parseCsv('Code;Libellé;Responsable\nCC-1;Coupe;a@x.com\nCC-2;"Finition; lot";b@x.com\n')
ok('séparateur « ; » détecté, en-têtes en minuscules', semi.headers.join() === 'code,libellé,responsable')
ok('champ entre guillemets : le point-virgule reste dans la valeur', semi.rows[1].libellé === 'Finition; lot', JSON.stringify(semi.rows[1]))
const comma = parseCsv('code,label\r\nCC-9,"Ligne ""spéciale"""\r\n\r\n')
ok('séparateur « , » et guillemets doublés, lignes vides ignorées', comma.rows.length === 1 && comma.rows[0].label === 'Ligne "spéciale"', JSON.stringify(comma.rows))
ok('cellule absente : chaîne vide', parseCsv('a;b\n1\n').rows[0].b === '')
ok('en-tête vide refusé', throws(() => parseCsv('a;;c\n1;2;3')) === 'En-têtes vides ou en double.')
ok('en-tête en double refusé', throws(() => parseCsv('a;A\n1;2')) === 'En-têtes vides ou en double.')
ok('fichier sans ligne de données refusé', throws(() => parseCsv('a;b')) !== null)
ok('BOM UTF-8 ignoré', parseCsv('﻿code;label\nCC;Coupe').headers[0] === 'code')

const sha = 'ab'.repeat(32)
ok('clé d’idempotence déterministe : même type et même empreinte', importKey('sites', sha) === importKey('sites', sha))
ok('clé différente selon le type', importKey('sites', sha) !== importKey('calendars', sha))
ok('clé dans la plage acceptée par la base (8 à 120 caractères)', importKey('warehouse_locations', sha).length >= 8 && importKey('warehouse_locations', sha).length <= 120)

const csv = rejectsToCsv([
  { line_no: 2, raw: { code: 'CC-2', label: 'Ex; pédition' }, errors: [{ code: 'OWNER_NOT_FOUND', field: 'owner_email' }] },
  { line_no: 4, raw: { code: 'BAD CODE', label: 'X' }, errors: [{ code: 'CC_CODE_INVALID' }, { code: 'CC_LABEL_INVALID' }] },
])
const lines = csv.replace(/^﻿/, '').split('\r\n')
ok('export : en-tête ligne;motifs;colonnes données', lines[0] === 'ligne;motifs;code;label', lines[0])
ok('export : motif avec champ indiqué', lines[1].includes('OWNER_NOT_FOUND (owner_email)'), lines[1])
ok('export : valeur contenant « ; » entre guillemets', lines[1].includes('"Ex; pédition"'), lines[1])
ok('export : plusieurs motifs séparés par « | »', lines[2].includes('CC_CODE_INVALID | CC_LABEL_INVALID'), lines[2])
ok('export : numéro de ligne d’origine conservé', lines[1].startsWith('2;') && lines[2].startsWith('4;'))

console.log(failed === 0 ? 'OK' : `ÉCHECS : ${failed}`)
process.exit(failed === 0 ? 0 : 1)

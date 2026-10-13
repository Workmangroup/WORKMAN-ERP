import { scanFeedback } from '../../src/lib/field/scan-feedback.ts'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}`) } }

const refused = scanFeedback({ ok: false, code: 'SCAN_WRONG_LOT', message: 'Mauvais lot pour cette ligne.' })
ok('refus : ton danger, bip d’erreur, vibration longue, message conservé', refused.tone === 'danger' && refused.beep === 'error' && refused.vibrate.length === 3 && refused.label === 'Mauvais lot pour cette ligne.')
const dup = scanFeedback({ ok: true, duplicate: true, message: 'Lot déjà confirmé : scan ignoré.' })
ok('doublon : ton avertissement, bip ok, sans nouvel effet', dup.tone === 'warning' && dup.beep === 'ok')
const replay = scanFeedback({ ok: true, replayed: true })
ok('rejeu de la même clé : aucun signal sonore, libellé « déjà enregistré »', replay.beep === 'none' && replay.vibrate.length === 0 && /aucun doublon/.test(replay.label))
const okScan = scanFeedback({ ok: true, duplicate: false, message: 'Lot confirmé.' })
ok('scan accepté : ton succès, bip ok', okScan.tone === 'success' && okScan.beep === 'ok' && okScan.label === 'Lot confirmé.')

console.log(`\n${pass} PASS, ${fail} FAIL`)
if (fail) process.exit(1)

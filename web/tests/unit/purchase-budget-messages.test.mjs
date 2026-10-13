// Messages d'erreur des demandes d'achat et du budget (P032) : node tests/unit/purchase-budget-messages.test.mjs
import { purchaseErrorMessage } from '../../src/features/purchases/errors.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }
const msg = (code) => purchaseErrorMessage({ message: code })

ok('budget dépassé : message explicite', msg('BUDGET_EXCEEDED').startsWith('Budget dépassé'))
ok('centre sans budget : message explicite', msg('BUDGET_NOT_DEFINED').includes('Aucun budget'))
ok('engagé + réalisé : plancher du budget expliqué', msg('BUDGET_BELOW_COMMITTED').includes('engagé'))
ok('estimation manquante : message explicite', msg('PURCHASE_ESTIMATE_REQUIRED').startsWith('Estimation manquante'))
ok('motif de demande : message couvre la demande budgétée', msg('PURCHASE_REASON_REQUIRED').includes('demande budgétée'))
ok('décision directe refusée : oriente vers le workflow', msg('PURCHASE_USE_APPROVAL').includes('workflow'))
ok('motif de refus : 10 caractères minimum', msg('APPROVAL_REASON_REQUIRED').includes('10 caractères'))
ok('code inconnu : message générique', purchaseErrorMessage({ message: 'XYZ' }).startsWith('Une erreur'))

if (failed) { console.log(`${failed} échec(s)`); process.exit(1) }
console.log('purchase-budget-messages : tous les contrôles passent')

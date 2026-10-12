// Tests unitaires du Command Center (logique pure) : node tests/unit/command-center.test.mjs
import { visibleWidgets, mergeOrder, urgencyFromAge, urgencyFromDue, alertTone, agendaWindow, briefing, WIDGETS } from '../../src/lib/command-center/logic.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

// Visibilité par droits.
{
  const none = visibleWidgets([])
  ok('sans droit : seuls les widgets sans exigence (KPI, actions) restent', JSON.stringify(none) === JSON.stringify(['kpi', 'actions']), `(reçu ${none})`)
  const achat = visibleWidgets(['purchases.approve', 'purchases.read'])
  ok('achat : validations, commandes, stocks et agenda visibles', ['validations', 'orders', 'stocks', 'agenda'].every((w) => achat.includes(w)))
  ok('achat : OF et briefing masqués sans droit', !achat.includes('ofs') && !achat.includes('briefing'))
  const direction = visibleWidgets(['dashboard.executive', 'copilot.use', 'quality.read', 'purchases.approve', 'stock.read', 'production.read', 'purchases.read', 'quotes.read', 'finance.read', 'documents.read', 'orders.read'])
  ok('direction : les dix widgets sont visibles', direction.length === WIDGETS.length, `(reçu ${direction.length} sur ${WIDGETS.length})`)
}

// Ordre : mise en page enregistrée gardée, inconnus et non autorisés retirés, nouveaux ajoutés à la fin.
{
  const available = ['tasks', 'alerts', 'kpi']
  ok('ordre enregistré respecté', JSON.stringify(mergeOrder(['kpi', 'tasks', 'alerts'], available)) === JSON.stringify(['kpi', 'tasks', 'alerts']))
  ok('widget non autorisé retiré', JSON.stringify(mergeOrder(['ofs', 'kpi'], available)) === JSON.stringify(['kpi', 'tasks', 'alerts']))
  ok('nouveau widget ajouté en fin', JSON.stringify(mergeOrder(['alerts'], available)) === JSON.stringify(['alerts', 'tasks', 'kpi']))
  ok('doublon ignoré', JSON.stringify(mergeOrder(['kpi', 'kpi', 'tasks'], available)) === JSON.stringify(['kpi', 'tasks', 'alerts']))
  ok('pas de mise en page : ordre par défaut', JSON.stringify(mergeOrder(null, available)) === JSON.stringify(available))
}

// Urgence.
ok('validation de 7 jours : élevée', urgencyFromAge(7) === 'high')
ok('validation de 3 jours : moyenne', urgencyFromAge(3) === 'medium')
ok('validation de 1 jour : faible', urgencyFromAge(1) === 'low')
ok('échéance dépassée : élevée', urgencyFromDue(-1) === 'high')
ok('échéance dans 3 jours : moyenne', urgencyFromDue(3) === 'medium')
ok('échéance dans 10 jours : faible', urgencyFromDue(10) === 'low')

// Couleurs des alertes : rouge = critique, orange = élevé, bleu = information.
ok('critique : rouge (danger)', alertTone('critical') === 'danger')
ok('élevé : orange (warning)', alertTone('high') === 'warning')
ok('moyen : information (bleu)', alertTone('medium') === 'info')
ok('faible : information (bleu)', alertTone('low') === 'info')

// Fenêtre de l'agenda.
ok('vue jour : une seule date', JSON.stringify(agendaWindow('jour', '2026-11-08')) === JSON.stringify({ from: '2026-11-08', to: '2026-11-08' }))
ok('vue semaine : 7 jours', agendaWindow('semaine', '2026-11-08').to === '2026-11-14')
ok('vue mois : 30 jours', agendaWindow('mois', '2026-11-08').to === '2026-12-07')
ok('fin de mois franchie', agendaWindow('semaine', '2026-11-28').to === '2026-12-04')

// Briefing : chaque phrase reprend un chiffre des données.
{
  const quiet = briefing({ validations: 0, validationsOld: 0, criticalAlerts: 0, highAlerts: 0, topAlerts: [], lateOfs: 0, blockedOfs: 0, shortages: 0, quotesToChase: 0, eventsToday: 0 })
  ok('rien à traiter : message de calme', quiet.length === 1 && quiet[0].startsWith('Rien d’urgent'))
  const busy = briefing({ validations: 3, validationsOld: 1, criticalAlerts: 2, highAlerts: 1, topAlerts: ['Rupture : Fil'], lateOfs: 2, blockedOfs: 1, shortages: 4, quotesToChase: 2, eventsToday: 1 })
  ok('validations : nombre et part de plus de 7 jours', busy[0] === '3 validations sont en attente, dont 1 depuis plus de 7 jours.', `(reçu ${busy[0]})`)
  ok('alertes : critiques et élevées', busy.some((l) => l === '2 alerte(s) critique(s) et 1 alerte(s) élevée(s).'))
  ok('priorités citées', busy.some((l) => l.includes('Rupture : Fil')))
  ok('OF : retards et blocages', busy.some((l) => l === '2 OF en retard et 1 OF bloqué(s).'))
  ok('événement unique au singulier', busy.some((l) => l === '1 événement est prévu aujourd’hui.'))
  ok('une validation au singulier', briefing({ validations: 1, validationsOld: 0, criticalAlerts: 0, highAlerts: 0, topAlerts: [], lateOfs: 0, blockedOfs: 0, shortages: 0, quotesToChase: 0, eventsToday: 0 })[0] === '1 validation est en attente.')
}

console.log(failed ? `\n${failed} échec(s)` : '\nOK')
process.exit(failed ? 1 : 0)

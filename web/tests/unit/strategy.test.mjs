// Tests unitaires du moteur de recommandations stratégiques : node tests/unit/strategy.test.mjs
import { buildRecommendations, summarize, emptyFacts, dueDate, formatDate, priorityFromAmount, daysBetween } from '../../src/lib/strategy/engine.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

const ASOF = '2026-11-08'
const client = (over) => ({ id: 'c1', name: 'Client', ca12: 0, ca3Recent: 0, ca3Prior: 0, invoices12: 0, lastOrderDays: null, families: [], overdue: 0, ...over })
const find = (recs, prefix) => recs.filter((r) => r.id.startsWith(prefix))

// Cas de référence : baisse de 22 % sur 3 mois, CA annuel 386 364 € → risque d'environ 85 000 €.
{
  const f = { ...emptyFacts(ASOF), clients: [client({ id: 'lafont', name: 'LAFONT', ca12: 386364, ca3Recent: 78000, ca3Prior: 100000, invoices12: 12, lastOrderDays: 20, families: ['jacket'] })] }
  const recs = find(buildRecommendations(f), 'commercial:decline')
  ok('baisse de 22 % détectée', recs.length === 1)
  const r = recs[0]
  ok('impact estimé ≈ 85 000 €', r?.impact.amount === 85000, `(reçu ${r?.impact.amount})`)
  ok('impact ≥ 50 000 € classé critique', r?.priority === 'critical')
  ok('échéance critique : +7 jours', r?.dueDate === '2026-11-15', `(reçu ${r?.dueDate})`)
  ok('action avec date lisible', r?.action.includes('15/11/2026'), `(reçu ${r?.action})`)
  ok('responsable et indicateur renseignés', Boolean(r?.owner) && Boolean(r?.kpi) && Boolean(r?.cause))
}

// Baisse sous le seuil (10 %) : rien.
{
  const f = { ...emptyFacts(ASOF), clients: [client({ ca12: 200000, ca3Recent: 90000, ca3Prior: 100000 })] }
  ok('baisse de 10 % sous le seuil : aucune recommandation', find(buildRecommendations(f), 'commercial:decline').length === 0)
}

// Client trop petit pour être significatif : rien.
{
  const f = { ...emptyFacts(ASOF), clients: [client({ ca12: 900, ca3Recent: 100, ca3Prior: 500 })] }
  ok('petit client (CA 3 mois < 1 000 €) ignoré', find(buildRecommendations(f), 'commercial:decline').length === 0)
}

// Client dormant.
{
  const dormant = { ...emptyFacts(ASOF), clients: [client({ id: 'd1', ca12: 5000, lastOrderDays: 200 })] }
  const active = { ...emptyFacts(ASOF), clients: [client({ id: 'a1', ca12: 5000, lastOrderDays: 30 })] }
  const d = find(buildRecommendations(dormant), 'commercial:dormant')
  ok('client sans commande depuis 200 jours : dormant, priorité selon le CA (5 000 € : moyen)', d.length === 1 && d[0].priority === 'medium')
  ok('client récent : pas dormant', find(buildRecommendations(active), 'commercial:dormant').length === 0)
}

// Client à fort potentiel : parmi le quartile supérieur, en hausse, sans encours.
{
  const clients = [
    client({ id: 'p1', name: 'P1', ca12: 1000, ca3Recent: 100, ca3Prior: 100, invoices12: 1 }),
    client({ id: 'p2', name: 'P2', ca12: 2000, ca3Recent: 100, ca3Prior: 100, invoices12: 1 }),
    client({ id: 'p3', name: 'P3', ca12: 3000, ca3Recent: 100, ca3Prior: 100, invoices12: 1 }),
    client({ id: 'p4', name: 'P4', ca12: 100000, ca3Recent: 30000, ca3Prior: 20000, invoices12: 10 }),
  ]
  const recs = find(buildRecommendations({ ...emptyFacts(ASOF), clients }), 'commercial:potential')
  ok('client au sommet du portefeuille et en hausse : fort potentiel', recs.length === 1 && recs[0].id === 'commercial:potential:p4')
}

// Cross-selling : 3 clients sur 4 achètent des polos, le 4e n'achète que des vestes.
{
  const clients = [
    client({ id: 'x1', name: 'X1', ca12: 10000, families: ['polo', 'jacket'] }),
    client({ id: 'x2', name: 'X2', ca12: 12000, families: ['polo'] }),
    client({ id: 'x3', name: 'X3', ca12: 8000, families: ['polo', 'trousers'] }),
    client({ id: 'x4', name: 'X4', ca12: 6000, families: ['jacket'] }),
  ]
  const recs = find(buildRecommendations({ ...emptyFacts(ASOF), clients }), 'commercial:cross')
  ok('cross-selling : polos proposés à X4', recs.some((r) => r.id === 'commercial:cross:x4:polo'), `(reçu ${recs.map((r) => r.id).join(', ')})`)
  ok('client qui achète déjà une famille n’est pas proposé pour elle', !recs.some((r) => r.id === 'commercial:cross:x1:polo'))
}

// Prévision : baisse de 25 % puis hausse.
{
  const down = buildRecommendations({ ...emptyFacts(ASOF), forecast: { recentAvg: 100000, nextAvg: 75000 } })
  const r = down.find((x) => x.id === 'commercial:forecast:down')
  ok('prévision de baisse de 25 % : priorité élevée', r?.priority === 'high')
  ok('manque à gagner sur 3 mois : 75 000 €', r?.impact.amount === 75000, `(reçu ${r?.impact.amount})`)
  const up = buildRecommendations({ ...emptyFacts(ASOF), forecast: { recentAvg: 100000, nextAvg: 120000 } }).find((x) => x.id === 'commercial:forecast:up')
  ok('prévision de hausse : faible priorité', up?.priority === 'low')
  ok('variation de 5 % : aucune prévision signalée', buildRecommendations({ ...emptyFacts(ASOF), forecast: { recentAvg: 100000, nextAvg: 95000 } }).length === 0)
}

// Produits : marge faible et baisse de volume.
{
  const articles = [
    { id: 'a1', name: 'Veste HV', revenue12: 100000, marginPct: 10, qtyRecent: 100, qtyPrior: 100 },
    { id: 'a2', name: 'Parka', revenue12: 50000, marginPct: 30, qtyRecent: 40, qtyPrior: 100 },
    { id: 'a3', name: 'Polo', revenue12: 20000, marginPct: 25, qtyRecent: 200, qtyPrior: 100 },
  ]
  const recs = buildRecommendations({ ...emptyFacts(ASOF), articles })
  const margin = recs.find((r) => r.id === 'commercial:margin:a1')
  ok('marge de 10 % sur 100 000 € : marge manquante de 5 000 €', margin?.impact.amount === 5000 && margin?.priority === 'medium')
  ok('volume en baisse de 60 % : produit faible performance', recs.some((r) => r.id === 'commercial:weak:a2'))
  ok('volume en hausse : produit à forte croissance', recs.some((r) => r.id === 'commercial:growth:a3'))
}

// Finance, achats, production, qualité, GED, expédition.
{
  const facts = {
    ...emptyFacts(ASOF),
    clients: [client({ id: 'o1', name: 'Retard SA', overdue: 12000 })],
    supplierOverdue: [{ id: 's1', supplier: 'Tissus Nord', amount: 3000, daysLate: 20 }],
    shortages: [
      { id: 'm1', material: 'Fil 40/2', qty: 120, kind: 'mrp', severity: 'critical', dueDate: '2026-11-12' },
      { id: 'm2', material: 'Bouton', qty: 300, kind: 'safety', severity: 'warning', dueDate: null },
    ],
    latePurchaseOrders: [{ id: 'p1', ref: 'PO-0007', supplier: 'Tissus Nord', daysLate: 20 }],
    lateOrders: [{ id: 'of1', number: 'OF-0003', article: 'Parka', daysLate: 9 }],
    productionGaps: [{ id: 'g1', article: 'Polo', gap: 150 }],
    openNc: [{ id: 'n1', number: 'NC-0002', title: 'Couture décalée', severity: 'critical', dueDate: null }],
    expiringDocs: [{ id: 'd1', title: 'OEKO-TEX', client: 'Client A', validUntil: '2026-11-01', daysLeft: -7 }, { id: 'd2', title: 'ISO 9001', client: 'Client B', validUntil: '2026-12-01', daysLeft: 23 }],
    stuckShipments: [{ id: 'e1', number: 'EXP-0001', status: 'packed', daysSince: 20 }],
  }
  const recs = buildRecommendations(facts)
  const byId = (id) => recs.find((r) => r.id === id)
  ok('créance client de 12 000 € : élevée', byId('finance:overdue:o1')?.priority === 'high')
  ok('dette fournisseur de 3 000 € : moyenne', byId('finance:supplier:s1')?.priority === 'medium')
  ok('besoin MRP critique : rupture critique', byId('achats:shortage:mrp:m1')?.priority === 'critical')
  ok('seuil de sécurité : priorité moyenne', byId('achats:shortage:safety:m2')?.priority === 'medium')
  ok('commande fournisseur en retard de 20 jours : élevée', byId('achats:late-po:p1')?.priority === 'high')
  ok('OF en retard de 9 jours : élevé', byId('production:late:of1')?.priority === 'high')
  ok('demande non couverte de 150 pièces : élevée', byId('production:gap:g1')?.priority === 'high')
  ok('NC critique ouverte : critique', byId('qualite:nc:n1')?.priority === 'critical')
  ok('certificat expiré : élevé', byId('ged:expiry:d1')?.priority === 'high')
  ok('certificat valable 23 jours : moyen', byId('ged:expiry:d2')?.priority === 'medium')
  ok('expédition bloquée 20 jours : élevée', byId('expedition:stuck:e1')?.priority === 'high')
  ok('rien sans impact chiffré n’invente un montant', byId('production:late:of1')?.impact.amount === null)
}

// Tri : critique en premier, puis impact décroissant.
{
  const recs = buildRecommendations({ ...emptyFacts(ASOF), supplierOverdue: [{ id: 's1', supplier: 'A', amount: 3000, daysLate: 1 }], clients: [client({ id: 'z', name: 'Z', overdue: 60000 })] })
  ok('tri : le plus critique en premier', recs[0].priority === 'critical' && recs[recs.length - 1].priority === 'medium')
}

// Seuils de priorité.
ok('50 000 € : critique', priorityFromAmount(50000) === 'critical')
ok('49 999 € : élevé', priorityFromAmount(49999) === 'high')
ok('10 000 € : élevé', priorityFromAmount(10000) === 'high')
ok('2 000 € : moyen', priorityFromAmount(2000) === 'medium')
ok('1 999 € : faible', priorityFromAmount(1999) === 'low')

// Dates.
ok('échéance faible : +60 jours', dueDate('low', '2026-01-01') === '2026-03-02')
ok('format JJ/MM/AAAA', formatDate('2026-11-15') === '15/11/2026')
ok('jours entre deux dates', daysBetween('2026-01-01', '2026-01-31') === 30)
ok('jours négatifs pour une date future', daysBetween('2026-02-01', '2026-01-31') === -1)

// Synthèse.
{
  const recs = buildRecommendations({ ...emptyFacts(ASOF), clients: [client({ id: 'o', name: 'O', overdue: 60000 })] })
  const s = summarize(recs)
  ok('synthèse : total et priorités', s.total === 1 && s.byPriority.critical === 1 && s.byPriority.low === 0)
  ok('synthèse : impact chiffré cumulé', s.estimatedImpact === 60000)
  ok('synthèse : compte par domaine', s.byDomain.finance === 1)
}
ok('aucune donnée : aucune recommandation', buildRecommendations(emptyFacts(ASOF)).length === 0)

console.log(failed ? `\n${failed} échec(s)` : '\nOK')
process.exit(failed ? 1 : 0)

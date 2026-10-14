// Plan comptable, journaux et périodes : pièces manuelles brouillon → validé, contrepassation, clôture protégée, réouverture
// par visa distinct, comptes ajoutés/désactivés sans suppression ; ancien grand livre intact — P059 / migration 0084
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDb, makeHelpers, migrationsDir } from './_harness.mjs'

// Socle GL (0001 à 0031) puis, après capture de l'ancien grand livre, la migration P059 appliquée à chaud
const BASE = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 4)) <= 31).sort()
const MIGRATION = '0084_gl_manual_periods.sql'
const db = await createDb(BASE)
const { ok, as, rejects } = makeHelpers(db)
const q = async (sql, params) => (await db.query(sql, params)).rows
const rpc = (fn, ...args) => db.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then((r) => r.rows[0].r)
const L = (account, debit, credit, label = 'ligne') => ({ account, debit, credit, label })
const lines = (...l) => JSON.stringify(l)
const num = Number

const company = (await q(`select id from companies`))[0].id
const role = async (code) => (await q(`select id from roles where code=$1 and company_id=$2`, [code, company]))[0].id
const mkUser = async (email, roleCode) => {
  const id = (await q(`insert into auth.users(email) values ($1) returning id`, [email]))[0].id
  if (roleCode) await db.query(`insert into user_roles values ($1,$2)`, [id, await role(roleCode)])
  return id
}
const fin = await mkUser('fin@p059.com', 'finance')     // saisit, valide, clôture, demande la réouverture
const fin2 = await mkUser('fin2@p059.com', 'finance')   // vise la réouverture (distinct du demandeur)
const nobody = await mkUser('nobody@p059.com', null)    // aucun droit finance

/** Empreinte stable des écritures données (numéro, statut, date, libellé et lignes) — détecte toute modification. */
const fingerprint = async (ids) => (await q(`
  select md5(coalesce(string_agg(e.number || '|' || e.status || '|' || e.entry_date || '|' || e.label || '|' || coalesce(ls.s, ''), ';' order by e.number), '')) h,
         count(*)::int n
    from gl_entries e
    left join lateral (select string_agg(a.code || ':' || l.pos || ':' || l.debit || ':' || l.credit, ',' order by l.pos) s
                         from gl_entry_lines l join gl_accounts a on a.id = l.account_id where l.entry_id = e.id) ls on true
   where e.id = any($1::uuid[])`, [`{${ids.join(',')}}`]))[0]

// --- 1. Ancien grand livre : écritures automatiques créées AVANT la migration P059 --------------------------------------------
await db.query(`select private.gl_post($1,'VT','2026-03-10','Facture ancienne P059','invoice',$2,$3::jsonb)`,
  [company, randomUUID(), lines(L('411', 1190, 0, 'Client'), L('701', 0, 1000, 'Vente'), L('445', 0, 190, 'TVA'))])
await db.query(`select private.gl_post($1,'BQ','2026-03-12','Encaissement ancien P059','invoice_payment',$2,$3::jsonb)`,
  [company, randomUUID(), lines(L('521', 500, 0, 'Banque'), L('411', 0, 500, 'Client'))])
const oldIds = (await q(`select id from gl_entries where company_id=$1 order by number`, [company])).map((r) => r.id)
const fpBefore = await fingerprint(oldIds)
ok('avant P059 : deux écritures automatiques existantes', oldIds.length === 2 && fpBefore.n === 2)

// --- 2. Migration P059 appliquée sur une base qui contient déjà des écritures ------------------------------------------------
await db.exec(fs.readFileSync(path.join(migrationsDir, MIGRATION), 'utf8'))
const fpAfterMigration = await fingerprint(oldIds)
ok('migration 0084 : ancien grand livre intact (empreinte identique)', fpAfterMigration.h === fpBefore.h && fpAfterMigration.n === 2)
ok('droit finance.visa attribué à finance et admin seulement',
  (await q(`select string_agg(distinct r.code, ',' order by r.code) s from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where p.code='finance.visa'`))[0].s === 'admin,finance')

// --- 3. Pièces manuelles : brouillon, équilibre, validation -----------------------------------------------------------------
const unbalanced = await as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-05', 'Pièce déséquilibrée', lines(L('411', 100, 0), L('701', 0, 90))))
ok('brouillon : créé en statut draft, non comptabilisé',
  (await q(`select status from gl_entries where id=$1`, [unbalanced]))[0].status === 'draft')
await rejects('débit ≠ crédit : validation refusée', () => as(fin, () => rpc('gl_entry_validate', unbalanced)), 'GL_UNBALANCED')
ok('débit ≠ crédit : reste en brouillon', (await q(`select status from gl_entries where id=$1`, [unbalanced]))[0].status === 'draft')
await as(fin, () => rpc('gl_entry_discard', unbalanced))
ok('brouillon supprimé : aucune trace (pièce et lignes)',
  (await q(`select count(*)::int n from gl_entries where id=$1`, [unbalanced]))[0].n === 0 &&
  (await q(`select count(*)::int n from gl_entry_lines where entry_id=$1`, [unbalanced]))[0].n === 0)

await rejects('une seule ligne : refusée', () => as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-06', 'Une ligne seule', lines(L('411', 50, 0)))), 'GL_TOO_FEW_LINES')
await rejects('libellé absent : refusé', () => as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-06', ' ', lines(L('411', 5, 0), L('701', 0, 5)))), 'GL_LABEL_REQUIRED')
await rejects('journal inconnu : refusé', () => as(fin, () => rpc('gl_manual_entry_create', 'XX', '2026-04-06', 'Journal faux', lines(L('411', 5, 0), L('701', 0, 5)))), 'GL_JOURNAL_MISSING')
await rejects('compte inconnu : refusé', () => as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-06', 'Compte faux', lines(L('999999', 10, 0), L('701', 0, 10)))), 'GL_ACCOUNT_MISSING')
await rejects('ligne à zéro : refusée par la contrainte de ligne', () => as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-06', 'Ligne nulle', lines(L('411', 0, 0), L('701', 0, 5)))), 'check')

const bal = await as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-05', 'Régularisation avril', lines(L('411', 120, 0, 'Client'), L('701', 0, 100, 'Vente'), L('445', 0, 20, 'TVA'))))
ok('pièce équilibrée : brouillon avant validation', (await q(`select status from gl_entries where id=$1`, [bal]))[0].status === 'draft')
await as(fin, () => rpc('gl_entry_validate', bal))
const balRow = (await q(`select status, number from gl_entries where id=$1`, [bal]))[0]
ok('pièce équilibrée : validée (brouillon → validé)', balRow.status === 'posted')
ok('numéro de pièce au format OD-AAAA-NNNNNN', /^OD-2026-\d{6}$/.test(balRow.number))
const fpBal = await fingerprint([bal])

// --- 4. Validé = immuable : pas de suppression, pas de modification directe --------------------------------------------------
await rejects('pièce validée : suppression (brouillon) refusée', () => as(fin, () => rpc('gl_entry_discard', bal)), 'GL_IMMUTABLE')
await rejects('pièce validée : modification directe refusée', () => db.exec(`update gl_entries set label='Changé' where id='${bal}'`), 'GL_IMMUTABLE')
await rejects('pièce validée : ligne modifiée directement refusée', () => db.exec(`update gl_entry_lines set debit = 1 where entry_id='${bal}'`), 'GL_IMMUTABLE')
await rejects('écriture directe par l’application : refusée', () => as(fin, () => db.query(
  `insert into gl_entries(company_id, journal_id, period_id, number, entry_date, label, status)
   values ($1, (select id from gl_journals where company_id=$1 and code='OD'), (select id from gl_periods where company_id=$1 and month=4), 'OD-HACK-1', '2026-04-07', 'Direct', 'posted')`, [company])), 'permission denied')

// Référence unique par société
await rejects('référence unique : numéro dupliqué refusé', () => db.query(
  `insert into gl_entries(company_id, journal_id, period_id, number, entry_date, label, status)
   select company_id, journal_id, period_id, number, entry_date, 'Doublon', 'draft' from gl_entries where id='${bal}'`), 'duplicate key')
const refs = (await q(`select count(*)::int n, count(distinct number)::int d from gl_entries where company_id=$1`, [company]))[0]
ok('références : chaque pièce a un numéro unique', refs.n === refs.d && refs.n >= 3)

// Droits
await rejects('pièce manuelle sans droit finance : refusée', () => as(nobody, () => rpc('gl_manual_entry_create', 'OD', '2026-04-06', 'Sans droit', lines(L('411', 5, 0), L('701', 0, 5)))), 'RBAC_FORBIDDEN')
ok('lecture des pièces sans droit : aucune ligne visible (RLS)', (await as(nobody, () => q(`select count(*)::int n from gl_entries`)))[0].n === 0)

// Débit = crédit sur toutes les pièces validées
const unbal = (await q(`select e.id from gl_entries e join gl_entry_lines l on l.entry_id = e.id where e.status='posted' group by e.id having sum(l.debit) <> sum(l.credit)`))
ok('débit = crédit : aucune pièce validée déséquilibrée', unbal.length === 0)

// --- 5. Période close protégée -----------------------------------------------------------------------------------------------
const draftApr = await as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-08', 'Brouillon en attente', lines(L('411', 40, 0), L('701', 0, 40))))
await rejects('clôture avec brouillon en attente : refusée', () => as(fin, () => rpc('gl_close_period', 2026, 4)), 'GL_DRAFT_ENTRIES')
await rejects('brouillon : contrepassation d’un brouillon refusée', () => as(fin, () => rpc('gl_entry_reverse', draftApr, '2026-04-30', 'Pas une pièce validée')), 'GL_BAD_STATUS')
await as(fin, () => rpc('gl_entry_discard', draftApr))

await as(fin, () => rpc('gl_close_period', 2026, 3))
ok('mars clôturé', (await q(`select status from gl_periods where company_id=$1 and year=2026 and month=3`, [company]))[0].status === 'closed')
await rejects('période close : pièce manuelle refusée', () => as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-03-20', 'Tardive mars', lines(L('411', 10, 0), L('701', 0, 10)))), 'GL_PERIOD_CLOSED')
await rejects('période close : insertion directe validée refusée', () => db.query(
  `insert into gl_entries(company_id, journal_id, period_id, number, entry_date, label, status)
   values ($1, (select id from gl_journals where company_id=$1 and code='OD'), (select id from gl_periods where company_id=$1 and year=2026 and month=3), 'OD-2026-999001', '2026-03-20', 'Insertion directe', 'posted')`, [company]), 'GL_PERIOD_CLOSED')
await rejects('période close : insertion directe de brouillon refusée', () => db.query(
  `insert into gl_entries(company_id, journal_id, period_id, number, entry_date, label, status)
   values ($1, (select id from gl_journals where company_id=$1 and code='OD'), (select id from gl_periods where company_id=$1 and year=2026 and month=3), 'OD-2026-999002', '2026-03-21', 'Brouillon direct', 'draft')`, [company]), 'GL_PERIOD_CLOSED')
await rejects('période close : moteur automatique refusé', () => db.query(`select private.gl_post($1,'VT','2026-03-25','Auto tardive','invoice',$2,$3::jsonb)`,
  [company, randomUUID(), lines(L('411', 10, 0), L('701', 0, 10))]), 'GL_PERIOD_CLOSED')
ok('période close : ancien grand livre de mars intact', (await fingerprint(oldIds)).h === fpBefore.h)

// --- 6. Contrepassation : nouvelle pièce, originale intacte, une seule fois ----------------------------------------------------
await rejects('contrepassation : motif trop court refusé', () => as(fin, () => rpc('gl_entry_reverse', bal, '2026-04-30', 'x')), 'GL_REASON_REQUIRED')
const rev = await as(fin, () => rpc('gl_entry_reverse', bal, '2026-04-30', 'Erreur de saisie'))
const revLines = await q(`select a.code, l.debit, l.credit from gl_entry_lines l join gl_accounts a on a.id = l.account_id where l.entry_id=$1 order by a.code`, [rev])
ok('contrepassation : nouvelle pièce validée et équilibrée',
  (await q(`select status from gl_entries where id=$1`, [rev]))[0].status === 'posted' &&
  num(revLines.reduce((s, x) => s + num(x.debit), 0)) === num(revLines.reduce((s, x) => s + num(x.credit), 0)))
ok('contrepassation : sens inversé (701 débit 100, 411 crédit 120)',
  revLines.find((x) => x.code === '701') && num(revLines.find((x) => x.code === '701').debit) === 100 &&
  revLines.find((x) => x.code === '411') && num(revLines.find((x) => x.code === '411').credit) === 120)
ok('contrepassation : pièce d’origine inchangée (empreinte identique)', (await fingerprint([bal])).h === fpBal.h)
await rejects('contrepassation : deuxième contrepassation refusée', () => as(fin, () => rpc('gl_entry_reverse', bal, '2026-04-30', 'Deuxième tentative')), 'GL_ALREADY_REVERSED')
await rejects('contrepassation d’une contrepassation : refusée', () => as(fin, () => rpc('gl_entry_reverse', rev, '2026-04-30', 'Contrepasser la contrepassation')), 'GL_BAD_STATUS')

// --- 7. Réouverture : demande → visa distinct → exécution ---------------------------------------------------------------------
await rejects('réouverture : période ouverte refusée', () => as(fin, () => rpc('gl_period_reopen_request', 2026, 4, 'Avril encore ouvert')), 'GL_PERIOD_NOT_CLOSED')
await rejects('réouverture : motif trop court refusé', () => as(fin, () => rpc('gl_period_reopen_request', 2026, 3, 'court')), 'GL_REASON_REQUIRED')
const rq = await as(fin, () => rpc('gl_period_reopen_request', 2026, 3, 'Facture de mars oubliée à corriger'))
await rejects('réouverture : une seule demande ouverte par période', () => as(fin, () => rpc('gl_period_reopen_request', 2026, 3, 'Deuxième demande pour mars')), 'gl_period_reopenings_open_uq')
await rejects('visa : le demandeur ne peut pas viser sa propre demande', () => as(fin, () => rpc('gl_period_reopen_visa', rq)), 'GL_VISA_SELF')
await rejects('visa : sans droit finance.visa refusé', () => as(nobody, () => rpc('gl_period_reopen_visa', rq)), 'RBAC_FORBIDDEN')
await rejects('exécution sans visa refusée', () => as(fin, () => rpc('gl_period_reopen_execute', rq)), 'GL_REOPEN_NOT_VISAED')
await as(fin2, () => rpc('gl_period_reopen_visa', rq))
ok('visa par une autre personne : statut visé', (await q(`select status from gl_period_reopenings where id=$1`, [rq]))[0].status === 'visaed')
await rejects('visa déjà donné : refusé', () => as(fin2, () => rpc('gl_period_reopen_visa', rq)), 'GL_BAD_STATUS')
ok('visa seul : période toujours close', (await q(`select status from gl_periods where company_id=$1 and year=2026 and month=3`, [company]))[0].status === 'closed')
await rejects('visa seul : pièce dans mars toujours refusée', () => as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-03-20', 'Avant exécution', lines(L('411', 10, 0), L('701', 0, 10)))), 'GL_PERIOD_CLOSED')

await as(fin, () => rpc('gl_period_reopen_execute', rq))
ok('exécution après visa : mars rouvert', (await q(`select status from gl_periods where company_id=$1 and year=2026 and month=3`, [company]))[0].status === 'open')
await rejects('exécution deux fois refusée', () => as(fin, () => rpc('gl_period_reopen_execute', rq)), 'GL_BAD_STATUS')

const mar = await as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-03-20', 'Correction mars après réouverture', lines(L('411', 30, 0), L('701', 0, 30))))
await as(fin, () => rpc('gl_entry_validate', mar))
ok('mars rouvert : correction validée', (await q(`select status from gl_entries where id=$1`, [mar]))[0].status === 'posted')
await as(fin, () => rpc('gl_close_period', 2026, 3))
ok('mars re-clôturé après correction', (await q(`select status from gl_periods where company_id=$1 and year=2026 and month=3`, [company]))[0].status === 'closed')
ok('journal d’audit : demande, visa et exécution tracés',
  num((await q(`select count(*)::int n from audit_logs where action like 'gl.period_reopen%'`))[0].n) === 3)

// --- 8. Plan comptable : ajout et désactivation, jamais de suppression -------------------------------------------------------
await as(fin, () => rpc('gl_account_add', '4111', 'Compte test P059', 4, 'asset'))
await rejects('compte : code invalide refusé', () => as(fin, () => rpc('gl_account_add', 'AB', 'Mauvais', 4, 'asset')), 'GL_ACCOUNT_CODE_INVALID')
await rejects('compte : code déjà utilisé refusé', () => as(fin, () => rpc('gl_account_add', '411', 'Doublon', 4, 'asset')), 'duplicate key')
await rejects('désactivation : motif obligatoire', () => as(fin, () => rpc('gl_account_deactivate', '4111', 'x')), 'GL_REASON_REQUIRED')
await as(fin, () => rpc('gl_account_deactivate', '4111', 'Compte créé par erreur'))
ok('compte désactivé : conservé avec active = false',
  (await q(`select active from gl_accounts where company_id=$1 and code='4111'`, [company]))[0].active === false)
await rejects('compte désactivé : non utilisable dans une pièce', () => as(fin, () => rpc('gl_manual_entry_create', 'OD', '2026-04-09', 'Compte désactivé', lines(L('4111', 10, 0), L('701', 0, 10)))), 'GL_ACCOUNT_MISSING')
await rejects('compte : suppression refusée', () => as(fin, () => db.query(`delete from gl_accounts where code='4111'`)), 'permission denied')

// --- 9. Synthèse de période et ancien grand livre final ----------------------------------------------------------------------
const summary = await as(fin, () => rpc('gl_period_summary', 2026, 4))
ok('synthèse avril : équilibrée, aucun brouillon restant', summary.balanced === true && summary.draft_entries === 0)
ok('grand livre 411 : écritures automatiques toujours présentes',
  (await as(fin, () => q(`select count(*)::int n from gl_ledger('411', '2026-01-01', '2026-12-31')`)))[0].n >= 2)
ok('ancien grand livre intact à la fin des opérations (empreinte identique)', (await fingerprint(oldIds)).h === fpBefore.h)

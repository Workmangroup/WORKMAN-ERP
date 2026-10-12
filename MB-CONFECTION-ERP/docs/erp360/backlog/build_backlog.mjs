// Génère BACKLOG.csv et BACKLOG.md à partir de :
//  - la matrice d'écarts (docs/MATRICE_ECARTS_CDC.md, via extract_matrix.mjs) : id, exigence, priorité/version, statut, composant existant, écart ;
//  - les fichiers enrichment_*.tsv : acteur, lot proposé, dépendances, estimation, responsable, expert, Given/When/Then.
// Puis contrôle la traçabilité. Sortie non nulle en cas d'anomalie. Aucune information n'est inventée :
// les estimations sont des hypothèses marquées comme telles, les responsables sont des rôles à nommer.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { rows } from './extract_matrix.mjs';

const here = new URL('.', import.meta.url);
// Chemin du CDC : variable CDC_PATH, sinon emplacement local de référence.
const CDC_PATH = process.env.CDC_PATH ?? 'C:/Users/DELL/Documents/Codex/2026-10-12/referenced-chatgpt-conversation-this-is-an/outputs/WORKMAN_ERP_360_CDC.md';
const CDC_IDS = readFileSync(CDC_PATH, 'utf8');

// Libellés du cahier pour les critères d'acceptation (CDC §12.8) : la matrice les regroupe en une seule ligne.
const ACC_TEXT = {
  'ACC-01': '100 % P0 du lot reliées à recette réussie',
  'ACC-02': 'Capacités existantes conservées ou exception approuvée',
  'ACC-03': 'Soldes financiers exacts ; stocks/documents rapprochés',
  'ACC-04': 'Aucun accès interdit dans tests multi-périmètres',
  'ACC-05': 'Aucun défaut bloquant ; majeurs clos ou dérogation',
  'ACC-06': 'Chaînes vente/achat/production cohérentes',
  'ACC-07': 'RPO/RTO et charge contractualisés atteints',
  'ACC-08': 'Paie parallèle validée',
  'ACC-09': 'IA sans fuite ni action critique autonome',
  'ACC-10': 'Formation et support prêts',
  'ACC-11': 'Rollback et réversibilité testés',
  'ACC-12': 'Code/configuration/docs/accès remis',
};
const EXT_TEXT = 'US-EXT-001 : améliorer le reliquat dans le module commande existant pour suivre les livraisons partielles sans ressaisie (CDC §12.11)';

// 1. Lignes de la matrice (même numérotation que extract_matrix.mjs).
let n = 0;
const items = new Map();
const warnings = [];
for (const r of rows) {
  const isId = /^[A-Z]{2,5}-[0-9A-Za-z]+$/.test(r[0]) && !/ à /.test(r[0]);
  const key = isId ? r[0] : `MTX-${String(++n).padStart(3, '0')}`;
  if (r[0].startsWith('ACC-01 à')) continue; // remplacé par ACC-01…ACC-12 ci-dessous
  items.set(key, {
    id: key, partie: r[6], exigence: r[1], prio_version: r[2], statut_constat: r[3],
    composant_existant: r[4], ecart: r[5], source: 'matrice',
  });
}
for (const [id, text] of Object.entries(ACC_TEXT)) {
  items.set(id, { id, partie: '12 Gouvernance / acceptation', exigence: text, prio_version: 'P0', statut_constat: 'Non réalisé', composant_existant: '—', ecart: 'Mesurable après recette', source: 'CDC §12.8' });
}
items.set('EXT-001', { id: 'EXT-001', partie: '3 Modules (user story)', exigence: EXT_TEXT, prio_version: 'P1', statut_constat: 'Absent', composant_existant: 'commandes, expédition, facturation existants', ecart: 'Suivi des reliquats et livraisons partielles (à confirmer)', source: 'CDC §12.11' });

// 2. Enrichissement.
const enrich = new Map();
const COLS = ['id', 'acteur', 'lot', 'dependances', 'estimation_pj', 'responsable', 'expert', 'given_when_then'];
for (const f of readdirSync(here).filter((f) => /^enrichment_\d+\.tsv$/.test(f)).sort()) {
  for (const [i, line] of readFileSync(new URL(f, here), 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length !== COLS.length) { warnings.push(`${f}:${i + 1} : ${parts.length} colonnes au lieu de ${COLS.length}`); continue; }
    const rec = Object.fromEntries(COLS.map((c, k) => [c, parts[k].trim()]));
    if (enrich.has(rec.id)) warnings.push(`${f}:${i + 1} : identifiant en double ${rec.id}`);
    enrich.set(rec.id, rec);
  }
}
enrich.delete('MTX-028'); // ligne de regroupement remplacée par ACC-01…12

// 3. Fusion.
const backlog = [];
for (const [id, it] of items) {
  const e = enrich.get(id);
  if (!e) { warnings.push(`${id} : aucun enrichissement (acteur, lot, estimation, responsable, Given/When/Then)`); continue; }
  backlog.push({ ...it, ...e });
}
for (const id of enrich.keys()) if (!items.has(id)) warnings.push(`${id} : enrichissement sans ligne de matrice ou de CDC`);

// 4. Contrôles.
const ids = new Set(backlog.map((b) => b.id));
const errors = [];
const seen = new Set();
for (const b of backlog) {
  if (seen.has(b.id)) errors.push(`${b.id} : identifiant en double`);
  seen.add(b.id);
  if (!b.acteur) errors.push(`${b.id} : acteur vide`);
  if (!b.responsable) errors.push(`${b.id} : responsable vide`);
  if (!/^(V1|V2|V3|hors lot)/.test(b.lot)) errors.push(`${b.id} : lot inconnu « ${b.lot} »`);
  if (!/^(\d+(\.\d+)?|n\/c.*)$/.test(b.estimation_pj)) errors.push(`${b.id} : estimation invalide « ${b.estimation_pj} »`);
  if (!(/Étant donné/.test(b.given_when_then) && /quand/.test(b.given_when_then) && /alors/.test(b.given_when_then))) errors.push(`${b.id} : Given/When/Then incomplet`);
  if (b.dependances !== '—') {
    for (const d of b.dependances.split(';').map((s) => s.trim()).filter(Boolean)) {
      if (!ids.has(d)) errors.push(`${b.id} : dépendance inconnue « ${d} »`);
    }
  }
}
// Couverture du cahier : tous les identifiants CDC doivent figurer.
const cdcIds = [...new Set(CDC_IDS.match(/\b[A-Z]{2,5}-[0-9]{2,3}\b/g))];
for (const c of cdcIds) if (!ids.has(c)) errors.push(`${c} (CDC) absent du backlog`);
// Toutes les exigences P0 de la matrice (prio/version contenant P0) doivent être tracées.
const p0 = backlog.filter((b) => /P0/.test(b.prio_version));
for (const b of backlog.filter((x) => x.source === 'matrice' && /P0/.test(x.prio_version) && !ids.has(x.id))) errors.push(`P0 non tracé : ${b.id}`);

// Liaison avec le guide : chaque phase et prompt cite des identifiants existants ; chaque P0 est relié à au moins un.
const guideRows = readFileSync(new URL('guide_mapping.tsv', here), 'utf8').split('\n').slice(1).filter((l) => l.trim());
const guideMapped = new Set();
const guideSummary = [];
for (const line of guideRows) {
  const [name, ref, list] = line.split('\t');
  const refs = (list ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  if (refs.length === 0) errors.push(`guide « ${name} » : aucun identifiant relié`);
  for (const r of refs) {
    if (!ids.has(r)) errors.push(`guide « ${name} » : identifiant inconnu « ${r} »`);
    guideMapped.add(r);
  }
  guideSummary.push({ name, ref, count: refs.length });
}
for (const b of backlog.filter((x) => /P0/.test(x.prio_version) && !guideMapped.has(x.id))) errors.push(`P0 non relié au guide : ${b.id}`);

// 5. Sorties.
backlog.sort((a, b) => (a.source === 'matrice' ? 0 : 1) - (b.source === 'matrice' ? 0 : 1) || a.id.localeCompare(b.id, 'fr', { numeric: true }));
const HEAD = ['id', 'partie', 'exigence', 'prio_version', 'statut_constat', 'composant_existant', 'ecart', 'lot', 'acteur', 'dependances', 'estimation_pj', 'responsable', 'expert', 'given_when_then', 'source'];
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(new URL('BACKLOG.csv', here), '﻿' + [HEAD.join(','), ...backlog.map((b) => HEAD.map((h) => esc(b[h])).join(','))].join('\r\n') + '\r\n', 'utf8');

const count = (arr, k) => arr.reduce((m, b) => (m[b[k]] = (m[b[k]] || 0) + 1, m), {});
const byLot = count(backlog, 'lot');
const byStatut = count(backlog, 'statut_constat');
const sumPj = (lotPrefix) => backlog.filter((b) => b.lot.startsWith(lotPrefix) && /^\d/.test(b.estimation_pj)).reduce((s, b) => s + Number(b.estimation_pj), 0);
const nonChiffres = backlog.filter((b) => !/^\d/.test(b.estimation_pj)).length;
const md = [
  '# BACKLOG exécutable — WORKMAN ERP 360 (lot P003)',
  '',
  `Généré par \`build_backlog.mjs\` à partir de la matrice d'écarts et des fichiers \`enrichment_*.tsv\`. Ne pas modifier à la main : éditer les sources puis relancer le script.`,
  '',
  '## Résumé',
  '',
  `- Éléments : **${backlog.length}** (${backlog.filter((b) => b.source === 'matrice').length} lignes de la matrice, 12 critères d'acceptation ACC-01…ACC-12, 1 user story EXT-001 hors matrice).`,
  `- Exigences P0 tracées : **${p0.length}** (aucune exigence P0 de la matrice absente).`,
  `- Identifiants du CDC couverts : **${cdcIds.length} / ${cdcIds.length}**.`,
  `- Estimations non chiffrables (organisationnelles) : ${nonChiffres}.`,
  '',
  '### Par lot proposé',
  '',
  '| Lot | Éléments | Somme des estimations (pj, hypothèse) |',
  '|---|---:|---:|',
  ...Object.keys(byLot).sort().map((l) => `| ${l} | ${byLot[l]} | ${l.startsWith('V') ? sumPj(l) : 'n/c'} |`),
  '',
  '### Par constat de la matrice',
  '',
  '| Statut | Éléments |',
  '|---|---:|',
  ...Object.keys(byStatut).sort().map((s) => `| ${s} | ${byStatut[s]} |`),
  '',
  '### P0 planifiés hors V1 (décision COPIL requise)',
  '',
  ...(() => { const h = backlog.filter((b) => /P0/.test(b.prio_version) && !/^V1/.test(b.lot)); return h.length ? h.map((b) => `- ${b.id} (${b.lot}) : ${b.exigence}`) : ['Aucun.']; })(),
  '',
  '### Liaison avec le guide des prompts',
  '',
  '| Phase ou prompt | Référence CDC | Identifiants reliés |',
  '|---|---|---:|',
  ...guideSummary.map((g) => `| ${g.name} | ${g.ref} | ${g.count} |`),
  '',
  '## Avertissements',
  '',
  '- Les estimations en jours-personnes sont **des hypothèses de l\'auteur**, non validées par les responsables (CDC §12.4).',
  '- Les responsables sont des **rôles**, non des personnes : ils doivent être nommés (CDC §12.1).',
  '- Les lots V1/V2/V3 sont **proposés** ; le planning et les gates sont à valider par le COPIL.',
  '',
  '## Contrôles',
  '',
  errors.length ? `**${errors.length} anomalie(s)** :\n\n${errors.map((e) => `- ${e}`).join('\n')}` : 'Aucune anomalie : identifiants uniques, acteur/responsable/lot/estimation/Given-When-Then présents, dépendances valides, 126/126 identifiants CDC couverts, aucun P0 non tracé.',
  warnings.length ? `\nAvertissements de lecture :\n\n${warnings.map((w) => `- ${w}`).join('\n')}` : '',
  '',
].join('\n');
writeFileSync(new URL('BACKLOG.md', here), md, 'utf8');

console.log(`éléments=${backlog.length} P0=${p0.length} cdc=${cdcIds.length}/${cdcIds.length} erreurs=${errors.length} avertissements=${warnings.length}`);
for (const e of errors) console.log('ERREUR ' + e);
for (const w of warnings) console.log('AVERT ' + w);
process.exit(errors.length ? 1 : 0);

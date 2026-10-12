// Contrôles du planning et du budget (P006). Lit le backlog P003 et les montants du CDC §12.5.
// Aucune donnée inventée : les montants viennent du CDC ; les jours-personnes viennent du backlog (hypothèses).
// Sortie : PLANNING_CHECKS.md ; code de sortie 1 si une incohérence bloquante est trouvée.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
const BACKLOG = fileURLToPath(new URL('../backlog/BACKLOG.csv', import.meta.url));
const errors = [];

// 1. Lecture du CSV du backlog (guillemets doublés).
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* ignoré */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ''])));
}
const items = parseCsv(readFileSync(BACKLOG, 'utf8'));
const byId = new Map(items.map((i) => [i.id, i]));
if (byId.size !== items.length) errors.push('identifiants en double dans le backlog');

const pj = (i) => (/^\d+(\.\d+)?$/.test(i.estimation_pj) ? Number(i.estimation_pj) : 0);
const lotOf = (i) => (i.lot.startsWith('V1') ? 'V1' : i.lot.startsWith('V2') ? 'V2' : i.lot.startsWith('V3') ? 'V3' : 'hors lot');
// « hors lot » = organisationnel : aucune contrainte de planning technique.
const LOT_RANK = { V1: 1, V2: 2, V3: 3, 'hors lot': 0 };
const deps = (i) => (!i.dependances || i.dependances === '—' ? [] : i.dependances.split(';').map((s) => s.trim()).filter(Boolean));

// 2. Charge par lot.
const load = {};
for (const i of items) {
  const l = lotOf(i);
  load[l] = load[l] ?? { n: 0, pj: 0, nonChiffre: 0 };
  load[l].n++; load[l].pj += pj(i); if (!pj(i)) load[l].nonChiffre++;
}
const totalPj = Object.values(load).reduce((s, v) => s + v.pj, 0);

// 3. Dépendances : inconnues (bloquant) et vers un lot ultérieur (conflit de planning, à décider).
const lateDeps = [];
for (const i of items) {
  for (const d of deps(i)) {
    const t = byId.get(d);
    if (!t) { errors.push(`${i.id} : dépendance inconnue ${d}`); continue; }
    if (LOT_RANK[lotOf(t)] > LOT_RANK[lotOf(i)]) lateDeps.push(`${i.id} (${lotOf(i)}) dépend de ${d} (${lotOf(t)})`);
  }
}

// 4. Cycles : composantes fortement connexes (Tarjan). Un cycle est bloquant.
const sccs = [];
{
  let index = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of deps(byId.get(v)).filter((d) => byId.has(d))) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      const selfLoop = comp.length === 1 && deps(byId.get(comp[0])).includes(comp[0]);
      if (comp.length > 1 || selfLoop) sccs.push(comp.sort());
    }
  };
  for (const i of items) if (!idx.has(i.id)) strong(i.id);
}
for (const c of sccs) errors.push('cycle de dépendances : ' + c.join(' , '));

// 5. Chemin critique (somme des jours-personnes le long des dépendances, graphe sans cycle).
const memo = new Map();
const visiting = new Set();
function longest(id) {
  if (memo.has(id)) return memo.get(id);
  if (visiting.has(id)) return { v: 0, p: [] };
  visiting.add(id);
  const i = byId.get(id);
  let best = 0, bestPath = [];
  for (const d of (i ? deps(i) : [])) { const sub = longest(d); if (sub.v > best) { best = sub.v; bestPath = sub.p; } }
  visiting.delete(id);
  const res = { v: best + (i ? pj(i) : 0), p: [...bestPath, id] };
  memo.set(id, res);
  return res;
}
let crit = { v: 0, p: [] };
for (const i of items) { const r = longest(i.id); if (r.v > crit.v) crit = r; }

// 6. Capacité : équipe cœur indicative (CDC §12.4), en ETP ; jours ouvrés par mois = 21 (hypothèse).
const CORE_LOW = { dir: 0.5, po: 1, arch: 1, dev: 3, qa: 1, data: 1, devops: 0.5, change: 0.5 };
const CORE_HIGH = { dir: 1, po: 1, arch: 1, dev: 5, qa: 2, data: 1, devops: 1, change: 1 };
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const DAYS = 21;
const capLow = sum(CORE_LOW) * DAYS, capHigh = sum(CORE_HIGH) * DAYS;
const windows = [
  { lot: 'V1', label: 'M4–M12', months: 9, pj: load.V1?.pj ?? 0 },
  { lot: 'V2', label: 'M13–M24', months: 12, pj: load.V2?.pj ?? 0 },
  { lot: 'V3', label: 'M25–M36', months: 12, pj: load.V3?.pj ?? 0 },
].map((w) => ({ ...w, perMonth: w.pj / w.months, fitsLow: w.pj / w.months <= capLow, fitsHigh: w.pj / w.months <= capHigh }));

// 7. Budget CDC §12.5 (k TND HT) : contrôle d'arithmétique.
const B = [
  ['Audit/conception', 100, 180], ['Conservation/remédiation/socle', 180, 320], ['Modules métier', 450, 850],
  ['Data/intégrations', 120, 240], ['Mobiles/portails', 120, 220], ['BI/IA', 150, 300],
  ['QA/sécurité/résilience', 90, 160], ['Formation/déploiement', 80, 150],
];
const realLow = B.reduce((s, b) => s + b[1], 0), realHigh = B.reduce((s, b) => s + b[2], 0);
const reserveLow = Math.round(realLow * 0.2), reserveHigh = Math.round(realHigh * 0.2);
const exploLow = 180, exploHigh = 360;
const envLow = realLow + reserveLow + exploLow, envHigh = realHigh + reserveHigh + exploHigh;
if (realLow !== 1290 || realHigh !== 2420) errors.push(`sous-total réalisation ≠ CDC (${realLow}/${realHigh})`);
if (envLow !== 1728 || envHigh !== 3264) errors.push(`enveloppe ≠ CDC (${envLow}/${envHigh})`);

// 8. Contrôle de cohérence (pas un taux) : budget de réalisation rapporté aux jours-personnes du backlog.
const impliedLow = Math.round((realLow * 1000) / totalPj), impliedHigh = Math.round((realHigh * 1000) / totalPj);

// 8b. Priorités et versions déclarées par le CDC (« **ID — P0/V1. ») face au lot du backlog.
const CDC_PATH = process.env.CDC_PATH ?? 'C:/Users/DELL/Documents/Codex/2026-10-12/referenced-chatgpt-conversation-this-is-an/outputs/WORKMAN_ERP_360_CDC.md';
const cdcText = readFileSync(CDC_PATH, 'utf8');
const cdcTags = new Map();
for (const m of cdcText.matchAll(/\*\*([A-Z]{2,5}-[0-9]{2,3})(?: — ([^.*]+))?\.\*\*/g)) cdcTags.set(m[1], m[2] ?? null);
const tagLot = (t) => (t && /V1/.test(t) ? 'V1' : t && /V2/.test(t) ? 'V2' : t && /V3/.test(t) ? 'V3' : null);
const cdcMismatch = [];
const cdcNoTag = [];
for (const [id, tag] of cdcTags) {
  const it = byId.get(id);
  if (!it) continue;
  const l = tagLot(tag);
  if (!tag) { cdcNoTag.push(id); continue; }
  if (l && lotOf(it) !== l) cdcMismatch.push(`${id} : CDC « ${tag} », backlog ${lotOf(it)} (${it.prio_version})`);
}

// 9. Sorties.
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const md = [
  '# Contrôles du planning et du budget (P006)',
  '',
  'Généré par `build_planning.mjs`. Sources : `docs/erp360/backlog/BACKLOG.csv` (P003) et CDC §12.4–12.5. Aucun montant n’est inventé.',
  '',
  '## 1. Charge par lot (jours-personnes, hypothèses P003)',
  '',
  '| Lot | Éléments | Jours-personnes | Éléments non chiffrés |',
  '|---|---:|---:|---:|',
  ...Object.entries(load).map(([l, v]) => `| ${l} | ${v.n} | ${fmt(v.pj)} | ${v.nonChiffre} |`),
  `| **Total** | ${items.length} | **${fmt(totalPj)}** | |`,
  '',
  '## 2. Capacité de l’équipe cœur (CDC §12.4 ; 21 jours par mois : hypothèse)',
  '',
  `Équipe cœur : ${sum(CORE_LOW)} à ${sum(CORE_HIGH)} ETP, soit ${capLow} à ${capHigh} jours-personnes par mois.`,
  '',
  '| Fenêtre | Lot | Jours-personnes | Par mois | Tient dans la capacité basse ? | Tient dans la capacité haute ? |',
  '|---|---|---:|---:|---|---|',
  ...windows.map((w) => `| ${w.label} | ${w.lot} | ${fmt(w.pj)} | ${fmt(Math.round(w.perMonth * 10) / 10)} | ${w.fitsLow ? 'oui' : 'non'} | ${w.fitsHigh ? 'oui' : 'non'} |`),
  '',
  'Limites : la charge exclut l’audit M1–M3, les activités métiers (10–20 % du temps, CDC §12.4) et la recette ; elle ne porte que sur le backlog P003.',
  '',
  '## 3. Dépendances',
  '',
  `- Cycles de dépendances : **${sccs.length}**${sccs.length ? '\n' + sccs.map((c) => `  - ${c.join(' , ')}`).join('\n') : ''}`,
  `- Dépendances vers un lot ultérieur (conflits de planning, à décider) : **${lateDeps.length}**${lateDeps.length ? '\n' + lateDeps.map((x) => `  - ${x}`).join('\n') : ''}`,
  `- Chemin critique (jours-personnes cumulés le long des dépendances) : **${fmt(crit.v)} pj** ; chemin : ${crit.p.slice().reverse().join(' → ')}`,
  '',
  '## 4. Budget CDC §12.5 (k TND HT) : arithmétique et séparation',
  '',
  '| Poste | Bas | Haut |',
  '|---|---:|---:|',
  ...B.map((b) => `| ${b[0]} | ${b[1]} | ${b[2]} |`),
  `| **Sous-total réalisation** | **${realLow}** | **${realHigh}** |`,
  `| Réserve 20 % de la réalisation | ${reserveLow} | ${reserveHigh} |`,
  `| Exploitation, cloud, licences 36 mois | ${exploLow} | ${exploHigh} |`,
  `| **Enveloppe totale 36 mois** | **${envLow}** | **${envHigh}** |`,
  '| Matériel (scanners, RFID, réseau) | exclu | exclu |',
  '| Coûts internes (référents, masse salariale utilisateurs) | exclu (TCO séparé) | exclu (TCO séparé) |',
  '| Maintenance après M36 (hors enveloppe, k TND par an) | 180 | 320 |',
  '',
  'Contrôle : les totaux recalculés coïncident avec le CDC (1 290 / 2 420 ; 1 728 / 3 264).',
  '',
  '## 5. Contrôle de cohérence (pas un taux journalier)',
  '',
  `Le budget de réalisation (${realLow} à ${realHigh} k TND) rapporté aux ${fmt(totalPj)} jours-personnes du backlog donne **${impliedLow} à ${impliedHigh} TND par jour-personne**. Valeur implicite à confronter aux taux réels : ce n’est ni un taux validé ni un devis.`,
  '',
  '## 6. Cohérence avec les priorités déclarées par le CDC',
  '',
  `- Identifiants du CDC portant une priorité ou version : **${cdcTags.size - cdcNoTag.length}** ; sans priorité déclarée : **${cdcNoTag.length}** (${cdcNoTag.join(', ') || 'aucun'}).`,
  `- Écarts entre le lot du CDC et le lot du backlog (à décider, non bloquants) : **${cdcMismatch.length}**${cdcMismatch.length ? '\n' + cdcMismatch.map((x) => `  - ${x}`).join('\n') : ''}`,
  '',
  '## 7. Résultat des contrôles',
  '',
  errors.length ? `**${errors.length} anomalie(s) bloquante(s)** :\n${errors.map((e) => `- ${e}`).join('\n')}` : 'Aucune anomalie bloquante : budget conforme au CDC, aucun cycle, aucun identifiant en double, aucune dépendance inconnue.',
  lateDeps.length ? `\nConflits de planning à décider (non bloquants) : ${lateDeps.length}.` : '',
  '',
].join('\n');
writeFileSync(new URL('PLANNING_CHECKS.md', here), md, 'utf8');
console.log(`pj=${fmt(totalPj)} V1=${fmt(load.V1?.pj ?? 0)} V2=${fmt(load.V2?.pj ?? 0)} V3=${fmt(load.V3?.pj ?? 0)} cycles=${sccs.length} conflitsLot=${lateDeps.length} critique=${fmt(crit.v)} budget=${envLow}-${envHigh} anomaliesBloquantes=${errors.length}`);
for (const e of errors) console.log('ERREUR ' + e);
for (const l of lateDeps) console.log('CONFLIT ' + l);
process.exit(errors.length ? 1 : 0);

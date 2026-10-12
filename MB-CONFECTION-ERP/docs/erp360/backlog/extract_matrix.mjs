// Extrait les lignes de données des tableaux détaillés de MATRICE_ECARTS_CDC.md (à partir de « ## Partie 1 »).
// Le mappage des colonnes suit l'en-tête de chaque tableau (ID, Workflow, Domaine, Élément…), pas la position.
// Sortie : tableau de lignes [id, exigence, prio_version, statut, preuve, ecart, partie]. Aucun jugement ici.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../MATRICE_ECARTS_CDC.md', import.meta.url), 'utf8').split('\n');
const start = src.findIndex((l) => l.startsWith('## Partie 1'));
const cellsOf = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const find = (headers, re) => headers.findIndex((h) => re.test(h));

const rows = [];
let partie = '';
let headers = null;
for (let i = start; i < src.length; i++) {
  const line = src[i];
  if (line.startsWith('## ')) { partie = line.replace(/^## /, '').trim(); headers = null; continue; }
  if (!line.startsWith('|')) { headers = null; continue; }
  if (/^\|\s*-{3}/.test(line)) { headers = cellsOf(src[i - 1]); continue; }
  if (!headers) continue;
  const cells = cellsOf(line);
  const g = (re) => { const k = find(headers, re); return k >= 0 ? (cells[k] ?? '') : ''; };
  const idCol = headers[0];
  // Première colonne = identifiant ou nom de l'exigence ; les autres colonnes sont lues par leur nom.
  const id = cells[0] ?? '';
  const exigence = g(/^Exigence$/) || (headers.length >= 4 ? cells[1] ?? '' : '');
  const prio = g(/Prio/) || '—';
  const statut = g(/Statut/);
  const preuve = g(/Preuve/);
  const ecart = g(/Écart/);
  if (!id || /^(ID|Workflow|Domaine|Élément|Partie|Lot|Décision|Statut)$/.test(id)) continue;
  if (!statut) continue; // ligne de tableau sans statut : hors périmètre des constats
  rows.push([id, exigence || id, prio, statut, preuve, ecart, partie]);
}

export { rows };
if (process.argv[2] === '--print') {
  for (const r of rows) console.log(r.slice(0, 4).join(' | '));
  console.log(`TOTAL ${rows.length}`);
}

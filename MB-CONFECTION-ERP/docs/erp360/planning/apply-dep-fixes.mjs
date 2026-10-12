// Applique docs/erp360/planning/dependency-corrections.json aux fichiers enrichment_*.tsv du backlog.
// Vérifie l'ancienne valeur avant chaque modification : une différence bloque la correction.
// Idempotent : une correction déjà appliquée est reconnue et ignorée.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const backlogDir = fileURLToPath(new URL('../backlog/', import.meta.url));
const corr = JSON.parse(readFileSync(new URL('dependency-corrections.json', import.meta.url), 'utf8')).corrections;
const files = readdirSync(backlogDir).filter((f) => /^enrichment_\d+\.tsv$/.test(f));
const texts = Object.fromEntries(files.map((f) => [f, readFileSync(backlogDir + f, 'utf8').split('\n')]));
const problems = [];
let applied = 0, already = 0;

for (const c of corr) {
  let found = false;
  for (const f of files) {
    const lines = texts[f];
    const k = lines.findIndex((l) => l.split('\t')[0] === c.id);
    if (k < 0) continue;
    found = true;
    const cols = lines[k].split('\t');
    if (cols[3] === c.vers) { already++; break; }
    if (cols[3] !== c.de) { problems.push(`${c.id} : dépendances actuelles « ${cols[3]} », attendu « ${c.de} »`); break; }
    cols[3] = c.vers;
    lines[k] = cols.join('\t');
    applied++;
    break;
  }
  if (!found) problems.push(`${c.id} : ligne introuvable`);
}
if (problems.length) {
  console.log('BLOQUÉ :\n' + problems.map((p) => '- ' + p).join('\n'));
  process.exit(1);
}
for (const f of files) writeFileSync(backlogDir + f, texts[f].join('\n'), 'utf8');
console.log(`corrections appliquées=${applied} déjà présentes=${already} total=${corr.length}`);

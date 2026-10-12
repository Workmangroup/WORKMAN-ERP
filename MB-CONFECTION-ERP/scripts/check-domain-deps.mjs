// Garde-fou d'architecture : mesure les dépendances entre modules web (web/src/features/<module>)
// et compare à la référence docs/erp360/architecture/domain-deps.baseline.json.
//   node scripts/check-domain-deps.mjs            # contrôle : échoue sur une arête nouvelle ou un cycle
//   node scripts/check-domain-deps.mjs --record   # enregistre le graphe actuel comme référence (après revue)
//   node scripts/check-domain-deps.mjs --mermaid  # affiche le graphe en Mermaid
// Lecture seule. Racine surchargeable par SRC_ROOT (pour les tests).
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = process.env.SRC_ROOT ?? join(ROOT, 'web', 'src');
const BASELINE = process.env.BASELINE_FILE ?? join(ROOT, 'docs', 'erp360', 'architecture', 'domain-deps.baseline.json');
const mode = process.argv.includes('--record') ? 'record' : process.argv.includes('--mermaid') ? 'mermaid' : 'check';

const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
});

// Arêtes module -> module, déduites des imports « @/features/<autre> ».
const edges = new Map();
const featuresDir = join(SRC, 'features');
const modules = readdirSync(featuresDir).filter((m) => statSync(join(featuresDir, m)).isDirectory());
for (const m of modules) {
  for (const f of files(join(featuresDir, m))) {
    const text = readFileSync(f, 'utf8');
    for (const match of text.matchAll(/from ['"]@\/features\/([a-z-]+)/g)) {
      const target = match[1];
      if (target === m || !modules.includes(target)) continue;
      const key = `${m} -> ${target}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
}
const graph = [...edges.keys()].sort();
const canon = (c) => { const n = c.split(' -> ').slice(0, -1); const i = n.indexOf([...n].sort()[0]); return [...n.slice(i), ...n.slice(0, i)].join(' -> '); };

// Cycles : détection par parcours en profondeur.
const adj = new Map();
for (const e of graph) { const [a, b] = e.split(' -> '); adj.set(a, [...(adj.get(a) ?? []), b]); }
const cycles = [];
const state = new Map();
const stack = [];
const dfs = (n) => {
  state.set(n, 1); stack.push(n);
  for (const nx of adj.get(n) ?? []) {
    if (state.get(nx) === 1) cycles.push([...stack.slice(stack.indexOf(nx)), nx].join(' -> '));
    else if (!state.get(nx)) dfs(nx);
  }
  stack.pop(); state.set(n, 2);
};
for (const m of modules) if (!state.get(m)) dfs(m);

if (mode === 'mermaid') {
  console.log(['```mermaid', 'graph LR', ...graph.map((e) => `  ${e.replace(' -> ', ' --> ')}`), '```'].join('\n'));
  process.exit(0);
}
if (mode === 'record') {
  const known = [...new Set(cycles.map(canon))].sort();
  writeFileSync(BASELINE, JSON.stringify({
    recorded_at: new Date().toISOString().slice(0, 10),
    modules: modules.sort(),
    edges: graph,
    known_cycles: known,
    decision: 'D-P004-01 : cycle auth <-> rbac connu ; découplage à décider (journal d’audit extrait vers un module partagé)',
  }, null, 2) + '\n');
  console.log(`référence écrite : ${relative(ROOT, BASELINE)} (${graph.length} arêtes, ${modules.length} modules)`);
  process.exit(0);
}
if (!existsSync(BASELINE)) { console.log('aucune référence : lancer avec --record après revue'); process.exit(2); }
const ref = JSON.parse(readFileSync(BASELINE, 'utf8'));
const allowed = new Set(ref.edges);
const added = graph.filter((e) => !allowed.has(e));
const removed = ref.edges.filter((e) => !edges.has(e));
for (const e of added) console.log(`NOUVELLE DÉPENDANCE NON DÉCLARÉE : ${e} (${edges.get(e)} import(s))`);
const knownCycles = new Set(ref.known_cycles ?? []);
const newCycles = cycles.filter((c) => !knownCycles.has(canon(c)));
for (const c of newCycles) console.log(`CYCLE NOUVEAU : ${c}`);
for (const c of cycles) if (knownCycles.has(canon(c))) console.log(`cycle connu (décision D-P004-01) : ${c}`);
for (const e of removed) console.log(`disparue (à retirer de la référence après revue) : ${e}`);
const newModules = modules.filter((m) => !ref.modules.includes(m));
for (const m of newModules) console.log(`NOUVEAU MODULE non déclaré : ${m}`);
const bad = added.length + newCycles.length + newModules.length;
console.log(`modules=${modules.length} arêtes=${graph.length} référence=${ref.edges.length} nouvelles=${added.length} cycles_nouveaux=${newCycles.length} cycles_connus=${cycles.length - newCycles.length} disparues=${removed.length}`);
console.log(bad ? 'RÉSULTAT : écart à l’architecture déclarée' : 'RÉSULTAT : graphe conforme à la référence (aucune arête ni cycle nouveau)');
process.exit(bad ? 1 : 0);

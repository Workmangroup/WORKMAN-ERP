import type { CopilotAnswer } from './answer'

/** Export PDF d'une réponse : document imprimable (le navigateur enregistre en PDF). Pure, testable. */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function answerToPrintHtml(a: CopilotAnswer, question: string, generatedAt: string): string {
  const cards = (a.cards ?? []).map((c) => `<div class="card"><span>${esc(c.label)}</span><strong>${esc(c.value)}</strong></div>`).join('')
  const text = a.text.map((t) => `<p>${esc(t)}</p>`).join('')
  const table = a.table
    ? `<table><thead><tr>${a.table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${a.table.rows
        .map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : ''
  const chart = a.chart
    ? `<section><h3>${esc(a.chart.title)}</h3><table><tbody>${a.chart.points.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${esc(String(p.value))}</td></tr>`).join('')}</tbody></table></section>`
    : ''
  const recs = a.recommendations?.length ? `<section><h3>Actions recommandées</h3><ol>${a.recommendations.map((r) => `<li>${esc(r)}</li>`).join('')}</ol></section>` : ''
  const alerts = a.alerts?.length ? `<section><h3>Alertes</h3><ul>${a.alerts.map((x) => `<li><b>${esc(x.severity)}</b> — ${esc(x.text)}</li>`).join('')}</ul></section>` : ''
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(a.title)}</title>
<style>
  body{font:12px "Segoe UI",Arial,sans-serif;color:#0f1b2d;margin:28px}
  header{border-bottom:2px solid #0a4a8f;padding-bottom:10px;margin-bottom:16px}
  header small{color:#5b6b82}
  h1{font-size:18px;margin:0 0 4px} h3{font-size:13px;margin:16px 0 6px;color:#0a4a8f}
  .q{font-style:italic;color:#5b6b82;margin:0 0 12px}
  .cards{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
  .card{border:1px solid #e3e8f0;border-radius:8px;padding:8px 12px;min-width:120px}
  .card span{display:block;color:#5b6b82;font-size:11px} .card strong{font-size:15px}
  table{border-collapse:collapse;width:100%;margin-top:6px} th,td{border-bottom:1px solid #e3e8f0;padding:6px 8px;text-align:left}
  th{background:#eef4fb} .num{text-align:right;font-variant-numeric:tabular-nums}
  footer{margin-top:24px;color:#8b98ab;font-size:10px;border-top:1px solid #e3e8f0;padding-top:8px}
  @page{size:A4;margin:14mm}
</style></head><body>
<header><h1>${esc(a.title)}</h1><small>WORKMAN ERP 360 Copilot IA · généré le ${esc(generatedAt)}</small></header>
<p class="q">Question : ${esc(question)}</p>
${text}
<div class="cards">${cards}</div>
${chart}
${table}
${recs}
${alerts}
<footer>Sources : ${esc(a.sources.join(' ; ') || 'aucune')}. Document calculé à partir des données de la société, selon les droits de l'utilisateur.</footer>
</body></html>`
}

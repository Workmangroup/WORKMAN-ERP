/** Fonctions pures des tableaux : tri, filtres, recherche, pagination, exports. Sans React : testables seules. */

export type SortDir = 'asc' | 'desc'
export interface SortState { col: string; dir: SortDir }
export interface TableState {
  search: string
  sort: SortState | null
  /** Filtres par colonne : ensemble de valeurs acceptées (vide = pas de filtre). */
  filters: Record<string, string[]>
  /** Colonnes visibles, dans l'ordre d'affichage. */
  columns: string[]
  pageSize: number
}

export const PAGE_SIZES = [10, 25, 50, 100] as const

const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Recherche instantanée : chaque mot doit figurer dans une des valeurs de la ligne (colonnes recherchables). */
export function matchesSearch<T extends object>(row: T, search: string, searchable: string[]): boolean {
  const words = norm(search).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = norm(searchable.map((c) => (row as Record<string, unknown>)[c]).join(' | '))
  return words.every((w) => hay.includes(w))
}

/** Filtres avancés : une ligne passe si, pour chaque colonne filtrée, sa valeur figure dans l'ensemble choisi. */
export function matchesFilters<T extends object>(row: T, filters: Record<string, string[]>): boolean {
  return Object.entries(filters).every(([col, values]) => values.length === 0 || values.includes(String((row as Record<string, unknown>)[col] ?? '')))
}

/** Tri : nombres et dates comparés comme tels, textes en français (sans casse ni accents), valeurs vides en fin. */
export function sortRows<T extends object>(rows: T[], sort: SortState | null): T[] {
  if (!sort) return rows
  const mul = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const va = (a as Record<string, unknown>)[sort.col]
    const vb = (b as Record<string, unknown>)[sort.col]
    const ea = va === null || va === undefined || va === ''
    const eb = vb === null || vb === undefined || vb === ''
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul
    return norm(va).localeCompare(norm(vb), 'fr', { numeric: true }) * mul
  })
}

/** Pagination intelligente : affiche la première, la dernière et une fenêtre autour de la page courante. */
export function pageWindow(current: number, total: number, around = 1): (number | '…')[] {
  if (total <= 1) return [1]
  const pages = new Set<number>([1, total])
  for (let p = current - around; p <= current + around; p++) if (p >= 1 && p <= total) pages.add(p)
  const sorted = [...pages].sort((a, b) => a - b)
  const out: (number | '…')[] = []
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('…')
    out.push(p)
  })
  return out
}

export interface PageSlice<T> { rows: T[]; page: number; pages: number; from: number; to: number; total: number }

export function paginate<T>(rows: T[], page: number, pageSize: number): PageSlice<T> {
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const p = Math.min(Math.max(1, page), pages)
  const start = (p - 1) * pageSize
  const slice = rows.slice(start, start + pageSize)
  return { rows: slice, page: p, pages, from: total === 0 ? 0 : start + 1, to: start + slice.length, total }
}

/** Échappement CSV (guillemets doublés, séparateur « ; » pour Excel en français). */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  return [headers.map(csvCell).join(';'), ...rows.map((r) => r.map(csvCell).join(';'))].join('\r\n')
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Classeur Excel 2003 XML (SpreadsheetML) : ouvrable directement dans Excel, sans bibliothèque.
 * Les nombres sont typés « Number » pour rester calculables.
 */
export function toSpreadsheetXml(sheetName: string, headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v === null || v === '') return '<Cell><Data ss:Type="String"></Data></Cell>'
    if (typeof v === 'number') return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`
    return `<Cell><Data ss:Type="String">${xmlEsc(String(v))}</Data></Cell>`
  }
  const head = `<Row>${headers.map((h) => `<Cell ss:StyleID="h"><Data ss:Type="String">${xmlEsc(h)}</Data></Cell>`).join('')}</Row>`
  const body = rows.map((r) => `<Row>${r.map(cell).join('')}</Row>`).join('')
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="h"><Font ss:Bold="1"/><Interior ss:Color="#EFF6FC" ss:Pattern="Solid"/></Style></Styles>
<Worksheet ss:Name="${xmlEsc(sheetName.slice(0, 31))}"><Table>${head}${body}</Table></Worksheet>
</Workbook>`
}

/** Colonnes de la vue imprimable (PDF par impression du navigateur). */
export function toPrintHtml(title: string, headers: string[], rows: (string | number | null)[][]): string {
  const th = headers.map((h) => `<th>${xmlEsc(h)}</th>`).join('')
  const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${xmlEsc(c === null ? '' : String(c))}</td>`).join('')}</tr>`).join('')
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${xmlEsc(title)}</title>
<style>body{font:12px "Segoe UI",Arial,sans-serif;color:#201f1e;margin:24px}h1{font-size:16px;margin:0 0 12px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e1dfdd;padding:6px 8px;text-align:left}
th{background:#eff6fc;font-weight:600}@page{size:A4 landscape;margin:12mm}</style></head>
<body><h1>${xmlEsc(title)}</h1><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></body></html>`
}

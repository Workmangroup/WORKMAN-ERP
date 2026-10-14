/** Lecture et écriture CSV des imports (séparateur « ; » ou « , », guillemets doubles). Sans dépendance. */

export type CsvRow = Record<string, string>
export type ParsedCsv = { headers: string[]; rows: CsvRow[] }

const MAX_BYTES = 2_000_000

function splitLine(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map((v) => v.trim())
}

/** Séparateur : celui qui apparaît le plus dans l'en-tête. */
function detectSeparator(headerLine: string): string {
  return (headerLine.match(/;/g)?.length ?? 0) > (headerLine.match(/,/g)?.length ?? 0) ? ';' : ','
}

export function parseCsv(text: string): ParsedCsv {
  if (text.length > MAX_BYTES) throw new Error('Fichier trop volumineux (2 Mo maximum).')
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) throw new Error('Le fichier doit contenir un en-tête et au moins une ligne.')
  const sep = detectSeparator(lines[0])
  const headers = splitLine(lines[0], sep).map((h) => h.toLowerCase())
  if (new Set(headers).size !== headers.length || headers.some((h) => h === '')) throw new Error('En-têtes vides ou en double.')
  const rows = lines.slice(1).map((l) => {
    const cells = splitLine(l, sep)
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']))
  })
  return { headers, rows }
}

/** Empreinte SHA-256 du fichier (navigateur) : sert à la clé d'idempotence et au contrôle de contenu. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Clé d'idempotence déterministe : même type et même contenu = même clé = même lot. */
export function importKey(kind: string, sha: string): string {
  return `${kind}-${sha.slice(0, 40)}`
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
  return /[";\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Export des rejets : numéro de ligne, motifs, puis données brutes (colonnes = union des champs). */
export function rejectsToCsv(rejects: { line_no: number; raw: CsvRow; errors: { code: string; field?: string }[] }[]): string {
  const keys = [...new Set(rejects.flatMap((r) => Object.keys(r.raw)))]
  const head = ['ligne', 'motifs', ...keys]
  const body = rejects.map((r) => [
    r.line_no,
    r.errors.map((e) => (e.field ? `${e.code} (${e.field})` : e.code)).join(' | '),
    ...keys.map((k) => r.raw[k] ?? ''),
  ].map(cell).join(';'))
  return ['﻿' + head.map(cell).join(';'), ...body].join('\r\n')
}

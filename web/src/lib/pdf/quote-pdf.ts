// PDF de devis généré sans dépendance : texte Helvetica (WinAnsi), sans logo.
// Source unique : l'instantané renvoyé par quote_document (version courante ou version historisée).

export type QuoteDocLine = {
  pos: number
  sku: string | null
  description: string
  qty: number
  unit_price: number
  discount_pct: number
  line_total: number
  customization: string | null
}

export type QuoteDocSnapshot = {
  code: string
  version: number
  currency: string
  tax_rate: number
  quote_date: string
  valid_until: string
  lead_days: number
  payment_terms: string | null
  notes: string | null
  subtotal: number
  tax_amount: number
  total: number
  lines: QuoteDocLine[]
}

export type QuotePdfInput = {
  snapshot: QuoteDocSnapshot
  seq: number | null
  label: string
  hash: string
  party: string
}

const PAGE_W = 595
const PAGE_H = 842
const LEFT = 40
const RIGHT = 555
const BOTTOM = 80
const COL = { pos: LEFT, ref: 62, desc: 120, qty: 350, pu: 425, disc: 470, total: RIGHT }

/** Texte encodé en WinAnsi (une octet par caractère) : € = 0x80, hors plage remplacé par « ? ». */
export function winAnsi(text: string): string {
  let out = ''
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    const c = ch.codePointAt(0) ?? 63
    if (c === 0x20ac) out += '\x80'
    else if (c === 0x2019 || c === 0x2018) out += "'"
    else if ((c >= 32 && c < 127) || (c >= 160 && c <= 255)) out += ch
    else out += '?'
  }
  return out
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s)

/** Montant au format français : 1 234,50 */
export function fmtAmount(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split('.')
  return `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${dec}`
}
const fmtQty = (n: number) => String(Math.round(n * 1000) / 1000).replace('.', ',')
const fmtDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso)

// Largeur approximative (Helvetica ≈ 0,5 em par caractère) : suffisante pour aligner les montants à droite
const text = (x: number, y: number, size: number, bold: boolean, s: string) =>
  `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${esc(winAnsi(s))}) Tj ET`
const textRight = (xr: number, y: number, size: number, bold: boolean, s: string) =>
  text(xr - winAnsi(s).length * size * 0.5, y, size, bold, s)
const rule = (y: number) => `0.5 w ${LEFT} ${y} m ${RIGHT} ${y} l S`

function wrap(s: string, width: number, maxLines: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (cur && (cur + ' ' + word).length > width) { lines.push(cur); cur = word } else cur = cur ? `${cur} ${word}` : word
  }
  if (cur) lines.push(cur)
  return lines.slice(0, maxLines)
}

export function buildQuotePdf(input: QuotePdfInput): Buffer {
  const s = input.snapshot
  const pages: string[][] = []
  let ops: string[] = []
  let y = 0

  const tableHeader = () => {
    ops.push(text(COL.pos, y, 8, true, 'Pos'), text(COL.ref, y, 8, true, 'Réf.'), text(COL.desc, y, 8, true, 'Désignation'))
    ops.push(textRight(COL.qty, y, 8, true, 'Qté'), textRight(COL.pu, y, 8, true, 'PU HT'), textRight(COL.disc, y, 8, true, 'Remise'), textRight(COL.total, y, 8, true, 'Total HT'))
    ops.push(rule(y - 4))
    y -= 16
  }
  const startPage = () => {
    ops = []
    pages.push(ops)
    y = PAGE_H - 50
    if (pages.length === 1) {
      ops.push(text(LEFT, y, 16, true, `Devis ${s.code}`))
      y -= 16
      ops.push(text(LEFT, y, 9, false, `Client : ${input.party}`))
      y -= 12
      ops.push(text(LEFT, y, 9, false, `Date du devis : ${fmtDate(s.quote_date)}   Valable jusqu'au : ${fmtDate(s.valid_until)}   Livraison : ${s.lead_days} j`))
      y -= 12
      if (s.payment_terms) { ops.push(text(LEFT, y, 9, false, `Conditions de paiement : ${s.payment_terms}`)); y -= 12 }
      ops.push(text(LEFT, y, 8, false, `Version ${s.version}${input.seq === null ? ' (courante)' : ` (historique, ${input.label})`} · devise ${s.currency}`))
      y -= 22
    } else {
      ops.push(text(LEFT, y, 9, true, `Devis ${s.code} (suite)`))
      y -= 22
    }
    tableHeader()
  }

  startPage()
  for (const l of s.lines) {
    const custom = l.customization ? truncate(l.customization, 90) : null
    const h = 14 + (custom ? 10 : 0)
    if (y - h < BOTTOM) startPage()
    ops.push(text(COL.pos, y, 8, false, String(l.pos)))
    ops.push(text(COL.ref, y, 8, false, truncate(l.sku ?? '-', 14)))
    ops.push(text(COL.desc, y, 8, false, truncate(l.description, 46)))
    ops.push(textRight(COL.qty, y, 8, false, fmtQty(l.qty)))
    ops.push(textRight(COL.pu, y, 8, false, fmtAmount(l.unit_price)))
    ops.push(textRight(COL.disc, y, 8, false, `${fmtQty(l.discount_pct)} %`))
    ops.push(textRight(COL.total, y, 8, false, fmtAmount(l.line_total)))
    if (custom) ops.push(text(COL.desc, y - 10, 7, false, `Personnalisation : ${custom}`))
    y -= h
  }

  const notes = s.notes ? wrap(s.notes, 100, 6) : []
  if (y - (100 + notes.length * 11) < BOTTOM) startPage()
  y -= 8
  ops.push(rule(y))
  y -= 14
  const totals: [string, number, boolean][] = [
    ['Sous-total HT', s.subtotal, false],
    [`TVA ${fmtQty(s.tax_rate)} %`, s.tax_amount, false],
    ['Total TTC', s.total, true],
  ]
  for (const [label, v, bold] of totals) {
    ops.push(textRight(COL.pu + 40, y, 9, bold, label), textRight(COL.total, y, 9, bold, `${fmtAmount(v)} ${s.currency}`))
    y -= 14
  }
  if (notes.length) {
    y -= 10
    ops.push(text(LEFT, y, 8, true, 'Remarques'))
    y -= 11
    for (const n of notes) { ops.push(text(LEFT, y, 8, false, n)); y -= 11 }
  }

  const n = pages.length
  pages.forEach((p, i) => {
    p.push(text(LEFT, 36, 7, false, `Réf. ${input.label}${input.seq === null ? '' : ` v.${input.seq}`} · empreinte ${input.hash.slice(0, 16)} · page ${i + 1}/${n}`))
  })

  return assemble(pages)
}

/** Assemblage bas niveau : catalogue, pages, polices Helvetica (WinAnsi), table xref et trailer. */
function assemble(pages: string[][]): Buffer {
  const head = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const count = 4 + pages.length * 2
  const bodies: string[] = []
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  bodies[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  bodies[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  bodies[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  pages.forEach((content, i) => {
    const body = content.join('\n')
    bodies[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`
    bodies[6 + i * 2] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`
  })

  let out = head
  const offsets: number[] = []
  for (let id = 1; id <= count; id++) {
    offsets[id] = out.length
    out += `${id} 0 obj\n${bodies[id]}\nendobj\n`
  }
  const xref = out.length
  out += `xref\n0 ${count + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= count; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

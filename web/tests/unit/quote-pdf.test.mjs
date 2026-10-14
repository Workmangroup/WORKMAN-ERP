// Tests unitaires du PDF de devis : node tests/unit/quote-pdf.test.mjs
import { buildQuotePdf, winAnsi, fmtAmount } from '../../src/lib/pdf/quote-pdf.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

const line = (pos, qty, price, disc, total, extra = {}) => ({ pos, sku: `SKU-${pos}`, description: `Article ${pos} (test)`, qty, unit_price: price, discount_pct: disc, line_total: total, customization: null, ...extra })
const snapshot = {
  code: 'DEV-2026-000042', version: 2, currency: 'EUR', tax_rate: 19, quote_date: '2026-10-01', valid_until: '2026-10-31', lead_days: 15,
  payment_terms: '30 jours', notes: 'Prix valables pour la quantité indiquée.', subtotal: 190, tax_amount: 36.1, total: 226.1,
  lines: [line(1, 3, 33.333, 10, 90, { customization: 'Broderie logo poitrine' }), line(2, 2, 50, 0, 100)],
}
const pdf = buildQuotePdf({ snapshot, seq: null, label: 'courant', hash: 'a'.repeat(64), party: 'Client Démo SA' })
const text = pdf.toString('latin1')

ok('en-tête %PDF-1.4', text.startsWith('%PDF-1.4'))
ok('fin de fichier %%EOF', text.trimEnd().endsWith('%%EOF'))
ok('montant total au format français', text.includes('226,10 EUR'))
ok('sous-total et TVA présents', text.includes('190,00 EUR') && text.includes('36,10 EUR'))
ok('code devis et client présents', text.includes('DEV-2026-000042') && text.includes('Client D'))
ok('personnalisation affichée', text.includes('Personnalisation : Broderie logo poitrine'))

// Table xref : chaque entrée doit pointer sur « n 0 obj » (20 octets par entrée)
const xrefAt = Number(text.match(/startxref\n(\d+)\n%%EOF/)?.[1])
const xrefBlock = text.slice(xrefAt).split('\n')
const entries = xrefBlock.slice(2).filter((l) => /^\d{10} \d{5} [nf] $/.test(l))
const objOk = entries.slice(1).every((e, i) => text.startsWith(`${i + 1} 0 obj`, Number(e.slice(0, 10))))
ok('xref : décalages valides vers chaque objet', entries.length > 3 && objOk, `entries=${entries.length}`)

// Pagination : beaucoup de lignes => plusieurs pages, chacune avec son pied
const many = Array.from({ length: 120 }, (_, i) => line(i + 1, 1, 10, 0, 10))
const big = buildQuotePdf({ snapshot: { ...snapshot, lines: many, subtotal: 1200, tax_amount: 228, total: 1428 }, seq: 1, label: 'sent', hash: 'b'.repeat(64), party: 'Grand client' }).toString('latin1')
const pages = (big.match(/\/Type \/Page \//g) ?? []).length
ok('pagination : plusieurs pages pour 120 lignes', pages > 2, `pages=${pages}`)
ok('pied de page avec numérotation', big.includes(`page 1/${pages}`) && big.includes(`page ${pages}/${pages}`))
ok('version historique indiquée (pied et en-tête)', big.includes('v.1') && big.includes('historique, sent'))

// Encodage et échappement
ok('€ encodé en WinAnsi 0x80', winAnsi('10 €') === '10 \x80')
ok('caractère hors plage remplacé', winAnsi('a→b') === 'a?b')
ok('apostrophe typographique normalisée', winAnsi('l’accord') === "l'accord")
ok('montant négatif', fmtAmount(-1234.5) === '-1 234,50')
const esc = buildQuotePdf({ snapshot: { ...snapshot, lines: [line(1, 1, 1, 0, 1, { description: 'Tissu (rip) \\ stop' })] }, seq: null, label: 'courant', hash: 'c'.repeat(64), party: 'x' }).toString('latin1')
ok('parenthèses et antislash échappés', esc.includes('Tissu \\(rip\\) \\\\ stop'))

console.log(failed ? `\n${failed} échec(s)` : '\nTous les tests passent')
process.exit(failed ? 1 : 0)

// Signature des webhooks transporteurs : signature liée à l'horodatage, fenêtre de rejeu, comparaison sans exception — P056
import { signCarrierPayload, verifyCarrierSignature, CARRIER_SIGNATURE_TOLERANCE_SECONDS } from '../../src/lib/carrier/webhook.ts'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}`) } }

const secret = 'secret-de-test-p56'
const raw = JSON.stringify({ carrier: 'DHL', event_id: 'dhl-1', tracking_number: 'TRK-56-A', event_code: 'in_transit', occurred_at: '2026-10-13T09:00:00Z' })
const now = 1_800_000_000
const sig = (ts = now, body = raw, key = secret) => signCarrierPayload(key, ts, body)
const check = (over = {}) => verifyCarrierSignature({ secret, timestampHeader: String(now), signatureHeader: sig(), raw, nowSeconds: now, ...over })

ok('signature valide acceptée', check().ok === true)
ok('signature liée au corps : corps modifié refusé (BAD_SIGNATURE)', check({ raw: raw.replace('in_transit', 'delivered') }).code === 'BAD_SIGNATURE')
ok('signature liée au secret : mauvais secret refusé', check({ signatureHeader: sig(now, raw, 'autre-secret') }).code === 'BAD_SIGNATURE')
ok('signature liée à l’horodatage : même signature avec un autre horodatage refusée', check({ timestampHeader: String(now + 1) }).code === 'BAD_SIGNATURE')
ok('en-tête de signature absent refusé sans exception', check({ signatureHeader: null }).code === 'BAD_SIGNATURE')
ok('en-tête de signature de mauvaise longueur refusé sans exception', check({ signatureHeader: 'sha256=abc' }).code === 'BAD_SIGNATURE')
ok('horodatage absent ou non numérique refusé (BAD_TIMESTAMP)', check({ timestampHeader: null }).code === 'BAD_TIMESTAMP' && check({ timestampHeader: 'hier' }).code === 'BAD_TIMESTAMP')
ok('rejeu hors fenêtre refusé (STALE_TIMESTAMP)', check({ nowSeconds: now + CARRIER_SIGNATURE_TOLERANCE_SECONDS + 1 }).code === 'STALE_TIMESTAMP')
ok('message du futur hors fenêtre refusé (STALE_TIMESTAMP)', check({ nowSeconds: now - CARRIER_SIGNATURE_TOLERANCE_SECONDS - 1 }).code === 'STALE_TIMESTAMP')
ok('limite de la fenêtre : exactement 300 secondes acceptées', check({ nowSeconds: now + CARRIER_SIGNATURE_TOLERANCE_SECONDS }).ok === true)
ok('signature du corps seul (sans horodatage) ne vaut pas : sha256 de « corps » refusé', check({ signatureHeader: signCarrierPayload(secret, 0, raw) }).code === 'BAD_SIGNATURE')
ok('format de signature : préfixe sha256= et 64 caractères hexadécimaux', /^sha256=[0-9a-f]{64}$/.test(sig()))

console.log(`\n${pass} PASS, ${fail} FAIL`)
if (fail > 0) process.exit(1)

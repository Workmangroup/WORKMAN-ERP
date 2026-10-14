// Tests unitaires du POS hors ligne : signature et chiffrement du cache, contrôles de durée et de plafond,
// file de synchronisation (panne, ack perdu, rejeu, conflit) — P078. Exécution : node tests/unit/pos-offline.test.mjs
import { canonicalJson, signCache, verifyCache, encryptCache, decryptCache, checkOfflineSale } from '../../src/features/pos/offline-cache.ts'
import { OfflineJournal, memoryStore } from '../../src/features/pos/offline-queue.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

// --- signature ---
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const payload = { register_code: 'CAI-1', valid_until: '2099-01-01T00:00:00Z', max_offline_amount: 500, variants: [{ sku: 'V1', price_ht: 100 }] }
const sig = await signCache(payload, privateKey)
ok('signature : contenu intact vérifié', await verifyCache(payload, sig, publicKey))
ok('signature : même contenu, autre ordre des clés : vérifié (canonique)', await verifyCache({ variants: [{ price_ht: 100, sku: 'V1' }], max_offline_amount: 500, valid_until: '2099-01-01T00:00:00Z', register_code: 'CAI-1' }, sig, publicKey))
ok('signature : prix modifié dans le cache : refusé', !(await verifyCache({ ...payload, variants: [{ sku: 'V1', price_ht: 1 }] }, sig, publicKey)))
ok('signature : mauvaise clé : refusée', !(await verifyCache(payload, sig, other.publicKey)))
ok('canonicalJson : clés triées', canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === '{"a":{"c":3,"d":2},"b":1}')

// --- chiffrement local ---
const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
const box = await encryptCache(JSON.stringify(payload), aes)
ok('chiffrement : aller-retour exact', JSON.parse(await decryptCache(box, aes)).register_code === 'CAI-1')
ok('chiffrement : texte chiffré ≠ texte clair', !box.data.includes('CAI-1'))
const aes2 = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
let wrongKey = false; try { await decryptCache(box, aes2) } catch { wrongKey = true }
ok('chiffrement : mauvaise clé refusée', wrongKey)
const tampered = { iv: box.iv, data: box.data.slice(0, -4) + 'AAAA' }
let tamperedRefused = false; try { await decryptCache(tampered, aes) } catch { tamperedRefused = true }
ok('chiffrement : altération détectée (GCM)', tamperedRefused)

// --- durée et plafond avant une vente hors ligne ---
const now = new Date('2026-10-14T10:00:00Z')
ok('vente : dans la durée et sous le plafond : autorisée', (await checkOfflineSale(payload, sig, publicKey, 300, now)) === null)
ok('vente : au-delà du plafond : refusée explicitement', (await checkOfflineSale(payload, sig, publicKey, 500.01, now)) === 'CACHE_CEILING')
ok('vente : cache expiré : refusée explicitement', (await checkOfflineSale({ ...payload, valid_until: '2026-10-14T09:00:00Z' }, await signCache({ ...payload, valid_until: '2026-10-14T09:00:00Z' }, privateKey), publicKey, 10, now)) === 'CACHE_EXPIRED')
ok('vente : cache altéré : refusée (signature)', (await checkOfflineSale({ ...payload, max_offline_amount: 99999 }, sig, publicKey, 10, now)) === 'CACHE_SIGNATURE')

// --- file de synchronisation : serveur simulé idempotent ---
const serverTickets = new Map()       // clientOpId -> ticket
const serverApply = (op) => {
  if (serverTickets.has(op.clientOpId)) return { status: 'applied', ticket_id: serverTickets.get(op.clientOpId), conflict_code: null, replayed: true }
  if (op.lines[0].unit_price_ht !== 100) return { status: 'conflict', ticket_id: null, conflict_code: 'POS_PRICE_CONFLICT', replayed: false }
  const t = `T-${serverTickets.size + 1}`
  serverTickets.set(op.clientOpId, t)
  return { status: 'applied', ticket_id: t, conflict_code: null, replayed: false }
}
const journal = new OfflineJournal(memoryStore(), (() => { let n = 0; return () => `op-${++n}` })())
const sale = (price) => ({ deviceId: 'D1', sessionId: 'S1', soldAt: '2026-10-14T09:55:00Z', lines: [{ variant: 'V1', qty: 1, unit_price_ht: price, vat_code: 'TN_STD_19' }], payments: [{ method: 'ESP', amount: 119 }] })
await journal.recordSale(sale(100))
await journal.recordSale(sale(100))
await journal.recordSale(sale(90))          // prix hors ligne périmé
await journal.recordSale(sale(100))

// Panne après envoi : le serveur applique op-1, la réponse est perdue (exception côté caisse)
let calls = 0
const flaky = async (op) => { calls++; if (op.clientOpId === 'op-1' && calls === 1) { serverApply(op); throw new Error('réseau') } return serverApply(op) }
const first = await journal.flush(flaky)
ok('panne : la file s\'arrête à l\'opération perdue, rien n\'est marqué à tort', first.stoppedOnNetwork === true && first.applied === 0)
const second = await journal.flush(flaky)
const list = await journal.list()
ok('reprise : vente renvoyée avec le même identifiant, appliquée une seule fois', serverTickets.size === 3 && list.find((o) => o.clientOpId === 'op-1').status === 'applied')
ok('conflit de prix : signalé, non rejoué automatiquement', list.find((o) => o.clientOpId === 'op-3').status === 'conflict' && list.find((o) => o.clientOpId === 'op-3').conflictCode === 'POS_PRICE_CONFLICT')
ok('retransmission : aucun doublon côté serveur (3 tickets pour 3 ventes valides)', serverTickets.size === 3 && second.applied === 3 && second.conflicts === 1)
const third = await journal.flush(flaky)
ok('conflit non rejoué : la passe suivante n\'envoie rien de plus', third.applied === 0 && third.conflicts === 0 && third.stoppedOnNetwork === false)

console.log(failed === 0 ? `\nTOUS LES TESTS PASSENT` : `\n${failed} ÉCHEC(S)`)
process.exitCode = failed === 0 ? 0 : 1

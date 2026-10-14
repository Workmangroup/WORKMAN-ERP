// File hors ligne mobile : mode avion, fermeture et reprise, envoi unique, expiration, conflits visibles,
// révocation, purge par périmètre — P099. Exécution : node tests/unit/mobile-outbox.test.mjs
import { MobileOutbox, memoryOutboxStore } from '../../src/features/mobile/outbox.ts'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); if (!cond) failed++ }

// Serveur simulé : applique une opération une seule fois, rejoue la même réponse sinon (clé = identifiant d'opération)
const makeServer = () => {
  const applied = new Map()
  const calls = []
  return {
    calls,
    applied,
    send: async (entry) => {
      calls.push(entry.opId)
      if (entry.payload.kind === 'stock' && entry.payload.qty > 5) return { kind: 'conflict', code: 'STOCK_INSUFFICIENT' }
      if (entry.payload.kind === 'bad') return { kind: 'rejected', code: 'INVALID_LOCATION' }
      if (!applied.has(entry.opId)) applied.set(entry.opId, { at: calls.length })
      return { kind: 'ok' }
    },
  }
}

const clock = { t: Date.parse('2026-10-14T08:00:00Z') }
const now = () => clock.t
const H = 3600e3
const store = memoryOutboxStore()
const outboxFor = (s = store) => new MobileOutbox(s, { maxOfflineMs: 8 * H, now, newId: (() => { let n = 0; return () => `op-${++n}` })() })

// --- Mode avion : rien n'est envoyé, rien n'est perdu ---
const box = outboxFor()
await box.enqueue('user-1/wh-1', { kind: 'pick', line: 'L1' })
await box.enqueue('user-1/wh-1', { kind: 'pick', line: 'L2' })
const server = makeServer()
const airplane = async () => { throw new Error('offline') }
const r0 = await box.flush(airplane)
ok('mode avion : aucune opération perdue ni marquée envoyée', r0.stoppedOnNetwork === true && (await box.list()).every((e) => e.status === 'pending'))

// --- Fermeture de l'application puis reprise : nouvelle instance sur le même stockage ---
const reopened = outboxFor(store)
const r1 = await reopened.flush(server.send)
ok('reprise après fermeture : les deux opérations envoyées', r1.sent === 2 && r1.stoppedOnNetwork === false)
ok('envoi unique : chaque identifiant d\'opération envoyé une seule fois au serveur', server.calls.length === 2 && new Set(server.calls).size === 2, JSON.stringify(server.calls))

// --- Panne après réception : la réponse est perdue, l'opération est renvoyée avec le même identifiant ---
const box2 = outboxFor()
const e3 = await box2.enqueue('user-1/wh-1', { kind: 'pick', line: 'L3' })
let dropOnce = true
const server2 = makeServer()
const lossy = async (entry) => {
  const out = await server2.send(entry)
  if (dropOnce) { dropOnce = false; throw new Error('réponse perdue') }
  return out
}
const lost = await box2.flush(lossy)
ok('réponse perdue : opération marquée en attente, pas envoyée à tort', lost.stoppedOnNetwork === true && (await box2.list()).find((e) => e.opId === e3.opId).status === 'pending')
const retry = await box2.flush(lossy)
ok('retransmission : même identifiant, appliquée une seule fois côté serveur', retry.sent === 1 && server2.applied.size === 1 && server2.calls.filter((c) => c === e3.opId).length === 2)

// --- Conflits et rejets visibles, jamais rejoués ---
const box3 = outboxFor()
await box3.enqueue('user-1/wh-1', { kind: 'stock', qty: 9 })
await box3.enqueue('user-1/wh-1', { kind: 'bad' })
await box3.enqueue('user-1/wh-1', { kind: 'pick', line: 'L4' })
const server3 = makeServer()
const r3 = await box3.flush(server3.send)
const after3 = await box3.list()
ok('conflit de stock : visible, code explicite, pas rejoué', after3.find((e) => e.payload.kind === 'stock').status === 'conflict' && after3.find((e) => e.payload.kind === 'stock').code === 'STOCK_INSUFFICIENT')
ok('rejet : visible avec son motif', after3.find((e) => e.payload.kind === 'bad').status === 'rejected')
ok('les opérations suivantes sont tout de même envoyées', after3.find((e) => e.payload.line === 'L4').status === 'sent' && r3.sent === 1)
const r3b = await box3.flush(server3.send)
ok('conflit non rejoué : la passe suivante n\'envoie rien', r3b.sent === 0 && server3.calls.length === 3)

// --- Durée hors ligne : au-delà du plafond, pas d'envoi ---
const box4 = outboxFor()
await box4.enqueue('user-1/wh-1', { kind: 'pick', line: 'OLD' })
clock.t += 9 * H
const server4 = makeServer()
const r4 = await box4.flush(server4.send)
ok('durée hors ligne dépassée : opération expirée, non envoyée', r4.flagged === 1 && server4.calls.length === 0 && (await box4.list()).find((e) => e.payload.line === 'OLD').status === 'expired')
clock.t -= 9 * H

// --- Purge par périmètre : refuse de perdre du travail en attente sans décision explicite ---
const box5 = outboxFor(memoryOutboxStore())
await box5.enqueue('user-1/wh-1', { kind: 'pick', line: 'P1' })
await box5.enqueue('user-2/wh-1', { kind: 'pick', line: 'Q1' })
await box5.flush(airplane)
const refused = await box5.purge('user-1/wh-1', { discardPending: false })
ok('purge : refusée tant qu\'une opération est en attente (aucune perte silencieuse)', refused.removed === 0 && refused.kept === 1)
const forced = await box5.purge('user-1/wh-1', { discardPending: true })
ok('purge explicite : retire le périmètre demandé seulement', forced.removed === 1 && (await box5.list('user-2/wh-1')).length === 1)

// --- Révocation : après refus serveur du type révoqué, le périmètre se purge sans rejeu ---
const box6 = outboxFor(memoryOutboxStore())
await box6.enqueue('user-1/wh-1', { kind: 'pick', line: 'R1' })
await box6.flush(async () => ({ kind: 'rejected', code: 'MOBILE_DEVICE_REVOKED' }))
const cleared = await box6.purge('user-1/wh-1', { discardPending: false })
ok('révocation : opération rejetée pour appareil révoqué, purge possible après décision', (await box6.list())[0].code === 'MOBILE_DEVICE_REVOKED' && cleared.removed === 0)
const cleared2 = await box6.purge('user-1/wh-1', { discardPending: true })
ok('révocation : périmètre vidé après décision explicite', cleared2.removed === 1 && (await box6.list()).length === 0)

let thrown = false
try { new MobileOutbox(memoryOutboxStore(), { maxOfflineMs: 0 }) } catch { thrown = true }
ok('durée hors ligne obligatoire : aucune valeur par défaut', thrown)

console.log(failed === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failed} ÉCHEC(S)`)
process.exitCode = failed === 0 ? 0 : 1

// File hors ligne des applications mobiles : chaque opération reçoit un identifiant fixé avant tout envoi (envoi unique
// côté serveur), survit à la fermeture de l'application (stockage injecté : IndexedDB chiffré sur l'appareil), expire
// au-delà de la durée hors ligne, et rend les conflits et rejets visibles sans les rejouer. La purge est bornée à un périmètre
// (utilisateur, entrepôt) et refuse de supprimer des opérations en attente sans décision explicite.

export type OutboxStatus = 'pending' | 'sent' | 'conflict' | 'rejected' | 'expired'

export type OutboxEntry<T> = {
  opId: string
  scope: string
  payload: T
  createdAt: string
  status: OutboxStatus
  attempts: number
  code: string | null
}

export type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'conflict'; code: string }
  | { kind: 'rejected'; code: string }

/** Stockage persistant injecté : mémoire en test, IndexedDB chiffré sur l'appareil en production. */
export interface OutboxStore<T> {
  all(): Promise<OutboxEntry<T>[]>
  put(entry: OutboxEntry<T>): Promise<void>
  remove(opId: string): Promise<void>
}

export class MobileOutbox<T> {
  private readonly store: OutboxStore<T>
  private readonly maxOfflineMs: number
  private readonly newId: () => string
  private readonly now: () => number

  constructor(store: OutboxStore<T>, opts: { maxOfflineMs: number; newId?: () => string; now?: () => number }) {
    if (!Number.isFinite(opts.maxOfflineMs) || opts.maxOfflineMs <= 0) throw new Error('OUTBOX_NO_OFFLINE_DURATION')
    this.store = store
    this.maxOfflineMs = opts.maxOfflineMs
    this.newId = opts.newId ?? (() => crypto.randomUUID())
    this.now = opts.now ?? (() => Date.now())
  }

  /** Enregistre une opération avant tout envoi : l'identifiant est fixé ici et ne changera plus. */
  async enqueue(scope: string, payload: T): Promise<OutboxEntry<T>> {
    const entry: OutboxEntry<T> = { opId: this.newId(), scope, payload, createdAt: new Date(this.now()).toISOString(), status: 'pending', attempts: 0, code: null }
    await this.store.put(entry)
    return entry
  }

  async list(scope?: string): Promise<OutboxEntry<T>[]> {
    const all = await this.store.all()
    return scope === undefined ? all : all.filter((e) => e.scope === scope)
  }

  /**
   * Envoie les opérations en attente, dans l'ordre. Une exception = panne réseau : arrêt, l'opération reste en attente
   * avec le même identifiant. Une réponse est appliquée une fois : « ok » → envoyée ; « conflict » ou « rejected » → visible,
   * jamais rejouée automatiquement. Une opération au-delà de la durée hors ligne n'est pas envoyée (statut « expired »).
   */
  async flush(send: (entry: OutboxEntry<T>) => Promise<SendOutcome>): Promise<{ sent: number; flagged: number; stoppedOnNetwork: boolean }> {
    let sent = 0, flagged = 0
    for (const entry of (await this.store.all()).filter((e) => e.status === 'pending')) {
      if (this.now() - new Date(entry.createdAt).getTime() > this.maxOfflineMs) {
        await this.store.put({ ...entry, status: 'expired', code: 'OUTBOX_EXPIRED' })
        flagged++
        continue
      }
      let outcome: SendOutcome
      try {
        outcome = await send({ ...entry, attempts: entry.attempts + 1 })
      } catch {
        await this.store.put({ ...entry, attempts: entry.attempts + 1 })
        return { sent, flagged, stoppedOnNetwork: true }
      }
      if (outcome.kind === 'ok') { sent++; await this.store.put({ ...entry, status: 'sent', attempts: entry.attempts + 1, code: null }) }
      else { flagged++; await this.store.put({ ...entry, status: outcome.kind === 'conflict' ? 'conflict' : 'rejected', attempts: entry.attempts + 1, code: outcome.code }) }
    }
    return { sent, flagged, stoppedOnNetwork: false }
  }

  /**
   * Purge d'un périmètre : seules les opérations confirmées (« sent ») sont retirées sans décision ; les opérations en attente,
   * en conflit, rejetées ou expirées ne le sont que si `discardPending` est vrai (décision explicite, pas de perte silencieuse).
   */
  async purge(scope: string, opts: { discardPending: boolean }): Promise<{ removed: number; kept: number }> {
    const mine = await this.list(scope)
    // Tout ce qui n'est pas confirmé par le serveur (attente, conflit, rejet, expiration) doit être décidé explicitement
    const blocking = mine.filter((e) => e.status !== 'sent')
    if (blocking.length > 0 && !opts.discardPending) return { removed: 0, kept: mine.length }
    for (const e of mine) await this.store.remove(e.opId)
    return { removed: mine.length, kept: 0 }
  }
}

/** Stockage en mémoire : tests et contrôles. Survit à une nouvelle instance de MobileOutbox (reprise). */
export function memoryOutboxStore<T>(): OutboxStore<T> {
  const m = new Map<string, OutboxEntry<T>>()
  return {
    async all() { return [...m.values()] },
    async put(e) { m.set(e.opId, e) },
    async remove(id) { m.delete(id) },
  }
}

// File de synchronisation des ventes hors ligne : identifiant d'opération généré à la vente (rejeu sûr),
// arrêt à la première panne réseau (ordre conservé), conflits signalés et jamais rejoués automatiquement.

export type SaleOp = {
  clientOpId: string
  deviceId: string
  sessionId: string
  soldAt: string
  lines: { variant: string; qty: number; unit_price_ht: number; vat_code: string }[]
  payments: { method: string; amount: number }[]
}

export type QueuedOp = SaleOp & { status: 'pending' | 'applied' | 'conflict'; conflictCode: string | null; ticketId: string | null }

export type SyncResponse = { status: 'applied' | 'conflict'; ticket_id: string | null; conflict_code: string | null; replayed: boolean }

/** Stockage injecté : mémoire pour les tests, IndexedDB sur la caisse. */
export interface OpStore {
  all(): Promise<QueuedOp[]>
  put(op: QueuedOp): Promise<void>
}

export class OfflineJournal {
  private readonly store: OpStore
  private readonly newId: () => string

  constructor(store: OpStore, newId: () => string = () => crypto.randomUUID()) {
    this.store = store
    this.newId = newId
  }

  /** Enregistre la vente localement avant tout envoi : l'identifiant d'opération est fixé ici. */
  async recordSale(sale: Omit<SaleOp, 'clientOpId'>): Promise<QueuedOp> {
    const op: QueuedOp = { ...sale, clientOpId: this.newId(), status: 'pending', conflictCode: null, ticketId: null }
    await this.store.put(op)
    return op
  }

  async list(): Promise<QueuedOp[]> {
    return this.store.all()
  }

  /**
   * Envoie les opérations en attente, dans l'ordre. `send` lève une exception en cas de panne réseau :
   * on s'arrête (la même opération sera renvoyée, avec le même identifiant). Une réponse « conflit » est
   * enregistrée et n'est pas renvoyée automatiquement : c'est une décision humaine.
   */
  async flush(send: (op: QueuedOp) => Promise<SyncResponse>): Promise<{ applied: number; conflicts: number; stoppedOnNetwork: boolean }> {
    let applied = 0, conflicts = 0
    for (const op of (await this.store.all()).filter((o) => o.status === 'pending')) {
      let res: SyncResponse
      try {
        res = await send(op)
      } catch {
        return { applied, conflicts, stoppedOnNetwork: true }
      }
      if (res.status === 'applied') { applied++; await this.store.put({ ...op, status: 'applied', ticketId: res.ticket_id }) }
      else { conflicts++; await this.store.put({ ...op, status: 'conflict', conflictCode: res.conflict_code }) }
    }
    return { applied, conflicts, stoppedOnNetwork: false }
  }
}

/** Store en mémoire (tests). */
export function memoryStore(): OpStore {
  const m = new Map<string, QueuedOp>()
  return {
    async all() { return [...m.values()] },
    async put(op) { m.set(op.clientOpId, op) },
  }
}

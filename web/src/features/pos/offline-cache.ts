// Cache de caisse hors ligne : signature de l'API vérifiée côté caisse, chiffrement local, contrôle de durée et de plafond.
// Modules purs (WebCrypto) : aucune clé n'est codée en dur ; la clé de signature publique est fournie par l'appelant.

export type CachePayload = {
  valid_until: string
  max_offline_amount: number | string
  [key: string]: unknown
}

/** Sérialisation stable (clés triées) : même contenu, même texte, même signature. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
  return `{${entries.join(',')}}`
}

const enc = new TextEncoder()
const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer)))
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** Signature ECDSA P-256 / SHA-256 du contenu canonique (faite par l'API, clé privée hors du dépôt). */
export async function signCache(payload: unknown, privateKey: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(canonicalJson(payload)))
  return toB64(sig)
}

export async function verifyCache(payload: unknown, signature: string, publicKey: CryptoKey): Promise<boolean> {
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromB64(signature), enc.encode(canonicalJson(payload)))
}

/** Chiffrement AES-GCM du cache stocké localement (clé non exportable, créée sur l'appareil). */
export async function encryptCache(plain: string, key: CryptoKey): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain))
  return { iv: toB64(iv), data: toB64(ct) }
}

export async function decryptCache(box: { iv: string; data: string }, key: CryptoKey): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data))
  return new TextDecoder().decode(pt)
}

export type OfflineRefusal = 'CACHE_EXPIRED' | 'CACHE_CEILING' | 'CACHE_SIGNATURE' | null

/** Contrôle avant une vente hors ligne : signature, durée du cache, plafond du montant TTC. */
export async function checkOfflineSale(
  payload: CachePayload, signature: string, publicKey: CryptoKey, amountTtc: number, now: Date,
): Promise<OfflineRefusal> {
  if (!(await verifyCache(payload, signature, publicKey))) return 'CACHE_SIGNATURE'
  if (now.getTime() >= new Date(payload.valid_until).getTime()) return 'CACHE_EXPIRED'
  if (amountTtc > Number(payload.max_offline_amount)) return 'CACHE_CEILING'
  return null
}

import { createHmac, timingSafeEqual } from 'node:crypto'

// Signature d'un webhook transporteur : HMAC-SHA256 de « <horodatage>.<corps brut> ».
// L'horodatage (secondes Unix) est signé : un message capturé ne peut pas être rejoué hors de la fenêtre.
export const CARRIER_SIGNATURE_TOLERANCE_SECONDS = 300

export function signCarrierPayload(secret: string, timestamp: number, raw: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`
}

export type CarrierSignatureCheck =
  | { ok: true }
  | { ok: false; code: 'BAD_TIMESTAMP' | 'STALE_TIMESTAMP' | 'BAD_SIGNATURE' }

export function verifyCarrierSignature(input: {
  secret: string
  timestampHeader: string | null
  signatureHeader: string | null
  raw: string
  nowSeconds: number
  toleranceSeconds?: number
}): CarrierSignatureCheck {
  const tolerance = input.toleranceSeconds ?? CARRIER_SIGNATURE_TOLERANCE_SECONDS
  if (!input.timestampHeader || !/^\d{1,12}$/.test(input.timestampHeader)) return { ok: false, code: 'BAD_TIMESTAMP' }
  const timestamp = Number(input.timestampHeader)
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return { ok: false, code: 'STALE_TIMESTAMP' }
  const expected = Buffer.from(signCarrierPayload(input.secret, timestamp, input.raw))
  const given = Buffer.from(input.signatureHeader ?? '')
  // comparaison à temps constant ; longueurs différentes = refus immédiat (timingSafeEqual exige des longueurs égales)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: 'BAD_SIGNATURE' }
  return { ok: true }
}

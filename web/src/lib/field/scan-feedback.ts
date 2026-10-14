/** Retour visuel et sonore d'un scan (P042). Partie pure, testable ; le signal matériel est dans signalScan. */

export type ScanTone = 'success' | 'warning' | 'danger'
export interface ScanFeedback { tone: ScanTone; beep: 'ok' | 'error' | 'none'; vibrate: number[]; label: string }
export interface ScanOutcome { ok: boolean; duplicate?: boolean; replayed?: boolean; code?: string | null; message?: string }

/** Refus : erreur franche (son grave, vibration longue). Doublon : confirmation légère sans nouvel effet. Rejeu : rien à signaler. */
export function scanFeedback(r: ScanOutcome): ScanFeedback {
  if (!r.ok) return { tone: 'danger', beep: 'error', vibrate: [200, 100, 200], label: r.message ?? 'Refusé' }
  if (r.replayed) return { tone: 'success', beep: 'none', vibrate: [], label: 'Déjà enregistré : aucun doublon' }
  if (r.duplicate) return { tone: 'warning', beep: 'ok', vibrate: [60], label: r.message ?? 'Doublon ignoré' }
  return { tone: 'success', beep: 'ok', vibrate: [60], label: r.message ?? 'Enregistré' }
}

/** Signal matériel : vibration et bip (si l'appareil les permet). Sans effet côté serveur. */
export function signalScan(f: ScanFeedback): void {
  if (typeof window === 'undefined') return
  if (f.vibrate.length && typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(f.vibrate)
  if (f.beep === 'none') return
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = f.beep === 'ok' ? 880 : 220
    gain.gain.value = 0.15
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + (f.beep === 'ok' ? 0.12 : 0.35))
  } catch {
    // Pas de son disponible : le retour visuel reste affiché.
  }
}

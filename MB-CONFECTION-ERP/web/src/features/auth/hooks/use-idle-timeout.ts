'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'mb_last_activity'
const HEARTBEAT_EVERY_MS = 4 * 60_000
const EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll', 'mousemove'] as const

interface Options {
  /** Durée d'inactivité avant déconnexion (doit correspondre au timeout du middleware). */
  timeoutMs: number
  /** Délai d'avertissement avant la déconnexion. */
  warningMs?: number
  onTimeout: () => void
}

/**
 * Surveille l'inactivité de l'utilisateur :
 *  - avertit `warningMs` avant l'expiration, puis appelle `onTimeout` ;
 *  - envoie un battement de cœur au serveur tant que l'utilisateur est actif
 *    (renouvelle le cookie d'activité du middleware) ;
 *  - synchronise l'activité entre onglets via localStorage.
 */
export function useIdleTimeout({ timeoutMs, warningMs = 60_000, onTimeout }: Options) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const last = useRef(Date.now())
  const lastBeat = useRef(Date.now())
  const fired = useRef(false)
  const warningRef = useRef(false)
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  const fire = useCallback(() => {
    if (fired.current) return
    fired.current = true
    onTimeoutRef.current()
  }, [])

  const beat = useCallback(async () => {
    lastBeat.current = Date.now()
    try {
      const res = await fetch('/api/auth/heartbeat', { method: 'POST', cache: 'no-store' })
      if (res.status === 401) fire()
    } catch {
      /* réseau indisponible : on réessaiera */
    }
  }, [fire])

  const markActive = useCallback(() => {
    last.current = Date.now()
    try {
      localStorage.setItem(STORAGE_KEY, String(last.current))
    } catch {
      /* stockage indisponible */
    }
  }, [])

  /** « Rester connecté » : réinitialise le minuteur et renouvelle la session serveur. */
  const stayActive = useCallback(() => {
    warningRef.current = false
    setSecondsLeft(null)
    markActive()
    void beat()
  }, [beat, markActive])

  useEffect(() => {
    markActive()
    const onEvent = () => {
      if (warningRef.current) return // pendant l'avertissement, seul « Rester connecté » réactive
      const now = Date.now()
      if (now - last.current < 1000) return
      markActive()
      if (now - lastBeat.current > HEARTBEAT_EVERY_MS) void beat()
    }
    EVENTS.forEach((e) => window.addEventListener(e, onEvent, { passive: true }))

    const tick = window.setInterval(() => {
      let lastSeen = last.current
      try {
        lastSeen = Math.max(lastSeen, Number(localStorage.getItem(STORAGE_KEY) ?? 0))
      } catch {
        /* ignore */
      }
      const idle = Date.now() - lastSeen
      if (idle >= timeoutMs) return fire()
      if (idle >= timeoutMs - warningMs) {
        warningRef.current = true
        setSecondsLeft(Math.ceil((timeoutMs - idle) / 1000))
      } else if (warningRef.current) {
        // activité détectée dans un autre onglet
        warningRef.current = false
        setSecondsLeft(null)
      }
    }, 1000)

    return () => {
      EVENTS.forEach((e) => window.removeEventListener(e, onEvent))
      window.clearInterval(tick)
    }
  }, [timeoutMs, warningMs, fire, beat, markActive])

  return { secondsLeft, warning: secondsLeft !== null, stayActive }
}

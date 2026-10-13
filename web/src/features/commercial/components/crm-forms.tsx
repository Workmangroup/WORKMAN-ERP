'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { SubmitButton } from '@/components/auth/submit-button'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { FormState } from '@/features/auth/types'

type Act = (prev: FormState, fd: FormData) => Promise<FormState>

const Msg = ({ s }: { s: FormState }) =>
  s?.message ? <p role={s.ok ? 'status' : 'alert'} className={s.ok ? 'text-xs text-success-text' : 'text-xs text-danger-text'}>{s.message}</p> : null

/** Formulaire générique : les champs sont fournis par la page (serveur) ; l'état et le message viennent de l'action. */
export function ActionForm({ action, submit, children }: { action: Act; submit: string; children: React.ReactNode }) {
  const [state, formAction] = useActionState(action, null)
  return (
    <form action={formAction} className="grid gap-3 md:grid-cols-2">
      {children}
      <div className="flex flex-wrap items-center gap-3 md:col-span-2">
        <SubmitButton variant="command" size="sm">{submit}</SubmitButton>
        <Msg s={state} />
      </div>
    </form>
  )
}

/** Planification : l'heure saisie est locale au navigateur ; le décalage (tz_min) est envoyé pour produire un instant absolu. */
export function VisitPlanForm({ action, clients }: { action: Act; clients: { id: string; name: string }[] }) {
  const [state, formAction] = useActionState(action, null)
  const [tz, setTz] = useState('0')
  useEffect(() => setTz(String(-new Date().getTimezoneOffset())), [])
  return (
    <form action={formAction} className="grid gap-3 md:grid-cols-2">
      <input type="hidden" name="tz_min" value={tz} />
      <label className="grid gap-1 text-sm">Client
        <select name="client_id" required className="rounded-md border border-line bg-white px-3 py-2">
          <option value="">Choisir…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">Date et heure
        <input type="datetime-local" name="planned_local" required className="rounded-md border border-line bg-white px-3 py-2" />
      </label>
      <label className="grid gap-1 text-sm">Durée (minutes)
        <input type="number" name="duration_min" min={5} max={480} defaultValue={30} className="rounded-md border border-line bg-white px-3 py-2" />
      </label>
      <label className="grid gap-1 text-sm">Objet de la visite
        <input name="purpose" required minLength={2} maxLength={300} className="rounded-md border border-line bg-white px-3 py-2" />
      </label>
      <div className="flex flex-wrap items-center gap-3 md:col-span-2">
        <SubmitButton variant="command" size="sm">Planifier la visite</SubmitButton>
        <Msg s={state} />
      </div>
    </form>
  )
}

/**
 * Pointage honnête : la position n'est demandée qu'au clic ; refus ou indisponibilité sont enregistrés comme tels, sans coordonnée.
 */
export function VisitCheckinForm({ action, planId }: { action: Act; planId: string }) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  const [busy, setBusy] = useState(false)
  const set = (name: string, value: string) => {
    const el = ref.current?.elements.namedItem(name) as HTMLInputElement | null
    if (el) el.value = value
  }
  const finish = (status: string, lat: string, lng: string, acc: string, reason: string) => {
    set('gps_status', status); set('latitude', lat); set('longitude', lng); set('accuracy_m', acc); set('reason', reason)
    setBusy(false)
    ref.current?.requestSubmit()
  }
  const pointer = () => {
    setBusy(true)
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      finish('unavailable', '', '', '', 'Géolocalisation absente sur cet appareil')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) => finish('captured', String(p.coords.latitude), String(p.coords.longitude), String(p.coords.accuracy), ''),
      (err) => (err.code === 1 ? finish('denied', '', '', '', 'Accès à la position refusé par l’utilisateur') : finish('unavailable', '', '', '', 'Position indisponible au moment du pointage')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  }
  return (
    <form ref={ref} action={formAction} className="space-y-2">
      <input type="hidden" name="plan_id" value={planId} />
      <input type="hidden" name="gps_status" defaultValue="" />
      <input type="hidden" name="latitude" defaultValue="" />
      <input type="hidden" name="longitude" defaultValue="" />
      <input type="hidden" name="accuracy_m" defaultValue="" />
      <input type="hidden" name="reason" defaultValue="" />
      <Button type="button" variant="command" size="sm" onClick={pointer} disabled={busy}>{busy ? 'Position en cours…' : 'Pointer ma position'}</Button>
      <p className="text-xs text-ink-soft">Votre position n’est demandée qu’à ce clic, une seule fois pour cette visite. Si elle est refusée ou indisponible, le pointage l’indique sans inventer de coordonnées.</p>
      <Msg s={state} />
    </form>
  )
}

type SpeechRec = {
  lang: string; continuous: boolean; interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  start: () => void; stop: () => void
}
const speechCtor = (): (new () => SpeechRec) | null => {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Dictée : texte brut conservé ; le compte rendu est une version relue, enregistrée seulement si la case « relu » est cochée. */
export function VisitReportForm({ action, planId }: { action: Act; planId: string }) {
  const [state, formAction] = useActionState(action, null)
  const [dictation, setDictation] = useState('')
  const [report, setReport] = useState('')
  const [listening, setListening] = useState(false)
  const [supported, setSupported] = useState(false)
  const recRef = useRef<SpeechRec | null>(null)
  useEffect(() => setSupported(speechCtor() !== null), [])
  const toggle = () => {
    const Ctor = speechCtor()
    if (!Ctor) return
    if (listening) { recRef.current?.stop(); setListening(false); return }
    const rec = new Ctor()
    rec.lang = 'fr-FR'; rec.continuous = true; rec.interimResults = false
    rec.onresult = (e) => {
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += ` ${e.results[i][0].transcript}`
      if (text.trim()) setDictation((d) => `${d}${text}`.replace(/^\s+/, ''))
    }
    rec.onend = () => setListening(false)
    recRef.current = rec
    rec.start()
    setListening(true)
  }
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="plan_id" value={planId} />
      <div className="space-y-2">
        <Textarea name="dictation" rows={3} value={dictation} onChange={(e) => setDictation(e.target.value)} placeholder="Dictée brute (facultative)" maxLength={8000} aria-label="Dictée brute" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={toggle} disabled={!supported}>{listening ? 'Arrêter la dictée' : 'Dicter'}</Button>
          {!supported && <span className="text-xs text-ink-soft">Dictée non disponible sur ce navigateur : saisissez le texte.</span>}
          <Button type="button" variant="ghost" size="sm" onClick={() => setReport((r) => (r ? `${r}\n${dictation}` : dictation))} disabled={!dictation.trim()}>Reprendre la dictée dans le compte rendu</Button>
        </div>
      </div>
      <Textarea name="report" rows={4} value={report} onChange={(e) => setReport(e.target.value)} required minLength={5} maxLength={8000} placeholder="Compte rendu relu" aria-label="Compte rendu" />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="reviewed" className="h-4 w-4" />
        Dictée relue : le compte rendu reflète ce qui a été dit (obligatoire si une dictée est saisie)
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="command" size="sm">Enregistrer le compte rendu</SubmitButton>
        <Msg s={state} />
      </div>
    </form>
  )
}

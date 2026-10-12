'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, CameraOff } from 'lucide-react'
import { BigButton, FieldFeedback, Stepper, useFieldAction } from './field-ui'
import { STEP } from '@/lib/field/logic'
import { addDefectAction, decideAction, logOfAction, ofStepAction, pickAction, resolveCodeAction } from '../actions'
import type { DefectCodeLite, OrderCard, PickLine } from '../services'

/* ---------- Scan ---------- */

/** Scan : caméra si le navigateur sait lire les QR/codes-barres, sinon saisie manuelle (toujours disponible). */
export function ScanPanel() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [camera, setCamera] = useState<'idle' | 'on' | 'unsupported' | 'denied'>('idle')
  const [manual, setManual] = useState('')
  const { result, pending, run } = useFieldAction()

  const open = (code: string) => run(() => resolveCodeAction(code), undefined)

  useEffect(() => {
    if (result?.ok && result.href) router.push(result.href)
  }, [result, router])

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let stopped = false
    const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector
    if (camera !== 'on') return
    if (!Detector || !navigator.mediaDevices?.getUserMedia) { setCamera('unsupported'); return }
    const detector = new Detector({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39'] })
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
        stream = s
        if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play().catch(() => undefined) }
        timer = setInterval(async () => {
          if (!videoRef.current) return
          try {
            const codes = await detector.detect(videoRef.current)
            if (codes[0]?.rawValue) { stopped = true; open(codes[0].rawValue) }
          } catch { /* image pas prête : on réessaie */ }
        }, 400)
      })
      .catch(() => setCamera('denied'))
    return () => { stopped = true; if (timer) clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera])

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-lg border border-line bg-black">
        {camera === 'on' ? (
          <video ref={videoRef} muted playsInline className="aspect-video w-full object-cover" aria-label="Caméra de scan" />
        ) : (
          <div className="flex aspect-video flex-col items-center justify-center gap-3 p-6 text-center text-white/80">
            <Camera className="h-12 w-12" aria-hidden />
            <p className="text-lg">Placez le code devant la caméra.</p>
          </div>
        )}
      </div>
      {camera === 'idle' && <BigButton onClick={() => setCamera('on')}><Camera className="h-6 w-6" aria-hidden /> Activer la caméra</BigButton>}
      {camera === 'on' && <BigButton tone="secondary" onClick={() => setCamera('idle')}><CameraOff className="h-6 w-6" aria-hidden /> Arrêter la caméra</BigButton>}
      {(camera === 'unsupported' || camera === 'denied') && (
        <p className="rounded-lg bg-warn-bg px-4 py-3 text-lg text-warn-text">
          {camera === 'denied' ? 'Accès à la caméra refusé.' : 'Ce navigateur ne lit pas les codes : utilisez la saisie ci-dessous.'}
        </p>
      )}

      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) open(manual) }}>
        <label htmlFor="manual-code" className="block text-lg font-medium">Ou saisissez le code</label>
        <input id="manual-code" value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" autoCapitalize="characters" inputMode="text"
          placeholder="OF-2026-000012" className="h-16 w-full rounded-lg border-2 border-line-strong bg-surface px-4 font-mono text-2xl uppercase focus:border-brand-500 focus:outline-none" />
        <BigButton type="submit" disabled={pending || manual.trim().length < 3}>Ouvrir</BigButton>
      </form>
      <FieldFeedback result={result} pending={pending} />
    </div>
  )
}

/* ---------- Ordre de fabrication ---------- */

const PAUSE_REASONS = ['Panne machine', 'Attente matière', 'Attente contrôle', 'Changement de série']

export function OfPanel({ order }: { order: OrderCard }) {
  const [good, setGood] = useState(0)
  const [scrap, setScrap] = useState(0)
  const [hours, setHours] = useState(1)
  const [status, setStatus] = useState(order.status)
  const [remaining, setRemaining] = useState(order.qty_planned - order.qty_good)
  const { result, pending, run, clear } = useFieldAction()
  const closed = status === 'done'
  const canLog = status === 'launched' || status === 'in_progress'

  const log = () => run(() => logOfAction(order.id, good, scrap, hours), () => {
    setRemaining((r) => r - good - scrap)
    setGood(0); setScrap(0)
  })
  const step = (s: 'launch' | 'resume' | 'finish' | 'suspend', reason?: string) => run(() => ofStepAction(order.id, s, reason), () => {
    setStatus(s === 'launch' || s === 'resume' ? 'in_progress' : s === 'suspend' ? 'suspended' : 'done')
  })

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="font-mono text-base text-ink-soft">{order.number}</p>
        <p className="text-2xl font-semibold">{order.article_name}</p>
        <p className="mt-1 text-lg text-ink-soft">Reste à produire : <span className="font-bold text-ink">{Math.max(0, remaining)}</span> sur {order.qty_planned} · Poste {order.work_center_code ?? 'à affecter'}</p>
        {order.late_days > 0 && <p className="mt-2 rounded-md bg-danger-bg px-3 py-2 text-lg font-semibold text-danger-text">En retard de {order.late_days} jour(s)</p>}
      </div>

      {closed && <p className="rounded-lg bg-success-bg p-4 text-lg font-semibold text-success-text">Cet ordre est terminé.</p>}

      {canLog && (
        <section aria-label="Saisie du suivi" className="space-y-3">
          <Stepper label="Pièces bonnes" value={good} onChange={(v) => { setGood(v); clear() }} step={STEP.bigPiece} />
          <Stepper label="Pièces rebutées" value={scrap} onChange={(v) => { setScrap(v); clear() }} step={STEP.piece} />
          <Stepper label="Heures travaillées" value={hours} onChange={(v) => { setHours(v); clear() }} step={STEP.hours} min={0.5} max={24} />
          <BigButton onClick={log} disabled={pending || good + scrap <= 0}>Valider le suivi</BigButton>
        </section>
      )}

      {(status === 'planned' || status === 'launched') && (
        <BigButton tone="success" onClick={() => step(status === 'planned' ? 'launch' : 'resume')} disabled={pending}>
          {status === 'planned' ? 'Lancer l’ordre' : 'Reprendre'}
        </BigButton>
      )}

      {canLog && (
        <section aria-label="Suspendre" className="space-y-2">
          <p className="text-lg font-medium text-ink-soft">Suspendre pour :</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {PAUSE_REASONS.map((r) => (
              <BigButton key={r} tone="secondary" onClick={() => step('suspend', r)} disabled={pending}>{r}</BigButton>
            ))}
          </div>
        </section>
      )}
      {status === 'suspended' && <BigButton tone="success" onClick={() => step('resume')} disabled={pending}>Reprendre la production</BigButton>}

      {canLog && (
        <BigButton tone="danger" onClick={() => { if (window.confirm('Terminer cet ordre ? Il ne pourra plus recevoir de saisie.')) step('finish') }} disabled={pending}>Terminer l’ordre</BigButton>
      )}

      <FieldFeedback result={result} pending={pending} />
    </div>
  )
}

/* ---------- Contrôle qualité ---------- */

export function ControlPanel({ inspection }: { inspection: { id: string; number: string; kind: string; status: string; sample_size: number; codes: DefectCodeLite[] } }) {
  const [code, setCode] = useState<string | null>(null)
  const [qty, setQty] = useState(1)
  const [decided, setDecided] = useState(inspection.status !== 'open')
  const { result, pending, run, clear } = useFieldAction()
  const open = !decided

  const add = () => { if (code) run(() => addDefectAction(inspection.id, code, qty), () => { setCode(null); setQty(1) }) }
  const decide = (d: 'accepted' | 'conditional' | 'rejected') => {
    const label = d === 'accepted' ? 'Accepter ce lot ?' : d === 'conditional' ? 'Accepter sous réserve ?' : 'Rejeter ce lot ? Une non-conformité sera ouverte.'
    if (!window.confirm(label)) return
    run(() => decideAction(inspection.id, d), () => setDecided(true))
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="font-mono text-base text-ink-soft">{inspection.number}</p>
        <p className="text-2xl font-semibold">Contrôle {inspection.kind === 'reception' ? 'réception' : inspection.kind === 'production' ? 'production' : 'final'}</p>
        <p className="text-lg text-ink-soft">Échantillon : {inspection.sample_size} pièce(s)</p>
      </div>

      {open && (
        <>
          <section aria-label="Défauts constatés" className="space-y-3">
            <p className="text-lg font-medium text-ink-soft">Défaut constaté</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {inspection.codes.map((c) => (
                <button key={c.code} type="button" onClick={() => { setCode(c.code); clear() }} aria-pressed={code === c.code}
                  className={`min-h-[72px] rounded-lg border-2 px-3 py-2 text-left text-base font-semibold transition ${code === c.code ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line bg-surface'}`}>
                  <span className="block font-mono text-sm text-ink-soft">{c.code}</span>{c.label}
                </button>
              ))}
            </div>
            {code && (
              <>
                <Stepper label="Nombre de défauts" value={qty} onChange={setQty} min={1} />
                <BigButton onClick={add} disabled={pending}>Ajouter {code} × {qty}</BigButton>
              </>
            )}
          </section>

          <section aria-label="Décision" className="space-y-2">
            <p className="text-lg font-medium text-ink-soft">Décision</p>
            <BigButton tone="success" onClick={() => decide('accepted')} disabled={pending}>Accepter</BigButton>
            <BigButton tone="secondary" onClick={() => decide('conditional')} disabled={pending}>Accepter sous réserve</BigButton>
            <BigButton tone="danger" onClick={() => decide('rejected')} disabled={pending}>Rejeter</BigButton>
          </section>
        </>
      )}
      {decided && <p className="rounded-lg bg-success-bg p-4 text-lg font-semibold text-success-text">Ce contrôle est décidé.</p>}
      <FieldFeedback result={result} pending={pending} />
    </div>
  )
}

/* ---------- Prélèvement ---------- */

export function PickPanel({ lines }: { lines: PickLine[] }) {
  const [qty, setQty] = useState<Record<string, number>>({})
  const [picked, setPicked] = useState<Record<string, number>>(Object.fromEntries(lines.map((l) => [l.id, l.qty_picked])))
  const { result, pending, run } = useFieldAction()

  const take = (l: PickLine) => {
    const n = qty[l.id] ?? Math.max(1, l.qty_requested - (picked[l.id] ?? 0))
    run(() => pickAction(l.id, n), () => {
      setPicked((p) => ({ ...p, [l.id]: (p[l.id] ?? 0) + n }))
      setQty((q) => ({ ...q, [l.id]: 0 }))
    })
  }

  return (
    <div className="space-y-4">
      {lines.map((l) => {
        const done = picked[l.id] ?? 0
        const rest = l.qty_requested - done
        const value = qty[l.id] ?? Math.max(1, rest)
        return (
          <article key={l.id} className="space-y-3 rounded-lg border border-line bg-surface p-4">
            <div>
              <p className="font-mono text-base text-ink-soft">{l.sku}</p>
              <p className="text-xl font-semibold">{l.product}</p>
              <p className="text-lg text-ink-soft">Prélevé <span className="font-bold text-ink">{done}</span> / {l.qty_requested}</p>
            </div>
            {rest > 0 ? (
              <>
                <Stepper label="Quantité à prélever" value={value} onChange={(v) => setQty((q) => ({ ...q, [l.id]: v }))} min={1} max={rest} />
                <BigButton onClick={() => take(l)} disabled={pending}>Prélever {value}</BigButton>
              </>
            ) : <p className="rounded-md bg-success-bg px-3 py-2 text-lg font-semibold text-success-text">Ligne complète</p>}
          </article>
        )
      })}
      <FieldFeedback result={result} pending={pending} />
    </div>
  )
}

'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeft, ArrowRight, Bell, GripVertical } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { PRIORITY, PROJECT_STATUS, STAGES, daysUntil, nextStage, stageIndex, stageInfo, label, FAMILIES } from '@/lib/development/options'
import { fmtDay } from '@/features/orders/status'
import { cn } from '@/lib/utils'
import { moveProjectAction } from '../actions'
import type { DevProjectRow } from '../types'

/**
 * Tableau Kanban : une colonne par étape du workflow. Glisser-déposer (ou boutons ← →) ; on n'avance que d'une étape à la fois,
 * sous les portes de contrôle appliquées par la base ; un retour en arrière demande un motif.
 */
export function KanbanBoard({ projects, canWrite }: { projects: DevProjectRow[]; canWrite: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [back, setBack] = useState<{ id: string; to: string; code: string } | null>(null)
  const [reason, setReason] = useState('')

  const move = (id: string, to: string, why?: string) => {
    start(async () => {
      const r = await moveProjectAction(id, to, why)
      setMsg({ ok: Boolean(r?.ok), text: r?.message ?? '' })
      if (r?.ok) { setBack(null); setReason(''); router.refresh() }
    })
  }
  const drop = (stage: string) => {
    const id = dragId
    setDragId(null); setOver(null)
    const p = projects.find((x) => x.id === id)
    if (!p || p.stage === stage) return
    if (stageIndex(stage) < stageIndex(p.stage)) { setBack({ id: p.id, to: stage, code: p.code }); return }
    move(p.id, stage)
  }

  return (
    <div className="space-y-3">
      <div aria-live="polite">{msg && msg.text && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}</div>
      <div className={cn('flex gap-3 overflow-x-auto pb-3', pending && 'opacity-70')} role="list" aria-label="Kanban du développement produit">
        {STAGES.map((s) => {
          const list = projects.filter((p) => p.stage === s.id)
          return (
            <section key={s.id} role="listitem" aria-label={`${s.label} — ${list.length} projet(s)`}
              onDragOver={(e) => { if (canWrite && dragId) { e.preventDefault(); setOver(s.id) } }} onDragLeave={() => setOver((o) => (o === s.id ? null : o))} onDrop={() => canWrite && drop(s.id)}
              className={cn('flex w-72 shrink-0 flex-col rounded-md border bg-canvas/60', over === s.id ? 'border-brand-500 bg-brand-50' : 'border-line')}>
              <header className="flex items-center justify-between border-b border-line px-3 py-2"><h3 className="text-sm font-semibold">{s.label}</h3><span className="rounded-full bg-white px-2 text-xs tabular-nums text-ink-soft">{list.length}</span></header>
              <ul className="flex min-h-24 flex-1 flex-col gap-2 p-2">
                {list.map((p) => {
                  const d = daysUntil(p.due_date)
                  const late = p.status === 'active' && p.stage !== 'production' && d !== null && d < 0
                  const nxt = nextStage(p.stage)
                  const movable = canWrite && p.status === 'active'
                  return (
                    <li key={p.id} draggable={movable} onDragStart={(e) => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.id) }} onDragEnd={() => { setDragId(null); setOver(null) }}
                      className={cn('rounded-md border bg-white p-2.5 shadow-card', late || p.open_alerts > 0 ? 'border-danger/50' : 'border-line', dragId === p.id && 'opacity-40', movable && 'cursor-grab')}>
                      <div className="flex items-start gap-1">
                        {movable && <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />}
                        <div className="min-w-0 flex-1">
                          <Link href={`/development/projects/${p.id}`} className="block text-sm font-semibold text-brand-700 hover:underline"><span className="font-mono text-xs">{p.code}</span> {p.name}</Link>
                          <p className="truncate text-xs text-ink-soft">{p.client_name} · {label(FAMILIES, p.family)}</p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        <Badge tone={PRIORITY[p.priority].tone}>{PRIORITY[p.priority].label}</Badge>
                        {p.status !== 'active' && <Badge tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Badge>}
                        {p.pending_validations > 0 && <Badge tone="warning"><Bell className="mr-1 h-3 w-3" />{p.pending_validations} validation(s)</Badge>}
                        {late && <Badge tone="danger"><AlertTriangle className="mr-1 h-3 w-3" />Retard {-d!} j</Badge>}
                        {!late && p.due_date && <Badge tone="neutral">{fmtDay(p.due_date)}</Badge>}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-ink-soft">
                        <span className="truncate">{p.owner_name ?? 'Non affecté'}</span>
                        {movable && (
                          <span className="flex shrink-0 gap-0.5">
                            {stageIndex(p.stage) > 0 && <Button type="button" variant="ghost" size="sm" aria-label={`Reculer ${p.code} à ${stageInfo(STAGES[stageIndex(p.stage) - 1].id).label}`} disabled={pending} onClick={() => setBack({ id: p.id, to: STAGES[stageIndex(p.stage) - 1].id, code: p.code })}><ArrowLeft className="h-3.5 w-3.5" /></Button>}
                            {nxt && <Button type="button" variant="ghost" size="sm" aria-label={`Avancer ${p.code} à ${stageInfo(nxt).label}`} disabled={pending} onClick={() => move(p.id, nxt)}><ArrowRight className="h-3.5 w-3.5" /></Button>}
                          </span>
                        )}
                      </div>
                    </li>
                  )
                })}
                {list.length === 0 && <li className="px-2 py-6 text-center text-xs text-ink-faint">Aucun projet</li>}
              </ul>
            </section>
          )
        })}
      </div>
      <Dialog open={back !== null} onClose={() => setBack(null)} title={back ? `Revenir à « ${stageInfo(back.to).label} » — ${back.code}` : ''}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (back) move(back.id, back.to, reason) }}>
          <label htmlFor="kb-reason" className="block text-sm font-semibold">Motif du retour en arrière * (tracé dans l’historique)</label>
          <Textarea id="kb-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setBack(null)}>Annuler</Button><Button type="submit" variant="danger" disabled={pending || reason.trim().length < 3}>Revenir</Button></div>
        </form>
      </Dialog>
    </div>
  )
}

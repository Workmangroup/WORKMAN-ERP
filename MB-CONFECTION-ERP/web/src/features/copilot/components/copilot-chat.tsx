'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowUp, CheckCircle2, Download, Info, MessageSquarePlus, OctagonAlert, Sparkles, Trash2, TrendingUp, ArrowRight } from 'lucide-react'
import { BarChart, LineChart } from '@/features/executive/components/charts'
import { SUGGESTED_QUESTIONS } from '../engine/intents'
import type { CopilotAnswer } from '../engine/answer'
import { answerToPrintHtml } from '../engine/export'
import { askCopilotAction, deleteConversationAction } from '../actions'
import type { ConversationRow, MessageRow } from '../services/history.service'
import { cn, formatDateTime } from '@/lib/utils'

type Payload = CopilotAnswer & { intent?: string }
type Msg = { key: string; role: 'user' | 'assistant'; content: string; payload?: Payload | null; at?: string }

const SEV_ICON = { critical: OctagonAlert, warning: AlertTriangle, info: Info } as const
const SEV_CLASS = {
  critical: 'border-danger/30 bg-danger-bg/70 text-danger-text',
  warning: 'border-warn/30 bg-warn-bg/70 text-warn-text',
  info: 'border-brand-200 bg-brand-50/70 text-brand-700',
} as const
const TONE: Record<string, string> = { neutral: 'text-ink', success: 'text-success-text', warning: 'text-warn-text', danger: 'text-danger-text' }

/** Verre dépoli : fond translucide, flou, bordure fine. Utilisé par toutes les surfaces du copilote. */
const GLASS = 'bg-surface/70 backdrop-blur-xl border border-line/70 shadow-[0_8px_30px_-12px_rgba(15,27,45,0.25)]'

function Mesh() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-brand-300/30 blur-3xl" />
      <div className="absolute -bottom-48 right-0 h-[30rem] w-[30rem] rounded-full bg-chart-2/20 blur-3xl" />
      <div className="absolute left-1/3 top-1/4 h-64 w-64 rounded-full bg-chart-5/15 blur-3xl" />
    </div>
  )
}

/** Carte intelligente : indicateur clé, survol léger. */
function SmartCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="group rounded-2xl border border-line/70 bg-surface/80 p-3 transition duration-200 hover:-translate-y-0.5 hover:shadow-card motion-reduce:transform-none">
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={cn('mt-0.5 text-lg font-semibold tabular-nums', TONE[tone ?? 'neutral'])}>{value}</p>
    </div>
  )
}

function AnswerView({ p }: { p: Payload }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-brand-600" aria-hidden />
        <p className="font-semibold tracking-tight">{p.title}</p>
      </div>
      <div className="space-y-1.5 text-sm leading-relaxed">{p.text.map((t, i) => <p key={i}>{t}</p>)}</div>

      {p.cards && p.cards.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {p.cards.map((c) => <SmartCard key={c.label} label={c.label} value={c.value} tone={c.tone} />)}
        </div>
      )}

      {p.chart && (
        <div className="rounded-2xl border border-line/70 bg-surface/80 p-3">
          <p className="mb-1 text-xs font-semibold text-ink-soft">{p.chart.title}</p>
          {p.chart.kind === 'bar'
            ? <BarChart label={p.chart.title} data={p.chart.points.map((x) => ({ key: x.label, label: x.label, value: x.value }))} />
            : <LineChart label={p.chart.title} points={p.chart.points} />}
        </div>
      )}

      {p.table && p.table.rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-line/70 bg-surface/80">
          <table className="w-full min-w-[30rem] text-sm">
            <thead className="border-b border-line/70 text-left text-xs text-ink-soft"><tr>{p.table.columns.map((c) => <th key={c} className="px-3 py-2 font-semibold">{c}</th>)}</tr></thead>
            <tbody className="divide-y divide-line/60">{p.table.rows.map((r, i) => <tr key={i} className="transition-colors hover:bg-brand-50/50">{r.map((cell, j) => <td key={j} className="px-3 py-2 tabular-nums">{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}

      {p.alerts && p.alerts.length > 0 && (
        <ul className="space-y-1.5">
          {p.alerts.map((a, i) => {
            const Icon = SEV_ICON[a.severity]
            const body = <span className="flex items-start gap-2"><Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span>{a.text}</span></span>
            return <li key={i} className={cn('rounded-xl border px-3 py-2 text-sm', SEV_CLASS[a.severity])}>{a.href ? <Link href={a.href} className="hover:underline">{body}</Link> : body}</li>
          })}
        </ul>
      )}

      {p.recommendations && p.recommendations.length > 0 && (
        <div className="rounded-2xl border border-brand-200/70 bg-gradient-to-br from-brand-50/80 to-surface/60 p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Actions recommandées</p>
          <ul className="space-y-2">
            {p.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {p.links && p.links.length > 0 && (
        <div className="flex flex-wrap gap-2 text-sm">
          {p.links.map((l) => (
            <Link key={l.href + l.label} href={l.href} className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-surface/80 px-3 py-1 text-brand-700 transition hover:bg-brand-50">
              {l.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ))}
        </div>
      )}

      {p.sources.length > 0 && <p className="text-[11px] text-ink-faint">Sources : {p.sources.join(' · ')}</p>}
    </div>
  )
}

export function CopilotChat({ conversations, messages, activeId }: { conversations: ConversationRow[]; messages: MessageRow[]; activeId: string | null }) {
  const router = useRouter()
  const [list, setList] = useState<ConversationRow[]>(conversations)
  const [msgs, setMsgs] = useState<Msg[]>(() => messages.map((m) => ({ key: m.id, role: m.role, content: m.content, payload: m.payload, at: m.created_at })))
  const [convId, setConvId] = useState<string | null>(activeId)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [msgs, pending])

  const send = (text: string) => {
    const q = text.trim()
    if (q.length < 2 || pending) return
    setError(null)
    setInput('')
    const tmp = `tmp-${Date.now()}`
    setMsgs((m) => [...m, { key: tmp, role: 'user', content: q }, { key: `${tmp}-wait`, role: 'assistant', content: '…' }])
    startTransition(async () => {
      const r = await askCopilotAction(convId, q)
      setMsgs((m) => m.filter((x) => x.key !== `${tmp}-wait`))
      if (!r.ok) {
        setError(r.message)
        setMsgs((m) => m.filter((x) => x.key !== tmp))
        setInput(q)
        return
      }
      setMsgs((m) => [...m, { key: `${tmp}-a`, role: 'assistant', content: r.assistant.content, payload: r.assistant.payload, at: new Date().toISOString() }])
      if (!convId) {
        setConvId(r.conversationId)
        setList((l) => [{ id: r.conversationId, title: r.title, updated_at: new Date().toISOString() }, ...l])
        router.replace(`/copilot?c=${r.conversationId}`)
      } else {
        setList((l) => [{ id: r.conversationId, title: l.find((x) => x.id === r.conversationId)?.title ?? r.title, updated_at: new Date().toISOString() }, ...l.filter((x) => x.id !== r.conversationId)])
      }
    })
  }

  const remove = async (id: string) => {
    if (!window.confirm('Supprimer cette conversation ?')) return
    const r = await deleteConversationAction(id)
    if (!r.ok) { setError(r.message ?? 'Suppression impossible.'); return }
    setList((l) => l.filter((x) => x.id !== id))
    if (convId === id) { setConvId(null); setMsgs([]); router.replace('/copilot') }
  }

  const newChat = () => { setConvId(null); setMsgs([]); setError(null); router.replace('/copilot') }

  /** Export PDF : document imprimable de la réponse, avec la question qui l'a produite. */
  const exportPdf = (idx: number) => {
    const answer = msgs[idx]?.payload
    if (!answer) return
    const question = [...msgs.slice(0, idx)].reverse().find((m) => m.role === 'user')?.content ?? ''
    const w = window.open('', '_blank', 'width=900,height=1000')
    if (!w) { setError('La fenêtre d’impression a été bloquée par le navigateur.'); return }
    w.document.open()
    w.document.write(answerToPrintHtml(answer, question, formatDateTime(new Date().toISOString())))
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <div className="relative flex h-[calc(100vh-3rem)] min-h-[32rem] overflow-hidden">
      <Mesh />

      <aside className={cn('hidden w-64 shrink-0 flex-col border-r border-line/70 bg-surface/60 backdrop-blur-xl md:flex')} aria-label="Historique des conversations">
        <div className="p-3">
          <button type="button" onClick={newChat} className="flex w-full items-center gap-2 rounded-xl bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-card transition hover:bg-brand-700">
            <MessageSquarePlus className="h-4 w-4" aria-hidden /> Nouvelle conversation
          </button>
        </div>
        <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Historique</p>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {list.length === 0 && <li className="px-2 py-2 text-sm text-ink-soft">Aucune conversation.</li>}
          {list.map((c) => (
            <li key={c.id} className={cn('group flex items-center gap-1 rounded-xl px-2 py-2 transition', convId === c.id ? 'bg-surface shadow-card' : 'hover:bg-surface/70')}>
              <Link href={`/copilot?c=${c.id}`} className="min-w-0 flex-1 truncate text-sm" aria-current={convId === c.id ? 'page' : undefined}>{c.title}</Link>
              <button type="button" onClick={() => void remove(c.id)} aria-label={`Supprimer « ${c.title} »`} className="opacity-0 transition group-hover:opacity-100 focus:opacity-100">
                <Trash2 className="h-3.5 w-3.5 text-ink-soft hover:text-danger-text" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
        <header className={cn('mx-3 mt-3 flex items-center gap-3 rounded-2xl px-4 py-3', GLASS)}>
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-card"><Sparkles className="h-4 w-4" aria-hidden /></span>
          <div>
            <p className="text-sm font-semibold">WORKMAN ERP 360 Copilot IA</p>
            <p className="text-xs text-ink-soft">Réponses calculées sur les données de votre société, selon vos droits.</p>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {msgs.length === 0 && (
              <div className="mb-enter pt-6 text-center">
                <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-card"><Sparkles className="h-7 w-7" aria-hidden /></span>
                <p className="mt-4 text-2xl font-semibold tracking-tight">Que voulez-vous savoir ?</p>
                <p className="mt-1 text-sm text-ink-soft">Posez une question sur vos clients, produits, achats, production, qualité ou finance.</p>
                <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                  {SUGGESTED_QUESTIONS.map((s, i) => (
                    <button key={s} type="button" onClick={() => send(s)} style={{ animationDelay: `${i * 40}ms` }}
                      className={cn('mb-enter rounded-2xl px-4 py-3.5 text-left text-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-card motion-reduce:transform-none', GLASS)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {msgs.map((m, idx) => m.role === 'user' ? (
              <div key={m.key} className="mb-enter flex justify-end">
                <p className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-brand-600 to-brand-700 px-4 py-2.5 text-sm text-white shadow-card">{m.content}</p>
              </div>
            ) : (
              <div key={m.key} className="mb-enter flex gap-3">
                <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-card"><Sparkles className="h-4 w-4" aria-hidden /></span>
                <div className={cn('min-w-0 flex-1 rounded-2xl rounded-bl-md p-5', GLASS)}>
                  {m.payload && m.content !== '…' ? (
                    <>
                      <AnswerView p={m.payload} />
                      {m.payload.followUps && m.payload.followUps.length > 0 && (
                        <div className="mt-4 flex flex-wrap gap-2 border-t border-line/60 pt-3">
                          <span className="w-full text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Pour aller plus loin</span>
                          {m.payload.followUps.map((f) => (
                            <button key={f} type="button" onClick={() => send(f)} disabled={pending}
                              className="rounded-full border border-line-strong bg-surface/80 px-3 py-1 text-xs text-ink-soft transition hover:border-brand-300 hover:text-brand-700 disabled:opacity-50">{f}</button>
                          ))}
                        </div>
                      )}
                      <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-ink-faint">
                        <span>{m.at ? formatDateTime(m.at) : ''}</span>
                        <button type="button" onClick={() => exportPdf(idx)} className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface/80 px-2.5 py-1 text-xs text-ink-soft transition hover:text-ink">
                          <Download className="h-3.5 w-3.5" aria-hidden /> Exporter en PDF
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 py-1 text-sm text-ink-soft" aria-live="polite">
                      <span className="mb-dot h-1.5 w-1.5 rounded-full bg-brand-500" />
                      <span className="mb-dot h-1.5 w-1.5 rounded-full bg-brand-500" />
                      <span className="mb-dot h-1.5 w-1.5 rounded-full bg-brand-500" />
                      <span className="ml-1">Analyse des données…</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>

        <div className="px-4 pb-4 pt-2">
          {error && <p role="alert" className="mx-auto mb-2 max-w-3xl text-sm text-danger-text">{error}</p>}
          <form className={cn('mx-auto flex max-w-3xl items-end gap-2 rounded-3xl p-2 pl-4 transition focus-within:ring-2 focus-within:ring-brand-400/60', GLASS)} onSubmit={(e) => { e.preventDefault(); send(input) }}>
            <label htmlFor="copilot-input" className="sr-only">Votre question</label>
            <textarea id="copilot-input" rows={1} value={input} maxLength={1000} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
              placeholder="Posez votre question…" className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent py-2 text-sm placeholder:text-ink-faint focus:outline-none" />
            <button type="submit" disabled={pending || input.trim().length < 2} aria-label="Envoyer"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white shadow-card transition hover:bg-brand-700 disabled:opacity-40">
              <ArrowUp className="h-5 w-5" aria-hidden />
            </button>
          </form>
          <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-ink-faint">Les réponses sont calculées à partir des données enregistrées ; elles ne remplacent pas un avis comptable.</p>
        </div>
      </section>
    </div>
  )
}

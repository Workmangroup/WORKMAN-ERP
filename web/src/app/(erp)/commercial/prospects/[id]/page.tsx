import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, FilePlus2, Pencil, UserCheck } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { convertProspectAction } from '@/features/commercial/actions'
import { ActivityForm, ProspectForm, StageSelect } from '@/features/commercial/components/prospect-forms'
import { getProspect, listSalesReps } from '@/features/commercial/services/commercial.service'
import { LeadPanel, type LeadDuplicate, type LeadTask } from '@/features/commercial/components/lead-panel'
import { createClient } from '@/lib/supabase/server'
import { QUOTE_STATUS, SOURCES, STAGE_INFO, fmtDay, money } from '@/features/commercial/status'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Prospect' }
const KIND: Record<string, string> = { call: 'Appel', email: 'E-mail', meeting: 'Rendez-vous', note: 'Note' }
const FLASH: Record<string, string> = { created: 'Prospect créé.', updated: 'Modifications enregistrées.' }

export default async function ProspectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePermission(P.PROSPECTS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const data = await getProspect(id)
  if (!data) notFound()
  const { prospect: p, activities, quotes } = data
  const supabase = await createClient()
  const canConvert = ctx.permissions.includes(P.CLIENTS_WRITE)
  const [owners, dupRes, taskRes, ...consentRes] = await Promise.all([
    listSalesReps().catch(() => []),
    supabase.rpc('prospect_duplicates', { p_prospect: id }),
    supabase.from('prospect_tasks').select('id,title,due_on,status').eq('prospect_id', id).order('due_on'),
    ...['commercial_prospection', 'phone_contact', 'email_marketing'].map((purpose) => supabase.rpc('prospect_consent_status', { p_prospect: id, p_purpose: purpose })),
  ])
  const duplicates = (dupRes.data ?? []) as LeadDuplicate[]
  const tasks = (taskRes.data ?? []) as LeadTask[]
  const consents = Object.fromEntries(['commercial_prospection', 'phone_contact', 'email_marketing'].map((k, i) => [k, String(consentRes[i]?.data ?? 'unknown')]))
  const canWrite = ctx.permissions.includes(P.PROSPECTS_WRITE)
  const closed = p.stage === 'won' || p.stage === 'lost'
  const flash = Object.keys(FLASH).find((k) => sp[k])
  if (sp.edit && canWrite && !closed) {
    const owners = await listSalesReps()
    return (
      <>
        <PageHeader title={`Modifier ${p.company_name}`} actions={<Link href={`/commercial/prospects/${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Fiche prospect</Link>} />
        <div className="mx-auto max-w-3xl p-4 sm:p-6"><ProspectForm prospect={p} owners={owners} /></div>
      </>
    )
  }
  return (
    <>
      <PageHeader title={`${p.company_name}`} description={`${p.code}${p.contact_name ? ` · ${p.contact_name}` : ''}${p.country ? ` · ${p.country}` : ''}`}
        actions={<>
          <Link href="/commercial/prospects" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Prospects</Link>
          {canWrite && !closed && <Link href={`/commercial/prospects/${id}?edit=1`} className={buttonVariants({ variant: 'command', size: 'sm' })}><Pencil className="h-4 w-4" /> Modifier</Link>}
          {ctx.permissions.includes(P.QUOTES_WRITE) && !closed && <Link href={`/commercial/quotes/new?party=p:${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}><FilePlus2 className="h-4 w-4" /> Créer un devis</Link>}
          {canWrite && !closed && ctx.permissions.includes(P.CLIENTS_WRITE) && <RpcButton action={convertProspectAction} fields={{ id }} variant="command" size="sm" confirm="Convertir ce prospect en client ? La fiche client sera créée et les devis rattachés."><UserCheck className="h-4 w-4" /> Convertir en client</RpcButton>}
        </>} />
      <div className="space-y-4 p-4 sm:p-6">
        {flash && <Alert tone="success">{FLASH[flash]}</Alert>}
        {p.stage === 'won' && p.converted_client_id && <Alert tone="success">Prospect gagné : <Link href={`/clients/${p.converted_client_id}`} className="font-semibold underline">ouvrir la fiche client</Link>.</Alert>}
        {p.stage === 'lost' && <Alert tone="warning">Prospect perdu{p.lost_reason ? ` — « ${p.lost_reason} »` : ''}.</Alert>}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <section className="space-y-3 rounded-md border border-line bg-white p-4 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2"><Badge tone={STAGE_INFO[p.stage].tone}>{STAGE_INFO[p.stage].label}</Badge>{canWrite && !closed && <StageSelect id={p.id} stage={p.stage} />}</div>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-ink-soft">Valeur estimée</dt><dd className="font-semibold tabular-nums">{money(p.est_value)}</dd>
              <dt className="text-ink-soft">Signature espérée</dt><dd>{fmtDay(p.expected_close)}</dd>
              <dt className="text-ink-soft">Commercial</dt><dd>{p.owner ?? '—'}</dd>
              <dt className="text-ink-soft">Origine</dt><dd>{SOURCES.find((s) => s.value === p.source)?.label}</dd>
              <dt className="text-ink-soft">E-mail</dt><dd>{p.email ?? '—'}</dd><dt className="text-ink-soft">Téléphone</dt><dd>{p.phone ?? '—'}</dd><dt className="text-ink-soft">Ville</dt><dd>{p.city ?? '—'}</dd>
              <dt className="text-ink-soft">Prochaine action</dt><dd>{p.next_action ? `${p.next_action} (${fmtDay(p.next_action_date)})` : '—'}</dd>
            </dl>
            {p.notes && <p className="whitespace-pre-wrap rounded-sm bg-canvas p-3 text-sm">{p.notes}</p>}
          </section>
          <div className="space-y-4">
            <LeadPanel id={id} canWrite={canWrite} canConvert={canConvert} closed={closed} owner={p.owner_id ?? null} owners={owners}
              duplicates={duplicates} tasks={tasks} consents={consents} />
            <section className="rounded-md border border-line bg-white shadow-card">
              <div className="border-b border-line px-4 py-2.5"><h2 className="text-sm font-semibold">Devis</h2></div>
              {quotes.length === 0 ? <p className="p-4 text-sm text-ink-soft">Aucun devis.</p> : (
                <ul className="divide-y divide-line">{quotes.map((q) => <li key={q.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm"><Link href={`/commercial/quotes/${q.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{q.code}</Link><span className="tabular-nums">{money(q.total, q.currency)}</span><Badge tone={QUOTE_STATUS[q.status as keyof typeof QUOTE_STATUS].tone}>{QUOTE_STATUS[q.status as keyof typeof QUOTE_STATUS].label}</Badge></li>)}</ul>
              )}
            </section>
            <section className="rounded-md border border-line bg-white shadow-card">
              <div className="border-b border-line px-4 py-2.5"><h2 className="text-sm font-semibold">Historique des échanges</h2></div>
              {canWrite && <ActivityForm prospectId={p.id} />}
              {activities.length === 0 ? <p className="p-4 text-sm text-ink-soft">Aucune activité enregistrée.</p> : (
                <ul className="divide-y divide-line">{activities.map((a) => <li key={a.id} className="px-4 py-2 text-sm"><p><Badge>{KIND[a.kind]}</Badge> <span className="ml-1">{a.summary}</span></p><p className="mt-0.5 text-xs text-ink-faint">{formatDateTime(a.happened_at)}{a.by ? ` · ${a.by}` : ''}</p></li>)}</ul>
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  )
}

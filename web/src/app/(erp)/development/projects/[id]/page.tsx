import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Check, Circle, Pencil } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getClientLite } from '@/features/articles/services/articles.service'
import { directoryByIds } from '@/features/clients/services/clients.service'
import { listFolders } from '@/features/ged/services/ged.service'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { AlertsList } from '@/features/development/components/alerts-list'
import { DevDocumentsPanel } from '@/features/development/components/documents-panel'
import { ExchangesPanel } from '@/features/development/components/exchanges-panel'
import { IndustrializationPanel } from '@/features/development/components/industrialization-panel'
import { ProjectControls } from '@/features/development/components/project-controls'
import { PrototypesPanel } from '@/features/development/components/prototypes-panel'
import { SamplesPanel } from '@/features/development/components/samples-panel'
import { StageStepper } from '@/features/development/components/stage-stepper'
import { DevTimeline } from '@/features/development/components/timeline'
import { ValidationsPanel } from '@/features/development/components/validations-panel'
import {
  bomChoices, getAlerts, getIndustrialization, getProject, linkableDocuments, linkedProduct, listCosts, listExchanges, listProjectDocuments, listPrototypes, listSamples, listValidations, ownerOptions,
} from '@/features/development/services/development.service'
import { formatMoney } from '@/lib/bom/options'
import { FAMILIES, GATES, PRIORITY, PROJECT_STATUS, daysUntil, label, nextStage, stageInfo } from '@/lib/development/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'
import { fmtDay } from '@/features/orders/status'

export const metadata: Metadata = { title: 'Projet de développement' }

const TABS = [
  { id: 'overview', label: 'Vue d’ensemble' }, { id: 'prototypes', label: 'Prototypes' }, { id: 'samples', label: 'Échantillons' }, { id: 'validations', label: 'Validations client' },
  { id: 'industrialization', label: 'Industrialisation' }, { id: 'exchanges', label: 'Échanges' }, { id: 'documents', label: 'Pièces jointes (GED)' }, { id: 'history', label: 'Historique' },
] as const
type TabId = (typeof TABS)[number]['id']
const FLASH: Record<string, string> = { created: 'Projet créé à l’étape « Demande client ». Qualifiez la demande puis passez à l’étape suivante.', updated: 'Modifications enregistrées.' }

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePermission(P.DEVELOPMENT_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const tab = (TABS.find((t) => t.id === sp.tab)?.id ?? 'overview') as TabId
  const project = await getProject(id)
  if (!project) notFound()

  const perms = ctx.permissions
  const canWrite = perms.includes(P.DEVELOPMENT_WRITE)
  const canCosts = perms.includes(P.DEVELOPMENT_COSTS)
  const canSeeCosts = canCosts || perms.includes(P.COSTS_READ)
  const canDocs = perms.includes(P.DOCUMENTS_READ)
  const [client, prototypes, samples, validations, ind, owners, product, allAlerts] = await Promise.all([
    getClientLite(project.client_id), listPrototypes(id), listSamples(id), listValidations(id), getIndustrialization(id), ownerOptions(), linkedProduct(project.product_id), getAlerts(),
  ])
  const costs = canSeeCosts && (tab === 'overview' || tab === 'prototypes') ? await listCosts(id) : []
  const exchanges = tab === 'exchanges' || tab === 'overview' ? await listExchanges(id) : []
  const docs = tab === 'documents' && canDocs ? await listProjectDocuments(id) : []
  const folders = tab === 'documents' && canDocs ? await listFolders(project.client_id) : []
  const open = project.status === 'active' || project.status === 'on_hold'
  const editable = canWrite && !(client?.archived_at) && open
  const [linkable, boms] = await Promise.all([
    tab === 'documents' && canDocs && canWrite ? linkableDocuments(project.client_id, id) : Promise.resolve([]),
    tab === 'industrialization' && ind && editable ? bomChoices(project.client_id) : Promise.resolve([]),
  ])
  const history = tab === 'history' ? await recentAuditFor('dev_project', id, 200) : tab === 'overview' ? await recentAuditFor('dev_project', id, 6) : []
  const users = await directoryByIds([...exchanges.map((e) => e.created_by), ...history.map((h) => h.actor_id)].filter(Boolean) as string[])
  const authors = Object.fromEntries([...users.entries()].map(([k, u]) => [k, u.full_name || u.email]))
  const ownerName = owners.find((o) => o.id === project.owner_id)?.name
  const alerts = allAlerts.filter((a) => a.project_id === id)
  const d = daysUntil(project.due_date)
  const late = project.status === 'active' && project.stage !== 'production' && d !== null && d < 0
  const flash = Object.keys(FLASH).find((k) => sp[k])
  const nxt = nextStage(project.stage)

  // Prérequis de l'étape en cours (reprend les portes de contrôle de la base)
  const lastBat = validations.filter((v) => v.kind === 'bat').sort((a, b) => b.version_no - a.version_no)[0]
  const gateOk: Record<string, boolean | null> = {
    request: true, project: true,
    prototype: prototypes.some((p) => p.status === 'approved'),
    sample: samples.some((s) => s.status === 'approved'),
    bat: validations.some((v) => v.kind === 'bat'),
    validation: lastBat?.status === 'approved',
    industrialization: ind?.status === 'ready' && (!product || product.validated),
    production: null,
  }
  const gateText = { ...GATES, production: 'Dernière étape : le projet peut être terminé.' } as Record<string, string>
  const protoCost = costs.reduce((a, c) => a + c.amount, 0)
  const pendingV = validations.filter((v) => v.status === 'pending')

  return (
    <>
      <PageHeader title={`${project.code} — ${project.name}`} description={`${client?.name ?? ''} · ${label(FAMILIES, project.family)}`}
        actions={<>
          <Link href="/development/projects" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Projets</Link>
          {client && <Link href={`/clients/${client.id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Client</Link>}
          {editable && <Link href={`/development/projects/${id}/edit`} className={buttonVariants({ variant: 'command', size: 'sm' })}><Pencil className="h-4 w-4" /> Modifier</Link>}
          <ProjectControls id={id} stage={project.stage} status={project.status} canWrite={canWrite && !client?.archived_at} />
        </>} />

      <div className="space-y-4 p-4 sm:p-6">
        {flash && <Alert tone="success">{FLASH[flash]}</Alert>}
        {project.status === 'on_hold' && <Alert tone="warning">Projet en pause{project.hold_reason ? ` — « ${project.hold_reason} »` : ''}. Reprenez-le pour continuer.</Alert>}
        {project.status === 'cancelled' && <Alert tone="warning">Projet annulé le {fmtDay(project.closed_at)}{project.hold_reason ? ` — « ${project.hold_reason} »` : ''} : lecture seule.</Alert>}
        {project.status === 'completed' && <Alert tone="info">Projet terminé le {fmtDay(project.closed_at)} : lecture seule (échanges et pièces jointes restent possibles).</Alert>}
        {client?.archived_at && <Alert tone="warning">Client archivé : le projet est en lecture seule.</Alert>}

        <Card><CardContent className="pt-5"><StageStepper stage={project.stage} dim={!open} /></CardContent></Card>

        <nav aria-label="Sections du projet" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {TABS.filter((t) => canDocs || t.id !== 'documents').map((t) => (
            <Link key={t.id} href={t.id === 'overview' ? `/development/projects/${id}` : `/development/projects/${id}?tab=${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
              {t.label}
              {t.id === 'prototypes' && prototypes.length > 0 && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{prototypes.length}</span>}
              {t.id === 'samples' && samples.length > 0 && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{samples.length}</span>}
              {t.id === 'validations' && pendingV.length > 0 && <span className="ml-1.5 rounded-full bg-warn/15 px-1.5 text-xs text-warn-text">{pendingV.length}</span>}
            </Link>
          ))}
        </nav>

        {tab === 'overview' && (
          <div className="space-y-4">
            {alerts.length > 0 && <section aria-label="Alertes du projet"><AlertsList alerts={alerts} canWrite={canWrite} /></section>}
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader><CardTitle>Projet</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="brand">{stageInfo(project.stage).label}</Badge><Badge tone={PROJECT_STATUS[project.status].tone}>{PROJECT_STATUS[project.status].label}</Badge><Badge tone={PRIORITY[project.priority].tone}>Priorité {PRIORITY[project.priority].label.toLowerCase()}</Badge>
                    {late && <Badge tone="danger">En retard de {-d!} j</Badge>}
                  </div>
                  <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                    <dt className="text-ink-soft">Client</dt><dd className="font-medium">{client ? <Link href={`/clients/${client.id}`} className="text-brand-700 hover:underline">{client.name}</Link> : '—'}</dd>
                    <dt className="text-ink-soft">Responsable</dt><dd className="font-medium">{ownerName ?? 'Non affecté'}</dd>
                    <dt className="text-ink-soft">Demande reçue le</dt><dd>{fmtDay(project.requested_on)}</dd>
                    <dt className="text-ink-soft">Échéance</dt><dd className={late ? 'font-semibold text-danger-text' : ''}>{fmtDay(project.due_date)}</dd>
                    <dt className="text-ink-soft">Série visée</dt><dd>{project.target_qty ? `${project.target_qty} pièces` : '—'}</dd>
                    <dt className="text-ink-soft">Dans l’étape depuis</dt><dd>{formatDateTime(project.stage_changed_at)}</dd>
                    {product && <><dt className="text-ink-soft">Fiche produit (PDM)</dt><dd>{perms.includes(P.PRODUCTS_READ) ? <Link href={`/products/${product.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{product.code}</Link> : <span className="font-mono">{product.code}</span>} <span className="text-xs text-ink-soft">{product.validated ? 'version validée' : 'sans version validée'}</span></dd></>}
                    {canSeeCosts && <><dt className="text-ink-soft">Coût des prototypes</dt><dd className="font-semibold tabular-nums">{formatMoney(protoCost)}</dd></>}
                  </dl>
                  {project.description && <p className="whitespace-pre-wrap rounded-sm bg-canvas p-3 text-sm">{project.description}</p>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>{open && nxt ? `Pour passer à « ${stageInfo(nxt).label} »` : 'Étape actuelle'}</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="flex items-start gap-2">
                    {gateOk[project.stage] === null ? <Circle className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden /> : gateOk[project.stage] ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-text" aria-label="Condition remplie" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-warn-text" aria-label="Condition à remplir" />}
                    <span>{gateText[project.stage]}</span>
                  </p>
                  <p className="text-xs text-ink-soft">{stageInfo(project.stage).hint}</p>
                  <ul className="space-y-1 border-t border-line pt-2 text-xs text-ink-soft">
                    <li>{prototypes.filter((p) => p.status === 'approved').length} / {prototypes.length} prototype(s) approuvé(s)</li>
                    <li>{samples.filter((s) => s.status === 'approved').length} / {samples.length} échantillon(s) approuvé(s)</li>
                    <li>{pendingV.length} validation(s) en attente du client</li>
                    {ind && <li>Industrialisation : {ind.checklist.filter((c) => c.done).length} / {ind.checklist.length} points</li>}
                  </ul>
                </CardContent>
              </Card>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card><CardHeader><CardTitle className="flex items-center justify-between">Derniers échanges<Link href={`/development/projects/${id}?tab=exchanges`} className="text-xs font-normal text-brand-600 hover:underline">Tous</Link></CardTitle></CardHeader>
                <CardContent>{exchanges.length === 0 ? <p className="text-sm text-ink-soft">Aucun échange enregistré.</p> : <ul className="space-y-2 text-sm">{exchanges.slice(0, 4).map((e) => <li key={e.id}><span className="font-medium">{e.subject}</span><span className="block text-xs text-ink-soft">{fmtDay(e.exchanged_on)}{e.contact_name ? ` · ${e.contact_name}` : ''}</span></li>)}</ul>}</CardContent></Card>
              <Card><CardHeader><CardTitle className="flex items-center justify-between">Activité récente<Link href={`/development/projects/${id}?tab=history`} className="text-xs font-normal text-brand-600 hover:underline">Tout l’historique</Link></CardTitle></CardHeader>
                <CardContent><DevTimeline rows={history} /></CardContent></Card>
            </div>
          </div>
        )}

        {tab === 'prototypes' && <PrototypesPanel projectId={id} prototypes={prototypes} costs={costs} canWrite={editable && project.status === 'active'} canCosts={canCosts && open} canSeeCosts={canSeeCosts} owners={owners} />}
        {tab === 'samples' && <SamplesPanel projectId={id} samples={samples} prototypes={prototypes} canWrite={editable && project.status === 'active'} />}
        {tab === 'validations' && <ValidationsPanel projectId={id} stage={project.stage} validations={validations} samples={samples} canWrite={editable && project.status === 'active'} />}
        {tab === 'industrialization' && ind && <IndustrializationPanel projectId={id} ind={ind} boms={boms} product={product} editable={editable} stage={project.stage} />}
        {tab === 'exchanges' && <ExchangesPanel projectId={id} exchanges={exchanges} canWrite={canWrite && !client?.archived_at && project.status !== 'cancelled'} authors={authors} />}
        {tab === 'documents' && canDocs && (
          <DevDocumentsPanel projectId={id} clientId={project.client_id} docs={docs} folders={folders.filter((f) => !f.parent_id).map((f) => ({ id: f.id, label: f.name }))}
            linkable={linkable.map((x) => ({ id: x.id, title: x.title, folder: folders.find((f) => f.id === x.folder_id)?.name ?? '' }))} editable={canWrite && !client?.archived_at} canUpload={perms.includes(P.DOCUMENTS_WRITE)} />
        )}
        {tab === 'history' && <Card><CardHeader><CardTitle>Historique du projet</CardTitle></CardHeader><CardContent><DevTimeline rows={history} /></CardContent></Card>}
      </div>
    </>
  )
}

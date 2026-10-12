import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getArticle, getClientLite } from '@/features/articles/services/articles.service'
import { BomActions } from '@/features/bom/components/bom-actions'
import { CompositionEditor } from '@/features/bom/components/composition-editor'
import { CostsPanel } from '@/features/bom/components/costs-panel'
import { BomHistory } from '@/features/bom/components/history-panel'
import { TreeView } from '@/features/bom/components/tree-view'
import { VersionsPanel, type VersionRow } from '@/features/bom/components/versions-panel'
import { articleOptions, getBom, getCost, getTree, listVersions, materialOptions, parentsOf, subassemblyOptions, versionCostings } from '@/features/bom/services/bom.service'
import { buildItems } from '@/features/bom/tree-model'
import { directoryByIds } from '@/features/clients/services/clients.service'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { BOM_KINDS, BOM_VERSION_STATUS, formatMoney, label } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Nomenclature' }

const ALL_TABS = [
  { id: 'tree', label: 'Arbre' }, { id: 'composition', label: 'Composition' }, { id: 'costs', label: 'Coûts' },
  { id: 'versions', label: 'Versions' }, { id: 'history', label: 'Historique' },
] as const
type TabId = (typeof ALL_TABS)[number]['id']
const FLASH: Record<string, string> = {
  created: 'Nomenclature créée. Ajoutez maintenant les composants et les opérations.',
  duplicated: 'Copie créée (version 1 en brouillon). Ajustez-la puis faites-la valider.',
  updated: 'Modifications enregistrées.',
  archived: 'Nomenclature archivée : elle est désormais en lecture seule.',
  restored: 'Nomenclature restaurée.',
  validated: 'Version validée : le coût de revient est figé.',
}

export default async function BomPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePermission(P.BOM_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams

  const bom = await getBom(id)
  if (!bom) notFound()
  const canWrite = ctx.permissions.includes(P.BOM_WRITE)
  const canValidate = ctx.permissions.includes(P.BOM_VALIDATE)
  const costs = ctx.permissions.includes(P.COSTS_READ)
  const tabs = ALL_TABS.filter((t) => t.id !== 'costs' || costs)
  const tab = (tabs.find((t) => t.id === sp.tab)?.id ?? 'tree') as TabId

  const versions = await listVersions(id)
  const shown = versions.find((v) => v.id === sp.v) ?? versions.find((v) => v.id === bom.active_version_id) ?? versions[0]
  const article = bom.article_id ? await getArticle(bom.article_id) : null
  const client = article ? await getClientLite(article.client_id) : null
  const locked = Boolean(bom.archived_at) || Boolean(client?.archived_at)
  const editable = canWrite && !locked && shown?.status === 'draft'

  const [tree, parents, costings, users] = await Promise.all([
    shown ? getTree(shown.id) : Promise.resolve(null),
    parentsOf(id),
    versionCostings(versions.map((v) => v.id)),
    directoryByIds(versions.flatMap((v) => [v.created_by, v.validated_by])),
  ])
  if (shown && !tree) notFound()
  const root = tree ? buildItems(tree, costs) : null
  const cost = tab === 'costs' && costs && shown ? await getCost(shown.id) : null
  const history = tab === 'history' ? await recentAuditFor('bom', id, 120) : []
  const [materials, subs] = tab === 'composition' && editable ? await Promise.all([materialOptions(), subassemblyOptions(id)]) : [[], []]
  const articles = canWrite && !bom.archived_at ? await articleOptions() : []

  const rows: VersionRow[] = versions.map((v) => ({
    ...v,
    author: v.created_by ? users.get(v.created_by)?.full_name : undefined,
    validator: v.validated_by ? users.get(v.validated_by)?.full_name : undefined,
    summary: v.id === shown?.id && tree ? `${tree.lines.length} ligne(s) · ${tree.operations.length} opération(s)` : 'Ouvrir pour voir le détail',
    frozen_total: costings.get(v.id)?.snap_total ?? null,
  }))
  const flash = Object.keys(FLASH).find((k) => sp[k])
  const cur = shown ? costings.get(shown.id) : undefined
  const qs = (t: TabId) => `/bom/${id}?${new URLSearchParams({ ...(t === 'tree' ? {} : { tab: t }), ...(sp.v ? { v: sp.v } : {}) }).toString()}`.replace(/\?$/, '')

  return (
    <>
      <PageHeader
        title={`${bom.code} — ${bom.name}`}
        description={`${label(BOM_KINDS, bom.kind)}${article ? ` · article ${article.internal_ref} (${article.client_ref})` : ''}${client ? ` · ${client.name}` : ''}`}
        actions={<>
          <Link href="/bom" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Nomenclatures</Link>
          {article && ctx.permissions.includes(P.ARTICLES_READ) && <Link href={`/articles/${article.id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Article</Link>}
          <BomActions id={id} name={bom.name} kind={bom.kind} archived={Boolean(bom.archived_at)} canWrite={canWrite && !client?.archived_at}
            canDelete={canWrite && !versions.some((v) => v.status !== 'draft') && parents.length === 0} articles={articles}
            versions={versions.map((v) => ({ id: v.id, version_no: v.version_no, status: v.status }))} defaultVersion={bom.active_version_id ?? bom.current_version_id} usedBy={parents} />
        </>}
      />

      <div className="space-y-4 p-4 sm:p-6">
        {flash && <Alert tone="success">{FLASH[flash]}</Alert>}
        {sp.restore_failed && <Alert tone="error">Restauration impossible : l’article de cette nomenclature a déjà une nomenclature active.</Alert>}
        {bom.archived_at && <Alert tone="warning">Nomenclature archivée le {formatDateTime(bom.archived_at)}{bom.archive_reason ? ` — « ${bom.archive_reason} »` : ''} : lecture seule.</Alert>}
        {!bom.archived_at && client?.archived_at && <Alert tone="warning">Client archivé : la nomenclature est en lecture seule.</Alert>}

        <div className="flex flex-wrap items-center gap-2 text-sm">
          {bom.active_version_id ? <Badge tone="success">Version validée v{versions.find((v) => v.id === bom.active_version_id)?.version_no}</Badge> : <Badge tone="warning">Aucune version validée</Badge>}
          {shown && shown.id !== bom.active_version_id && (
            <span className="flex items-center gap-2">
              Affichage : <Badge tone={BOM_VERSION_STATUS[shown.status].tone}>v{shown.version_no} {BOM_VERSION_STATUS[shown.status].label.toLowerCase()}</Badge>
              {bom.active_version_id && <Link href={`/bom/${id}${tab === 'tree' ? '' : `?tab=${tab}`}`} className="text-xs text-brand-600 hover:underline">Revenir à la version validée</Link>}
            </span>
          )}
          {parents.length > 0 && <span className="text-xs text-ink-soft">Sous-ensemble de : {parents.map((p, i) => <span key={p.id}>{i > 0 && ', '}<Link href={`/bom/${p.id}`} className="font-mono text-brand-700 hover:underline">{p.code}</Link></span>)}</span>}
          {costs && cur?.snap_total !== null && cur?.snap_total !== undefined && shown?.status !== 'draft' && <span className="ml-auto text-sm">Coût de revient figé : <strong className="tabular-nums">{formatMoney(cur.snap_total)}</strong></span>}
        </div>

        <nav aria-label="Sections de la nomenclature" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {tabs.map((t) => (
            <Link key={t.id} href={qs(t.id)} aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
              {t.label}
              {t.id === 'versions' && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{versions.length}</span>}
            </Link>
          ))}
        </nav>

        {tab === 'tree' && root && tree && (
          <>
            {costs && tree.totals && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {([['Matière', tree.totals.material], ['Main-d’œuvre', tree.totals.labor], ['Frais généraux', tree.totals.overhead], ['Coût de revient', tree.totals.total]] as const).map(([k, v], i) => (
                  <div key={k} className={cn('rounded-md border p-3 shadow-card', i === 3 ? 'border-brand-300 bg-brand-50' : 'border-line bg-white')}>
                    <p className="text-xs text-ink-soft">{k}</p><p className="text-lg font-semibold tabular-nums">{formatMoney(v)}</p>
                  </div>
                ))}
              </div>
            )}
            {costs && tree.totals && tree.totals.missing.length > 0 && <Alert tone="warning">Prix manquant pour : {tree.totals.missing.join(', ')} — le coût est incomplet.</Alert>}
            {tree.lines.length === 0 && tree.operations.length === 0
              ? <Card><CardContent className="py-10 text-center text-sm text-ink-soft">Cette version est vide.{canWrite && !locked ? <> <Link href={qs('composition')} className="text-brand-600 hover:underline">Ajouter des composants</Link></> : null}</CardContent></Card>
              : <TreeView key={shown?.id} root={root} costs={costs} />}
          </>
        )}

        {tab === 'composition' && tree && shown && (
          <>
            {!editable && (
              <Alert tone="info">
                {locked ? 'Lecture seule : nomenclature archivée ou client archivé.' : !canWrite ? 'Vous consultez la composition en lecture seule.' : `La version ${shown.version_no} est ${shown.status === 'validated' ? 'validée' : 'obsolète'} et figée.`}{' '}
                {canWrite && !locked && !versions.some((v) => v.status === 'draft') && <>Créez une nouvelle version pour la modifier (onglet <Link className="underline" href={qs('versions')}>Versions</Link>).</>}
                {canWrite && !locked && versions.some((v) => v.status === 'draft') && <>Un brouillon existe : <Link className="underline" href={`/bom/${id}?tab=composition&v=${versions.find((v) => v.status === 'draft')!.id}`}>le modifier</Link>.</>}
              </Alert>
            )}
            {editable && <Alert tone="info">Brouillon de la version {shown.version_no} : la production continue d’utiliser la version validée tant que ce brouillon n’est pas validé.</Alert>}
            <CompositionEditor bomId={id} versionId={shown.id} tree={tree} materials={materials} subs={subs} costs={costs} editable={editable} />
          </>
        )}

        {tab === 'costs' && costs && (cost && root && tree && shown
          ? <CostsPanel cost={cost} root={root} node={tree} status={shown.status} />
          : <Card><CardHeader><CardTitle>Coûts</CardTitle></CardHeader><CardContent className="text-sm text-ink-soft">Calcul indisponible.</CardContent></Card>)}

        {tab === 'versions' && <VersionsPanel bomId={id} versions={rows} canWrite={canWrite} canValidate={canValidate} locked={locked} activeVersionId={bom.active_version_id} costs={costs} />}
        {tab === 'history' && <Card><CardHeader><CardTitle>Historique</CardTitle></CardHeader><CardContent><BomHistory rows={history} /></CardContent></Card>}
      </div>
    </>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle, ArrowLeft, FileCheck2, FileText, ImageOff, ImageIcon, Layers, Network, Palette, Ruler, Scissors, Tag } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { getClientLite } from '@/features/articles/services/articles.service'
import { TreeView } from '@/features/bom/components/tree-view'
import { buildItems } from '@/features/bom/tree-model'
import { getCost, getTree } from '@/features/bom/services/bom.service'
import { directoryByIds } from '@/features/clients/services/clients.service'
import { listFolders } from '@/features/ged/services/ged.service'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { CertificationsPanel } from '@/features/products/components/certifications-panel'
import { DocumentsPanel } from '@/features/products/components/documents-panel'
import { PhotosPanel } from '@/features/products/components/photos-panel'
import { ProductActions } from '@/features/products/components/product-actions'
import { SpecView } from '@/features/products/components/spec-view'
import { ProductTimeline } from '@/features/products/components/timeline'
import { VersionsPanel, type VersionRow } from '@/features/products/components/versions-panel'
import { articleRef, clientDocOptions, linkableDocuments, listCerts, listPhotos, listProductDocuments, listVersions, productBom, getProduct } from '@/features/products/services/products.service'
import { CERT_STATE_INFO, DOC_KINDS, FAMILIES, PATTERN_KINDS, PRODUCT_STATUS, VERSION_STATUS, certState, label, withSpec } from '@/lib/products/options'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Produit' }

const TABS = [
  { id: 'overview', label: 'Vue 360°' }, { id: 'tech', label: 'Fiche technique' }, { id: 'photos', label: 'Photos' }, { id: 'bom', label: 'Nomenclature' },
  { id: 'patterns', label: 'Patronages' }, { id: 'documents', label: 'Documents (GED)' }, { id: 'certs', label: 'Certifications' }, { id: 'versions', label: 'Versions' }, { id: 'history', label: 'Historique' },
] as const
type TabId = (typeof TABS)[number]['id']
const FLASH: Record<string, string> = {
  created: 'Produit créé. Complétez maintenant la fiche technique de la version 1 (onglet Versions).', updated: 'Modifications enregistrées.', validated: 'Version validée : elle devient la référence du produit.',
  duplicated: 'Produit dupliqué : voici la copie (version 1 en brouillon).',
}

export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePermission(P.PRODUCTS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const tab = (TABS.find((t) => t.id === sp.tab)?.id ?? 'overview') as TabId
  const product = await getProduct(id)
  if (!product) notFound()

  const perms = ctx.permissions
  const canDocs = perms.includes(P.DOCUMENTS_READ)
  const canBom = perms.includes(P.BOM_READ)
  const canCosts = perms.includes(P.COSTS_READ)
  const [client, versions, photos, certs, docs, article, bom] = await Promise.all([
    getClientLite(product.client_id), listVersions(id), listPhotos(id), listCerts(id),
    canDocs ? listProductDocuments(id) : Promise.resolve([]), articleRef(product.article_id), canBom ? productBom(product.article_id) : Promise.resolve(null),
  ])
  const archived = product.status === 'archived'
  const locked = archived || Boolean(client?.archived_at)
  const canWrite = perms.includes(P.PRODUCTS_WRITE)
  const editable = canWrite && !locked
  const history = tab === 'history' ? await recentAuditFor('product', id, 150) : tab === 'overview' ? await recentAuditFor('product', id, 6) : []
  const users = await directoryByIds(versions.flatMap((v) => [v.created_by, v.validated_by]))
  const docTab = tab === 'patterns' || tab === 'documents'
  const [folders, linkable, certDocs] = await Promise.all([
    docTab && canDocs ? listFolders(product.client_id) : Promise.resolve([]),
    docTab && canDocs && editable ? linkableDocuments(product.client_id, id) : Promise.resolve([]),
    tab === 'certs' && canDocs ? clientDocOptions(product.client_id) : Promise.resolve([]),
  ])
  const folderName = new Map(folders.map((f) => [f.id, f.name]))

  const active = versions.find((v) => v.id === product.active_version_id)
  const shown = versions.find((v) => v.id === sp.v) ?? active ?? versions[0]
  const spec = withSpec(shown?.spec)
  const refSpec = withSpec((active ?? versions[0])?.spec)
  const activeVariants = refSpec.variants.filter((v) => v.active !== false).length
  const patternDocs = docs.filter((d) => PATTERN_KINDS.includes(d.kind))
  const otherDocs = docs.filter((d) => !PATTERN_KINDS.includes(d.kind))
  const certStates = certs.map((c) => ({ c, st: certState(c) }))
  const certAlerts = certStates.filter((x) => ['expired', 'expiring', 'suspended', 'revoked'].includes(x.st))
  const mainPhoto = photos.find((p) => p.is_main) ?? photos[0]
  const canDelete = canWrite && product.status === 'draft' && !versions.some((v) => v.status !== 'draft') && !locked
  const flash = Object.keys(FLASH).find((k) => sp[k])
  const draftVersion = versions.find((v) => v.status === 'draft')

  const rows: VersionRow[] = versions.map((v) => {
    const s = withSpec(v.spec)
    return { ...v, spec: s, author: v.created_by ? users.get(v.created_by)?.full_name : undefined, validator: v.validated_by ? users.get(v.validated_by)?.full_name : undefined,
      summary: `${s.colors.length} couleur(s) · ${s.sizes.length} taille(s) · ${s.variants.length} variante(s) · ${s.measurements.length} point(s) de mesure` }
  })

  // Nomenclature : arbre de la version validée (coûts selon costs.read)
  let tree = null
  let live: number | null = null
  if (tab === 'bom' && bom?.active_version_id) {
    const node = await getTree(bom.active_version_id)
    tree = node ? buildItems(node, canCosts) : null
    if (canCosts) live = (await getCost(bom.active_version_id))?.live.total ?? null
  }

  const kpis = [
    { tab: 'tech', label: 'Variantes actives', value: activeVariants, icon: Tag },
    { tab: 'tech', label: 'Coloris', value: refSpec.colors.length, icon: Palette },
    { tab: 'tech', label: 'Tailles', value: refSpec.sizes.length, icon: Ruler },
    { tab: 'photos', label: 'Photos', value: photos.length, icon: ImageIcon },
    { tab: 'patterns', label: 'Patronages', value: canDocs ? patternDocs.length : '—', icon: Scissors },
    { tab: 'documents', label: 'Documents', value: canDocs ? otherDocs.length : '—', icon: FileText },
    { tab: 'certs', label: 'Certifications', value: certs.length, icon: FileCheck2 },
    { tab: 'versions', label: 'Versions', value: versions.length, icon: Layers },
  ] as const

  return (
    <>
      <PageHeader title={`${product.code} — ${product.name}`} description={`${client?.name ?? ''} · ${label(FAMILIES, product.family)}`}
        actions={<>
          <Link href="/products" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Produits</Link>
          {client && <Link href={`/clients/${client.id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Client</Link>}
          {perms.includes(P.VARIANTS_READ) && <Link href={`/variants/${id}`} className={buttonVariants({ variant: 'command', size: 'sm' })}>Matrice des variantes</Link>}
          <ProductActions id={id} code={product.code} name={product.name} status={product.status} canWrite={canWrite && !client?.archived_at} canArchive={perms.includes(P.PRODUCTS_ARCHIVE) && !client?.archived_at} canDelete={canDelete} />
        </>} />

      <div className="space-y-4 p-4 sm:p-6">
        {flash && <Alert tone="success">{FLASH[flash]}</Alert>}
        {archived && <Alert tone="warning">Produit archivé{product.archived_at ? ` le ${formatDateTime(product.archived_at)}` : ''}{product.archive_reason ? ` — « ${product.archive_reason} »` : ''} : lecture seule. Tout l’historique est conservé.</Alert>}
        {client?.archived_at && !archived && <Alert tone="warning">Client archivé : le produit est en lecture seule.</Alert>}
        {certAlerts.length > 0 && !archived && (
          <Alert tone="warning"><AlertTriangle className="mr-1 inline h-4 w-4" />{certAlerts.length} certification(s) à traiter : {certAlerts.map((x) => `${x.c.standard_code} (${CERT_STATE_INFO[x.st].label.toLowerCase()})`).join(', ')}. <Link className="underline" href={`/products/${id}?tab=certs`}>Voir les certifications</Link></Alert>
        )}

        <nav aria-label="Sections du produit" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {TABS.filter((t) => (canDocs || (t.id !== 'documents' && t.id !== 'patterns')) && (canBom || t.id !== 'bom')).map((t) => (
            <Link key={t.id} href={t.id === 'overview' ? `/products/${id}` : `/products/${id}?tab=${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
              {t.label}
              {t.id === 'photos' && photos.length > 0 && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{photos.length}</span>}
              {t.id === 'patterns' && patternDocs.length > 0 && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{patternDocs.length}</span>}
              {t.id === 'documents' && otherDocs.length > 0 && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{otherDocs.length}</span>}
              {t.id === 'certs' && certs.length > 0 && <span className={cn('ml-1.5 rounded-full px-1.5 text-xs', certAlerts.length ? 'bg-warn/15 text-warn-text' : 'bg-canvas')}>{certs.length}</span>}
              {t.id === 'versions' && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{versions.length}</span>}
            </Link>
          ))}
        </nav>

        {tab === 'overview' && (
          <div className="space-y-4">
            <Card>
              <CardContent className="flex flex-col gap-4 sm:flex-row">
                <div className="flex h-52 w-40 shrink-0 items-center justify-center self-center overflow-hidden rounded-md bg-canvas sm:self-start">
                  {mainPhoto ? (
                    // eslint-disable-next-line
                    <img src={`/products/photo/${mainPhoto.id}`} alt={`Photo de ${product.code}`} className="h-full w-full object-cover" />
                  ) : <ImageOff className="h-8 w-8 text-line-strong" aria-label="Pas de photo" />}
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={PRODUCT_STATUS[product.status].tone}>{PRODUCT_STATUS[product.status].label}</Badge>
                    {active ? <Badge tone="brand">Référence : version {active.version_no}</Badge> : <Badge tone="warning">Aucune version validée</Badge>}
                    {draftVersion && draftVersion.version_no > 1 && <Badge tone="warning">Brouillon v{draftVersion.version_no} en cours</Badge>}
                  </div>
                  <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                    <dt className="text-ink-soft">Code produit</dt><dd className="font-mono font-semibold">{product.code}</dd>
                    <dt className="text-ink-soft">Client</dt><dd className="font-medium">{client ? <Link href={`/clients/${client.id}`} className="text-brand-700 hover:underline">{client.name}</Link> : '—'}</dd>
                    <dt className="text-ink-soft">Famille</dt><dd className="font-medium">{label(FAMILIES, product.family)}</dd>
                    <dt className="text-ink-soft">Article client</dt><dd>{article ? (perms.includes(P.ARTICLES_READ) ? <Link href={`/articles/${article.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{article.internal_ref}</Link> : <span className="font-mono">{article.internal_ref}</span>) : <span className="text-ink-faint">non lié</span>}</dd>
                    {canBom && <><dt className="text-ink-soft">Nomenclature</dt><dd>{bom ? <Link href={`/bom/${bom.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{bom.code}</Link> : <span className="text-ink-faint">{product.article_id ? 'aucune' : 'lier un article pour y accéder'}</span>}{bom && <span className="ml-2 text-xs text-ink-soft">{bom.archived ? 'archivée' : bom.active_version_no ? `v${bom.active_version_no} validée` : 'non validée'}</span>}</dd></>}
                    {refSpec.tech.fabric && <><dt className="text-ink-soft">Tissu</dt><dd className="font-medium">{refSpec.tech.fabric}{refSpec.tech.weight_gsm ? ` · ${refSpec.tech.weight_gsm} g/m²` : ''}</dd></>}
                    {refSpec.tech.composition && <><dt className="text-ink-soft">Composition</dt><dd className="font-medium">{refSpec.tech.composition}</dd></>}
                    <dt className="text-ink-soft">Créé / mis à jour</dt><dd>{formatDateTime(product.created_at)} · {formatDateTime(product.updated_at)}</dd>
                  </dl>
                  {product.description && <p className="whitespace-pre-wrap rounded-sm bg-canvas p-3 text-sm">{product.description}</p>}
                </div>
              </CardContent>
            </Card>

            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8" aria-label="Indicateurs du produit">
              {kpis.map((k) => (
                <li key={k.label}><Link href={`/products/${id}?tab=${k.tab}`} className="block rounded-md border border-line bg-white p-3 shadow-card transition-colors hover:border-brand-400">
                  <p className="flex items-center gap-1.5 text-xs text-ink-soft"><k.icon className="h-3.5 w-3.5" aria-hidden />{k.label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{k.value}</p></Link></li>
              ))}
            </ul>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Coloris et tailles</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {refSpec.colors.length === 0 && refSpec.sizes.length === 0 ? <p className="text-sm text-ink-soft">Fiche technique à compléter.</p> : (
                    <>
                      <ul className="flex flex-wrap gap-2">{refSpec.colors.map((c) => <li key={c.name} className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-sm"><span className="h-4 w-4 rounded-full border border-line-strong" style={{ background: c.hex || '#e1dfdd' }} aria-hidden />{c.name}</li>)}</ul>
                      <ul className="flex flex-wrap gap-1.5">{refSpec.sizes.map((s) => <li key={s.label} className="rounded-md bg-canvas px-2.5 py-1 text-sm font-semibold">{s.label}</li>)}</ul>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Certifications</CardTitle></CardHeader>
                <CardContent>
                  {certStates.length === 0 ? <p className="text-sm text-ink-soft">Aucune certification enregistrée.</p> : (
                    <ul className="space-y-1.5">{certStates.map(({ c, st }) => <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{c.standard_code}{c.class_level ? ` · classe ${c.class_level}` : ''}</span><Badge tone={CERT_STATE_INFO[st].tone}>{CERT_STATE_INFO[st].label}</Badge></li>)}</ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Nomenclature et documents</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {canBom && <p className="flex items-center gap-2"><Network className="h-4 w-4 text-brand-500" aria-hidden />{bom ? <><Link href={`/products/${id}?tab=bom`} className="font-semibold text-brand-700 hover:underline">{bom.code}</Link><span className="text-ink-soft">{bom.active_version_no ? `version ${bom.active_version_no} validée` : 'sans version validée'}</span></> : <span className="text-ink-soft">Aucune nomenclature liée.</span>}</p>}
                  {canDocs && <p className="flex items-center gap-2"><Scissors className="h-4 w-4 text-brand-500" aria-hidden />{patternDocs.length} patronage(s), marqueur(s) ou gradation(s)</p>}
                  {canDocs && <p className="flex items-center gap-2"><FileText className="h-4 w-4 text-brand-500" aria-hidden />{otherDocs.length} autre(s) document(s)</p>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="flex items-center justify-between">Activité récente<Link href={`/products/${id}?tab=history`} className="text-xs font-normal text-brand-600 hover:underline">Tout l’historique</Link></CardTitle></CardHeader>
                <CardContent><ProductTimeline rows={history} /></CardContent>
              </Card>
            </div>
          </div>
        )}

        {tab === 'tech' && shown && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">Fiche technique — version {shown.version_no}</h2>
              <Badge tone={VERSION_STATUS[shown.status].tone}>{VERSION_STATUS[shown.status].label}</Badge>
              {shown.id !== product.active_version_id && product.active_version_id && <Link href={`/products/${id}?tab=tech`} className="text-xs text-brand-600 hover:underline">Revenir à la version de référence</Link>}
              {shown.status === 'draft' && editable && <Link href={`/products/${id}/spec?v=${shown.id}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Modifier la fiche</Link>}
            </div>
            {shown.status === 'draft' && <Alert tone="info">Brouillon non validé : {product.active_version_id ? 'la version validée reste la référence.' : 'aucune version n’est encore la référence du produit.'} <Link className="underline" href={`/products/${id}?tab=versions`}>Gérer les versions</Link></Alert>}
            <SpecView spec={spec} />
          </div>
        )}

        {tab === 'photos' && <PhotosPanel productId={id} clientId={product.client_id} photos={photos} colors={spec.colors.map((c) => c.name)} editable={editable} />}

        {tab === 'bom' && canBom && (
          <div className="space-y-4">
            {!product.article_id ? (
              <Alert tone="info">Les nomenclatures sont rattachées aux articles clients. {canWrite && !locked ? <><Link className="underline" href={`/products/${id}/edit`}>Liez un article à ce produit</Link> pour y retrouver sa nomenclature.</> : 'Aucun article n’est lié à ce produit.'}</Alert>
            ) : !bom ? (
              <Alert tone="info">L’article {article?.internal_ref} n’a pas encore de nomenclature. {perms.includes(P.BOM_WRITE) && !locked && <Link className="underline" href={`/bom/new?article=${product.article_id}`}>Créer la nomenclature</Link>}</Alert>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Link href={`/bom/${bom.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{bom.code}</Link><span>{bom.name}</span>
                  <Badge tone={bom.active_version_no ? 'success' : 'warning'}>{bom.archived ? 'Archivée' : bom.active_version_no ? `Version ${bom.active_version_no} validée` : 'Aucune version validée'}</Badge>
                  {live !== null && <span className="text-ink-soft">Coût de revient actuel : <strong className="tabular-nums text-ink">{formatMoney(live)}</strong></span>}
                  <Link href={`/bom/${bom.id}`} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>Ouvrir la nomenclature</Link>
                </div>
                {tree ? <TreeView key={bom.active_version_id} root={tree} costs={canCosts} /> : <Alert tone="info">Aucune version validée à afficher : validez la nomenclature pour voir son arbre ici.</Alert>}
              </>
            )}
          </div>
        )}

        {tab === 'patterns' && canDocs && (
          <DocumentsPanel productId={id} clientId={product.client_id} docs={patternDocs} kinds={PATTERN_KINDS} intro="patronages, plans de coupe et gradations (formats CAO courants acceptés par la GED)."
            folders={folders.filter((f) => !f.parent_id).map((f) => ({ id: f.id, label: f.name }))} linkable={linkable.map((d) => ({ id: d.id, title: d.title, folder: folderName.get(d.folder_id) ?? '' }))}
            editable={editable} canUpload={perms.includes(P.DOCUMENTS_WRITE)} />
        )}
        {tab === 'documents' && canDocs && (
          <DocumentsPanel productId={id} clientId={product.client_id} docs={otherDocs} kinds={DOC_KINDS.map((k) => k.value).filter((k) => !PATTERN_KINDS.includes(k))} intro="fiches techniques, validations d’échantillon, rapports d’essai, étiquetage, packaging."
            folders={folders.filter((f) => !f.parent_id).map((f) => ({ id: f.id, label: f.name }))} linkable={linkable.map((d) => ({ id: d.id, title: d.title, folder: folderName.get(d.folder_id) ?? '' }))}
            editable={editable} canUpload={perms.includes(P.DOCUMENTS_WRITE)} />
        )}
        {tab === 'certs' && <CertificationsPanel productId={id} clientId={product.client_id} certs={certs} docs={certDocs} editable={editable} />}
        {tab === 'versions' && <VersionsPanel productId={id} versions={rows} canWrite={canWrite} canValidate={perms.includes(P.PRODUCTS_VALIDATE)} locked={locked} activeVersionId={product.active_version_id} />}
        {tab === 'history' && <Card><CardHeader><CardTitle>Timeline des modifications</CardTitle></CardHeader><CardContent><ProductTimeline rows={history} /></CardContent></Card>}
      </div>
    </>
  )
}

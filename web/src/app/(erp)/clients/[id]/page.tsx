import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Globe, Mail, MapPin, Phone, UserRound } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { AddressesPanel } from '@/features/clients/components/addresses-panel'
import { ClientActions } from '@/features/clients/components/client-actions'
import { ContactsPanel } from '@/features/clients/components/contacts-panel'
import { ComplaintsPanel } from '@/features/clients/components/complaints-panel'
import { ClientSpaceCard } from '@/features/ged/components/client-space-card'
import { FollowUpPanel } from '@/features/clients/components/follow-up-panel'
import { clientBalance, clientEmails, clientTasks, clientTimeline, clientVisits, linkablePieces } from '@/features/clients/services/follow-up.service'
import { clientArticles } from '@/features/articles/services/articles.service'
import { ARTICLE_STATUS } from '@/lib/articles/options'
import { clientStats, folderCounts, listFolders } from '@/features/ged/services/ged.service'
import { HistoryPanel } from '@/features/clients/components/history-panel'
import {
  directoryByIds, getClient, listAddresses, listContacts, listPaymentTerms,
} from '@/features/clients/services/clients.service'
import {
  clientActivity, clientBoms, clientComplaints, clientInvoices, clientMargin, clientOrders, clientPerformance,
} from '@/features/clients/services/client360.service'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { INCOTERMS, LANGUAGES, PAYMENT_METHODS, countryName, flag, label } from '@/lib/clients/options'
import { formatMoney } from '@/lib/bom/options'
import { money } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Fiche client 360°' }

/** Fiche client 360° : toute la relation client sur une page, un onglet par sujet. */
const TABS = [
  { id: 'general', label: 'Informations générales' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'orders', label: 'Commandes' },
  { id: 'invoices', label: 'Factures' },
  { id: 'documents', label: 'Documents GED' },
  { id: 'articles', label: 'Articles client' },
  { id: 'boms', label: 'Nomenclatures' },
  { id: 'claims', label: 'Réclamations' },
  { id: 'history', label: 'Historique' },
  { id: 'performance', label: 'Performance commerciale' },
  { id: 'margin', label: 'Marge' },
  { id: 'activity', label: 'Activité récente' },
  { id: 'follow', label: 'Suivi (visites, tâches, chronologie)' },
  { id: 'balance', label: 'Encours' },
] as const
type TabId = (typeof TABS)[number]['id']

const FLASH: Record<string, string> = {
  created: 'Client créé. Ajoutez maintenant ses contacts, adresses et documents.',
  updated: 'Modifications enregistrées.',
  archived: 'Client archivé.',
  restored: 'Client restauré.',
}
const ORDER_STATUS: Record<string, string> = { draft: 'Brouillon', confirmed: 'Confirmée', delivered: 'Livrée', cancelled: 'Annulée' }
const INVOICE_STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Brouillon', tone: 'neutral' }, issued: { label: 'Émise', tone: 'brand' }, partially_paid: { label: 'Partiellement payée', tone: 'warning' },
  paid: { label: 'Payée', tone: 'success' }, credited: { label: 'Avoir', tone: 'neutral' }, cancelled: { label: 'Annulée', tone: 'neutral' },
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-ink-soft">{k}</dt>
      <dd className="min-w-0 break-words font-medium">{children ?? '—'}</dd>
    </div>
  )
}
const dash = <span className="font-normal text-ink-faint">—</span>
const Kpi = ({ label: l, value, hint }: { label: string; value: React.ReactNode; hint?: string }) => (
  <div className="rounded-md border border-line bg-surface p-3 shadow-card">
    <p className="text-xs text-ink-soft">{l}</p>
    <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    {hint && <p className="text-xs text-ink-faint">{hint}</p>}
  </div>
)

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string } & Record<string, string | undefined>>
}) {
  const ctx = await requirePermission(P.CLIENTS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const tab: TabId = (TABS.find((t) => t.id === sp.tab)?.id ?? 'general') as TabId

  const client = await getClient(id)
  if (!client) notFound()

  const perms = ctx.permissions
  const canReadDocs = perms.includes(P.DOCUMENTS_READ)
  const canReadArticles = perms.includes(P.ARTICLES_READ)
  const canReadOrders = perms.includes(P.ORDERS_READ)
  const canReadInvoices = perms.includes(P.INVOICES_READ)
  const canCosts = perms.includes(P.COSTS_READ) && canReadInvoices

  // Données chargées selon l'onglet : la page reste rapide.
  const [contacts, addresses, terms] = await Promise.all([
    tab === 'general' || tab === 'contacts' ? listContacts(id) : Promise.resolve([]),
    tab === 'general' ? listAddresses(id) : Promise.resolve([]),
    tab === 'general' ? listPaymentTerms() : Promise.resolve([]),
  ])
  const articles = canReadArticles && (tab === 'articles' || tab === 'boms' || tab === 'general') ? await clientArticles(id) : []
  const orders = tab === 'orders' && canReadOrders ? await clientOrders(id) : []
  const invoices = tab === 'invoices' && canReadInvoices ? await clientInvoices(id) : []
  const boms = tab === 'boms' ? await clientBoms(id) : []
  const complaints = tab === 'claims' || tab === 'activity' ? await clientComplaints(id) : []
  const perf = tab === 'performance' && canReadInvoices ? await clientPerformance(id) : null
  const margin = tab === 'margin' && canCosts ? await clientMargin(id) : null
  const activity = tab === 'activity' ? await clientActivity(id) : []
  const [gedFolders, gedCounts, gedStats] = await Promise.all([
    tab === 'documents' && canReadDocs ? listFolders(id) : Promise.resolve([]),
    tab === 'documents' && canReadDocs ? folderCounts(id) : Promise.resolve({ byFolder: new Map<string, number>(), trash: 0 }),
    canReadDocs ? clientStats() : Promise.resolve(new Map()),
  ])
  const history = tab === 'history' ? await recentAuditFor('client', id, 100) : []
  const followUp = tab === 'follow' ? await Promise.all([clientTimeline(id), clientVisits(id), clientEmails(id), clientTasks(id), linkablePieces(id)]) : null
  const balance = tab === 'balance' && canReadInvoices ? await clientBalance(id) : null

  const userIds = [client.sales_rep_id, client.created_by, client.updated_by, client.archived_by, ...history.flatMap((h) => [
    h.after_data?.sales_rep_id as string | undefined, h.before_data?.sales_rep_id as string | undefined])]
  const users = await directoryByIds(userIds)

  const canWrite = perms.includes(P.CLIENTS_WRITE)
  const canDelete = perms.includes(P.CLIENTS_DELETE)
  const archived = Boolean(client.archived_at)
  const term = terms.find((t) => t.id === client.payment_terms_id)
  const rep = client.sales_rep_id ? users.get(client.sales_rep_id) : null
  const primary = contacts.find((c) => c.is_primary) ?? contacts[0]
  const billing = addresses.find((a) => a.type === 'billing' && a.is_default) ?? addresses.find((a) => a.type === 'billing') ?? addresses[0]
  const flash = Object.keys(FLASH).find((k) => sp[k])
  const docStats = gedStats.get(id)
  const expiringDocs = docStats?.expiring ?? 0
  const openComplaints = complaints.filter((c) => c.status !== 'closed').length
  const counts: Partial<Record<TabId, number>> = { contacts: contacts.length, orders: orders.length, invoices: invoices.length, articles: articles.length, claims: openComplaints, documents: docStats?.documents ?? 0 }

  return (
    <>
      <PageHeader
        title={client.name}
        description={`${client.code} · ${flag(client.country)} ${countryName(client.country)} · ${client.currency}`}
        actions={
          <>
            <Link href="/clients" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Clients</Link>
            <ClientActions clientId={client.id} clientName={client.name} archived={archived} canWrite={canWrite} canDelete={canDelete} />
          </>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        {flash && <Alert tone="success">{FLASH[flash]}</Alert>}
        {archived && (
          <Alert tone="warning">
            <strong>Client archivé</strong> le {formatDateTime(client.archived_at)}
            {client.archived_by && users.get(client.archived_by) ? ` par ${users.get(client.archived_by)!.full_name}` : ''}
            {client.archive_reason ? ` — motif : ${client.archive_reason}` : ''}. Il est en lecture seule.
          </Alert>
        )}
        {expiringDocs > 0 && !archived && <Alert tone="warning">{expiringDocs} document(s) expiré(s) ou bientôt expirés : <Link className="underline" href={`/ged/${id}`}>ouvrir la GED</Link>.</Alert>}

        {/* Bandeau de synthèse : la relation en un coup d’œil */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Commercial" value={rep?.full_name ?? '—'} hint={client.sales_rep_id ? undefined : 'non affecté'} />
          <Kpi label="Paiement" value={term?.label ?? '—'} hint={client.payment_method ? label(PAYMENT_METHODS, client.payment_method) : undefined} />
          <Kpi label="Contacts" value={tab === 'general' || tab === 'contacts' ? contacts.length : '—'} />
          <Kpi label="Réclamations ouvertes" value={tab === 'claims' || tab === 'activity' ? openComplaints : '—'} hint="ouvrir l’onglet pour le détail" />
        </div>

        <nav aria-label="Sections de la fiche client" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={t.id === 'general' ? `/clients/${id}` : `/clients/${id}?tab=${t.id}`}
              aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors duration-150', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}
            >
              {t.label}
              {counts[t.id] !== undefined && counts[t.id]! > 0 && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{counts[t.id]}</span>}
            </Link>
          ))}
        </nav>

        {tab === 'general' && (
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader><CardTitle>Informations générales</CardTitle>{archived && <Badge tone="warning">Archivé</Badge>}</CardHeader>
              <CardContent>
                <dl className="divide-y divide-line">
                  <Row k="Raison sociale">{client.name}</Row>
                  <Row k="Dénomination légale">{client.legal_name ?? dash}</Row>
                  <Row k="Code"><span className="font-mono">{client.code}</span></Row>
                  <Row k="Identifiant fiscal">{client.tax_id ?? dash}</Row>
                  <Row k="Registre du commerce">{client.registration_no ?? dash}</Row>
                  <Row k="Pays">{flag(client.country)} {countryName(client.country)}</Row>
                  <Row k="E-mail">{client.email ? <a className="text-brand-700 hover:underline" href={`mailto:${client.email}`}>{client.email}</a> : dash}</Row>
                  <Row k="Téléphone">{client.phone ? <a className="hover:underline" href={`tel:${client.phone}`}>{client.phone}</a> : dash}</Row>
                  <Row k="Site web">{client.website ? <a className="text-brand-700 hover:underline" target="_blank" rel="noopener noreferrer" href={/^https?:\/\//.test(client.website) ? client.website : `https://${client.website}`}>{client.website}</a> : dash}</Row>
                  <Row k="Langue des documents">{label(LANGUAGES, client.language)}</Row>
                </dl>
                {client.notes && (
                  <div className="mt-4 rounded-sm bg-canvas p-3 text-sm">
                    <p className="mb-1 text-xs font-semibold uppercase text-ink-soft">Notes internes</p>
                    <p className="whitespace-pre-wrap">{client.notes}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader><CardTitle>Commercial affecté</CardTitle></CardHeader>
                <CardContent>
                  {rep ? (
                    <div className="flex items-center gap-3 text-sm">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-brand-700"><UserRound className="h-5 w-5" /></span>
                      <div className="min-w-0"><p className="font-semibold">{rep.full_name}</p><p className="truncate text-xs text-ink-soft">{rep.email}</p></div>
                    </div>
                  ) : <p className="text-sm text-ink-soft">Aucun commercial affecté.</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Conditions commerciales</CardTitle></CardHeader>
                <CardContent>
                  <dl className="divide-y divide-line">
                    <Row k="Devise"><Badge tone="brand">{client.currency}</Badge></Row>
                    <Row k="Paiement">{term?.label ?? dash}</Row>
                    <Row k="Mode de règlement">{client.payment_method ? label(PAYMENT_METHODS, client.payment_method) : dash}</Row>
                    <Row k="Plafond de crédit">{client.credit_limit !== null ? `${Number(client.credit_limit).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 3 })} ${client.currency}` : dash}</Row>
                    <Row k="Incoterm">{client.incoterm && (INCOTERMS as readonly string[]).includes(client.incoterm) ? client.incoterm : dash}</Row>
                    <Row k="Tolérance livraison">±{Number(client.delivery_tolerance_pct)} %</Row>
                    <Row k="Niveau AQL">{client.aql_level ?? dash}</Row>
                    <Row k="TVA">{client.vat_exempt ? 'Exonéré' : 'Applicable'}</Row>
                  </dl>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader><CardTitle>Contact principal</CardTitle><Link href={`/clients/${id}?tab=contacts`} className="text-xs text-brand-600 hover:underline">Tous ({contacts.length})</Link></CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {primary ? (
                  <>
                    <p className="font-semibold">{primary.full_name}</p>
                    {primary.job_title && <p className="text-ink-soft">{primary.job_title}</p>}
                    {primary.email && <p className="flex items-center gap-2"><Mail className="h-4 w-4 text-ink-faint" /><a className="truncate text-brand-700 hover:underline" href={`mailto:${primary.email}`}>{primary.email}</a></p>}
                    {(primary.phone || primary.mobile) && <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-ink-faint" />{primary.phone ?? primary.mobile}</p>}
                  </>
                ) : <p className="text-ink-soft">Aucun contact.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Adresse de facturation</CardTitle><Link href={`/clients/${id}?tab=general#adresses`} className="text-xs text-brand-600 hover:underline">Toutes ({addresses.length})</Link></CardHeader>
              <CardContent className="text-sm">
                {billing ? (
                  <address className="flex gap-2 not-italic leading-relaxed"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" /><span>{billing.line1}{billing.line2 && <><br />{billing.line2}</>}<br />{[billing.postal_code, billing.city].filter(Boolean).join(' ')}</span></address>
                ) : <p className="text-ink-soft">Aucune adresse.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Suivi</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-xs text-ink-soft">
                <p className="flex items-center gap-2"><Globe className="h-3.5 w-3.5" aria-hidden /> Créé le {formatDateTime(client.created_at)}{client.created_by && users.get(client.created_by) ? ` par ${users.get(client.created_by)!.full_name}` : ''}</p>
                <p>Modifié le {formatDateTime(client.updated_at)}{client.updated_by && users.get(client.updated_by) ? ` par ${users.get(client.updated_by)!.full_name}` : ''}</p>
                <p><Link href={`/clients/${id}?tab=history`} className="text-brand-600 hover:underline">Voir tout l’historique</Link></p>
              </CardContent>
            </Card>

            <div id="adresses" className="xl:col-span-3">
              <AddressesPanel clientId={id} addresses={addresses} defaultCountry={client.country} canWrite={canWrite} locked={archived} />
            </div>
          </div>
        )}

        {tab === 'contacts' && <ContactsPanel clientId={id} contacts={contacts} canWrite={canWrite} locked={archived} />}

        {tab === 'orders' && (canReadOrders ? (
          orders.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-soft">Aucune commande.</p> : (
            <div className="overflow-x-auto rounded-md border border-line bg-surface shadow-card">
              <table className="w-full min-w-[32rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2">Commande</th><th className="px-2 py-2">Réf. client</th><th className="px-2 py-2">Date</th><th className="px-2 py-2">Statut</th></tr></thead>
                <tbody className="divide-y divide-line">{orders.map((o) => (
                  <tr key={o.id} className="hover:bg-canvas"><td className="px-4 py-2 font-mono text-xs font-semibold">{o.code}</td><td className="px-2 py-2">{o.client_ref ?? dash}</td><td className="px-2 py-2 text-xs">{o.order_date}</td><td className="px-2 py-2"><Badge tone={o.status === 'delivered' ? 'success' : o.status === 'cancelled' ? 'neutral' : 'brand'}>{ORDER_STATUS[o.status] ?? o.status}</Badge></td></tr>
                ))}</tbody>
              </table>
            </div>
          )
        ) : <Alert tone="info">Vous n’avez pas accès aux commandes (permission « orders.read »).</Alert>)}

        {tab === 'invoices' && (canReadInvoices ? (
          invoices.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-soft">Aucune facture.</p> : (
            <div className="overflow-x-auto rounded-md border border-line bg-surface shadow-card">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-4 py-2">Facture</th><th className="px-2 py-2">Émise le</th><th className="px-2 py-2">Échéance</th><th className="px-2 py-2 text-right">Total TTC</th><th className="px-2 py-2 text-right">Reste dû</th><th className="px-2 py-2">Statut</th></tr></thead>
                <tbody className="divide-y divide-line">{invoices.map((i) => {
                  const st = INVOICE_STATUS[i.status] ?? INVOICE_STATUS.draft
                  const rest = i.total - i.paid_amount - i.credited_amount
                  return (
                    <tr key={i.id} className="hover:bg-canvas"><td className="px-4 py-2 font-mono text-xs font-semibold">{i.code ?? '(brouillon)'}</td><td className="px-2 py-2 text-xs">{i.issue_date ?? dash}</td><td className="px-2 py-2 text-xs">{i.due_date ?? dash}</td><td className="px-2 py-2 text-right tabular-nums">{formatMoney(i.total)}</td><td className={cn('px-2 py-2 text-right tabular-nums', rest > 0 && i.status !== 'draft' && 'font-semibold')}>{formatMoney(rest)}</td><td className="px-2 py-2"><Badge tone={st.tone}>{st.label}</Badge></td></tr>
                  )
                })}</tbody>
              </table>
            </div>
          )
        ) : <Alert tone="info">Vous n’avez pas accès aux factures (permission « invoices.read »).</Alert>)}

        {tab === 'documents' && (canReadDocs
          ? <ClientSpaceCard clientId={id} folders={gedFolders} counts={gedCounts.byFolder} stats={docStats} />
          : <Alert tone="info">Vous n’avez pas accès aux documents de ce client (permission « documents.read »).</Alert>)}

        {tab === 'articles' && (canReadArticles ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-ink-soft">{articles.length} article(s) de ce client</p>
              {perms.includes(P.ARTICLES_WRITE) && !archived && <Link href={`/articles/new?client=${id}`} className={buttonVariants({ size: 'sm' })}>Nouvel article</Link>}
            </div>
            <ul className="divide-y divide-line rounded-md border border-line bg-surface shadow-card">
              {articles.map((a) => (
                <li key={a.id}><Link href={`/articles/${a.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-canvas">
                  <span className="font-mono text-sm font-semibold text-brand-700">{a.internal_ref}</span>
                  <span className="font-mono text-xs text-ink-soft">{a.client_ref}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                  <Badge tone={ARTICLE_STATUS[a.status as keyof typeof ARTICLE_STATUS]?.tone ?? 'neutral'}>{ARTICLE_STATUS[a.status as keyof typeof ARTICLE_STATUS]?.label ?? a.status}</Badge>
                </Link></li>
              ))}
              {articles.length === 0 && <li className="px-4 py-10 text-center text-sm text-ink-soft">Aucun article pour ce client.</li>}
            </ul>
          </div>
        ) : <Alert tone="info">Vous n’avez pas accès aux articles (permission « articles.read »).</Alert>)}

        {tab === 'boms' && (boms.length === 0 ? (
          <p className="rounded-md border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-soft">Aucune nomenclature pour les articles de ce client.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line bg-surface shadow-card">
            {boms.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <Link href={`/bom/${b.id}`} className="font-mono font-semibold text-brand-700 hover:underline">{b.code}</Link>
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                <span className="text-xs text-ink-soft">Article : {b.article}</span>
                <Badge tone={b.version_status === 'validated' ? 'success' : 'warning'}>{b.version_no ? `v${b.version_no} ${b.version_status === 'validated' ? 'validée' : 'brouillon'}` : 'sans version'}</Badge>
              </li>
            ))}
          </ul>
        ))}

        {tab === 'follow' && followUp && (
          <FollowUpPanel clientId={id} canWrite={canWrite} timeline={followUp[0]} visits={followUp[1]} emails={followUp[2]} tasks={followUp[3]} pieces={followUp[4]} />
        )}
        {tab === 'balance' && (canReadInvoices ? (
          balance === null ? <Alert tone="warning">Encours indisponible.</Alert> : balance.length === 0 ? (
            <Alert tone="success">Aucune facture ouverte pour ce client.</Alert>
          ) : (
            <Card>
              <CardHeader><CardTitle>Encours (TTC, par devise)</CardTitle></CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2">
                  {balance.map((b) => (
                    <div key={b.currency} className="rounded-md border border-line p-3">
                      <p className="text-xs text-ink-soft">{b.currency}</p>
                      <p className="text-lg font-semibold tabular-nums">{money(b.open_ttc, b.currency)}</p>
                      <p className="text-xs text-ink-faint">dont échu : {money(b.overdue_ttc, b.currency)} · {b.open_invoices} facture(s) ouverte(s)</p>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-xs text-ink-faint">Chaque devise est affichée séparément. Les avoirs et paiements déjà enregistrés sont déduits.</p>
              </CardContent>
            </Card>
          )
        ) : <Alert tone="warning">Le droit facturation est requis pour voir les encours.</Alert>)}
        {tab === 'claims' && (canWrite || complaints.length > 0 ? (
          <ComplaintsPanel clientId={id} complaints={complaints} orders={orders.map((o) => ({ id: o.id, code: o.code }))} canWrite={canWrite && !archived} />
        ) : <Alert tone="info">Aucune réclamation pour ce client.</Alert>)}

        {tab === 'history' && (
          <Card>
            <CardContent>
              <HistoryPanel rows={history} resolvers={{ users: users as unknown as Map<string, { full_name: string }>, terms: new Map(terms.map((t) => [t.id, { label: t.label }])) }} />
            </CardContent>
          </Card>
        )}

        {tab === 'performance' && (canReadInvoices && perf ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Facturé (12 mois)" value={formatMoney(perf.invoiced12m)} />
              <Kpi label="Commandes (12 mois)" value={perf.orders12m} />
              <Kpi label="Panier moyen" value={perf.avgOrder === null ? '—' : formatMoney(perf.avgOrder)} />
              <Kpi label="Taux de transformation devis" value={perf.winRate === null ? '—' : `${perf.winRate} %`} hint={`${perf.quotes} devis au total`} />
            </div>
            <p className="text-xs text-ink-faint">Transformation : devis acceptés ou convertis en commande, sur les devis décidés (acceptés, convertis, refusés).</p>
          </div>
        ) : <Alert tone="info">Performance indisponible : votre droit ne couvre pas la facturation.</Alert>)}

        {tab === 'margin' && (canCosts ? (
          margin ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Kpi label="CA TTC (12 mois)" value={formatMoney(margin.invoiced)} />
                <Kpi label="Net après avoirs" value={formatMoney(margin.net)} />
                <Kpi label="Marge estimée" value={margin.margin === null ? '—' : formatMoney(margin.margin)} hint="coût standard BOM" />
                <Kpi label="Taux de marge" value={margin.marginPct === null ? '—' : `${margin.marginPct} %`} hint={margin.coverage === null ? undefined : `coûts connus sur ${margin.coverage} % du CA`} />
              </div>
              {margin.coverage !== null && margin.coverage < 100 && <Alert tone="warning">{100 - margin.coverage} % du chiffre d’affaires n’a pas de coût standard figé : la marge est partielle.</Alert>}
            </div>
          ) : <p className="rounded-md border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-soft">Aucune facture sur les 12 derniers mois.</p>
        ) : <Alert tone="info">La marge est réservée aux profils qui voient les coûts (permission « costs.read »).</Alert>)}

        {tab === 'activity' && (
          activity.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-surface p-8 text-center text-sm text-ink-soft">Aucune activité récente.</p> : (
            <ol className="space-y-3 rounded-md border border-line bg-surface p-4 shadow-card">
              {activity.map((a, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', a.kind === 'order' ? 'bg-brand-500' : a.kind === 'invoice' ? 'bg-success' : 'bg-warn')} aria-hidden />
                  <div className="min-w-0"><p className="font-medium">{a.label}</p><p className="text-xs text-ink-soft">{formatDateTime(a.at)}</p></div>
                </li>
              ))}
            </ol>
          )
        )}
      </div>
    </>
  )
}

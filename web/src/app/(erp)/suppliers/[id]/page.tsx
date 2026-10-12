import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Mail, Phone, Star, UserRound } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { directoryByIds, listPaymentTerms } from '@/features/clients/services/clients.service'
import { SupplierContactsPanel } from '@/features/suppliers/components/contacts-panel'
import { SupplierDocumentsPanel } from '@/features/suppliers/components/documents-panel'
import { SupplierHistory } from '@/features/suppliers/components/history-panel'
import { OrdersTable, StatsPanel } from '@/features/suppliers/components/stats-panel'
import { SupplierActions } from '@/features/suppliers/components/supplier-actions'
import { getStats, getSupplier, listContacts, listDocuments, listOrders } from '@/features/suppliers/services/suppliers.service'
import { recentAuditFor } from '@/features/rbac/services/audit-query.service'
import { LANGUAGES, PAYMENT_METHODS, countryName, flag, label } from '@/lib/clients/options'
import { QUALIFICATIONS, SUPPLIER_CATEGORIES } from '@/lib/suppliers/options'
import { P } from '@/lib/rbac/permissions'
import { cn, formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Fiche fournisseur' }

const TABS = [
  { id: 'overview', label: 'Vue d’ensemble' }, { id: 'contacts', label: 'Contacts' }, { id: 'documents', label: 'Documents' },
  { id: 'orders', label: 'Commandes' }, { id: 'stats', label: 'Statistiques' }, { id: 'history', label: 'Historique' },
] as const
type TabId = (typeof TABS)[number]['id']
const FLASH: Record<string, string> = { created: 'Fournisseur créé. Ajoutez ses contacts et documents.', updated: 'Modifications enregistrées.', archived: 'Fournisseur archivé.', restored: 'Fournisseur restauré.' }

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 py-1.5 text-sm"><dt className="text-ink-soft">{k}</dt><dd className="min-w-0 break-words font-medium">{children ?? '—'}</dd></div>
}
const dash = <span className="font-normal text-ink-faint">—</span>

export default async function SupplierPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePermission(P.SUPPLIERS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const tab = (TABS.find((t) => t.id === sp.tab)?.id ?? 'overview') as TabId

  const supplier = await getSupplier(id)
  if (!supplier) notFound()
  const canPurchases = ctx.permissions.includes(P.PURCHASES_READ)
  const [contacts, documents, terms] = await Promise.all([listContacts(id), listDocuments(id), listPaymentTerms()])
  const orders = canPurchases && (tab === 'orders' || tab === 'overview') ? await listOrders(id) : []
  const stats = canPurchases && (tab === 'stats' || tab === 'overview') ? await getStats(id) : null
  const history = tab === 'history' ? await recentAuditFor('supplier', id, 100) : []
  const users = await directoryByIds([supplier.buyer_id, supplier.created_by, supplier.updated_by, supplier.archived_by,
    ...history.flatMap((h) => [h.after_data?.buyer_id as string | undefined, h.before_data?.buyer_id as string | undefined])])

  const canWrite = ctx.permissions.includes(P.SUPPLIERS_WRITE)
  const canDelete = ctx.permissions.includes(P.SUPPLIERS_DELETE)
  const archived = Boolean(supplier.archived_at)
  const term = terms.find((t) => t.id === supplier.payment_terms_id)
  const buyer = supplier.buyer_id ? users.get(supplier.buyer_id) : null
  const primary = contacts.find((c) => c.is_primary) ?? contacts[0]
  const flash = Object.keys(FLASH).find((k) => sp[k])
  const expiredDocs = documents.filter((d) => d.valid_until && new Date(d.valid_until + 'T23:59:59') < new Date()).length
  const counts: Record<TabId, number | null> = { overview: null, contacts: contacts.length, documents: documents.length, orders: canPurchases ? orders.length || null : null, stats: null, history: null }
  const qual = QUALIFICATIONS.find((q) => q.value === supplier.qualification)
  const visibleTabs = TABS.filter((t) => canPurchases || (t.id !== 'orders' && t.id !== 'stats'))
  const addr = [supplier.address_line1, supplier.address_line2, [supplier.postal_code, supplier.city].filter(Boolean).join(' '), supplier.region].filter(Boolean)

  return (
    <>
      <PageHeader title={supplier.name} description={`${supplier.code} · ${flag(supplier.country)} ${countryName(supplier.country)} · ${label(SUPPLIER_CATEGORIES, supplier.category)}`}
        actions={<><Link href="/suppliers" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Fournisseurs</Link>
          <SupplierActions id={supplier.id} name={supplier.name} archived={archived} canWrite={canWrite} canDelete={canDelete} /></>} />

      <div className="space-y-4 p-4 sm:p-6">
        {flash && <Alert tone="success">{FLASH[flash]}</Alert>}
        {archived && <Alert tone="warning"><strong>Fournisseur archivé</strong> le {formatDateTime(supplier.archived_at)}{supplier.archived_by && users.get(supplier.archived_by) ? ` par ${users.get(supplier.archived_by)!.full_name}` : ''}{supplier.archive_reason ? ` — motif : ${supplier.archive_reason}` : ''}. Lecture seule.</Alert>}
        {supplier.qualification === 'blocked' && !archived && <Alert tone="error">Ce fournisseur est <strong>bloqué</strong> : ne pas lui passer de nouvelles commandes.</Alert>}
        {expiredDocs > 0 && !archived && <Alert tone="warning">{expiredDocs} document(s) expiré(s) : <Link className="underline" href={`/suppliers/${id}?tab=documents`}>voir les documents</Link>.</Alert>}

        <nav aria-label="Sections de la fiche" className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
          {visibleTabs.map((t) => (
            <Link key={t.id} href={t.id === 'overview' ? `/suppliers/${id}` : `/suppliers/${id}?tab=${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
              className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2 text-sm', tab === t.id ? 'border-brand-500 font-semibold text-brand-700' : 'border-transparent text-ink-soft hover:text-ink')}>
              {t.label}{counts[t.id] !== null && <span className="ml-1.5 rounded-full bg-canvas px-1.5 text-xs">{counts[t.id]}</span>}
            </Link>
          ))}
        </nav>

        {tab === 'overview' && (
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader><CardTitle>Informations fournisseur</CardTitle><div className="flex gap-2">{qual && <Badge tone={qual.tone}>{qual.label}</Badge>}{archived && <Badge tone="warning">Archivé</Badge>}</div></CardHeader>
              <CardContent>
                <dl className="divide-y divide-line">
                  <Row k="Raison sociale">{supplier.name}</Row>
                  <Row k="Dénomination légale">{supplier.legal_name ?? dash}</Row>
                  <Row k="Catégorie">{label(SUPPLIER_CATEGORIES, supplier.category)}</Row>
                  <Row k="Identifiant fiscal">{supplier.tax_id ?? dash}</Row>
                  <Row k="Registre du commerce">{supplier.registration_no ?? dash}</Row>
                  <Row k="Adresse">{addr.length ? <address className="not-italic">{addr.map((l, i) => <span key={i} className="block">{l}</span>)}<span className="block">{flag(supplier.country)} {countryName(supplier.country)}</span></address> : dash}</Row>
                  <Row k="E-mail">{supplier.email ? <a className="text-brand-700 hover:underline" href={`mailto:${supplier.email}`}>{supplier.email}</a> : dash}</Row>
                  <Row k="Téléphone">{supplier.phone ? <a className="hover:underline" href={`tel:${supplier.phone}`}>{supplier.phone}</a> : dash}</Row>
                  <Row k="Site web">{supplier.website ? <a className="text-brand-700 hover:underline" target="_blank" rel="noopener noreferrer" href={/^https?:\/\//.test(supplier.website) ? supplier.website : `https://${supplier.website}`}>{supplier.website}</a> : dash}</Row>
                  <Row k="Langue">{label(LANGUAGES, supplier.language)}</Row>
                  <Row k="Note">{supplier.rating ? <span className="inline-flex items-center gap-0.5">{Array.from({ length: 5 }, (_, i) => <Star key={i} className={cn('h-4 w-4', i < supplier.rating! ? 'fill-[#c19c00] text-[#c19c00]' : 'text-line-strong')} aria-hidden />)}<span className="sr-only">{supplier.rating} sur 5</span></span> : dash}</Row>
                </dl>
                {supplier.notes && <div className="mt-4 rounded-sm bg-canvas p-3 text-sm"><p className="mb-1 text-xs font-semibold uppercase text-ink-soft">Notes internes</p><p className="whitespace-pre-wrap">{supplier.notes}</p></div>}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader><CardTitle>Conditions d’achat</CardTitle></CardHeader>
                <CardContent><dl className="divide-y divide-line">
                  <Row k="Devise"><Badge tone="brand">{supplier.currency}</Badge></Row>
                  <Row k="Paiement">{term?.label ?? dash}</Row>
                  <Row k="Mode de règlement">{supplier.payment_method ? label(PAYMENT_METHODS, supplier.payment_method) : dash}</Row>
                  <Row k="Délai de livraison">{supplier.lead_time_days !== null ? `${supplier.lead_time_days} jours` : dash}</Row>
                  <Row k="Incoterm">{supplier.incoterm ? `${supplier.incoterm}${supplier.incoterm_place ? ` — ${supplier.incoterm_place}` : ''}` : dash}</Row>
                  <Row k="Minimum de commande">{supplier.min_order_amount !== null ? `${Number(supplier.min_order_amount).toLocaleString('fr-FR')} ${supplier.currency}` : dash}</Row>
                </dl></CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Acheteur référent</CardTitle></CardHeader>
                <CardContent>{buyer ? (
                  <div className="flex items-center gap-3 text-sm"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-brand-700"><UserRound className="h-5 w-5" /></span>
                    <div className="min-w-0"><p className="font-semibold">{buyer.full_name}</p><p className="truncate text-xs text-ink-soft">{buyer.email}</p></div></div>
                ) : <p className="text-sm text-ink-soft">Aucun acheteur affecté.</p>}</CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader><CardTitle>Contact principal</CardTitle><Link href={`/suppliers/${id}?tab=contacts`} className="text-xs text-brand-600 hover:underline">Tous ({contacts.length})</Link></CardHeader>
              <CardContent className="space-y-1.5 text-sm">{primary ? (<>
                <p className="font-semibold">{primary.full_name}</p>{primary.job_title && <p className="text-ink-soft">{primary.job_title}</p>}
                {primary.email && <p className="flex items-center gap-2"><Mail className="h-4 w-4 text-ink-faint" /><a className="truncate text-brand-700 hover:underline" href={`mailto:${primary.email}`}>{primary.email}</a></p>}
                {(primary.phone || primary.mobile) && <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-ink-faint" />{primary.phone ?? primary.mobile}</p>}</>) : <p className="text-ink-soft">Aucun contact.</p>}</CardContent>
            </Card>

            {canPurchases && stats && (
              <Card className="xl:col-span-2">
                <CardHeader><CardTitle>Achats en bref</CardTitle><Link href={`/suppliers/${id}?tab=stats`} className="text-xs text-brand-600 hover:underline">Statistiques détaillées</Link></CardHeader>
                <CardContent className="grid gap-4 text-sm sm:grid-cols-4">
                  <div><p className="text-xs text-ink-soft">Total acheté</p><p className="text-lg font-semibold tabular-nums">{Number(stats.total_amount).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} {supplier.currency}</p></div>
                  <div><p className="text-xs text-ink-soft">Commandes</p><p className="text-lg font-semibold">{stats.orders_count}</p></div>
                  <div><p className="text-xs text-ink-soft">À l’heure</p><p className="text-lg font-semibold">{stats.on_time_rate === null ? '—' : `${stats.on_time_rate} %`}</p></div>
                  <div><p className="text-xs text-ink-soft">En cours</p><p className="text-lg font-semibold">{stats.open_orders}</p></div>
                </CardContent>
              </Card>
            )}

            <Card className={canPurchases && stats ? '' : 'xl:col-span-1'}>
              <CardHeader><CardTitle>Suivi</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-xs text-ink-soft">
                <p>Créé le {formatDateTime(supplier.created_at)}{supplier.created_by && users.get(supplier.created_by) ? ` par ${users.get(supplier.created_by)!.full_name}` : ''}</p>
                <p>Modifié le {formatDateTime(supplier.updated_at)}{supplier.updated_by && users.get(supplier.updated_by) ? ` par ${users.get(supplier.updated_by)!.full_name}` : ''}</p>
                <p><Link href={`/suppliers/${id}?tab=history`} className="text-brand-600 hover:underline">Voir tout l’historique</Link></p>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === 'contacts' && <SupplierContactsPanel supplierId={id} contacts={contacts} canWrite={canWrite} locked={archived} />}
        {tab === 'documents' && <SupplierDocumentsPanel supplierId={id} documents={documents} canWrite={canWrite} locked={archived} />}
        {tab === 'orders' && canPurchases && <OrdersTable orders={orders} supplierCurrency={supplier.currency} />}
        {tab === 'stats' && canPurchases && (stats ? <StatsPanel stats={stats} currency={supplier.currency} leadTimeDays={supplier.lead_time_days} /> : <Alert tone="info">Statistiques indisponibles.</Alert>)}
        {tab === 'history' && (
          <Card><CardContent>
            <SupplierHistory rows={history} resolvers={{ users: users as unknown as Map<string, { full_name: string }>, terms: new Map(terms.map((t) => [t.id, { label: t.label }])) }} />
          </CardContent></Card>
        )}
      </div>
    </>
  )
}

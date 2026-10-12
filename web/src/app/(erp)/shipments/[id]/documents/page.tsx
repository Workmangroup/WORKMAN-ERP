import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { requirePermission } from '@/features/auth/guards'
import { PrintButton } from '@/features/shipping/components/shipping-forms'
import { getShipment, listLines } from '@/features/shipping/services/shipping.service'
import { createClient } from '@/lib/supabase/server'
import { formatMoney } from '@/lib/bom/options'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Documents d’expédition' }

const TITLES: Record<string, string> = { bl: 'Bon de livraison', packing: 'Packing list', export: 'Facture export' }

export default async function ShipmentDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ doc?: string }> }) {
  await requirePermission(P.SHIPMENTS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const doc = sp.doc && sp.doc in TITLES ? sp.doc : 'packing'
  const s = await getShipment(id)
  if (!s) notFound()
  if (doc === 'bl' && !s.bl_number) notFound()
  if (doc === 'export' && !s.export_invoice_number) notFound()
  const lines = await listLines(id)
  const supabase = await createClient()
  const { data: client } = await supabase.from('clients').select('name,country').eq('id', s.client_id).maybeSingle()
  const { data: order } = await supabase.from('sales_orders').select('code,client_ref').eq('id', s.sales_order_id).maybeSingle()
  const totalQty = lines.reduce((n, l) => n + l.qty_shipped, 0)
  const totalValue = lines.reduce((n, l) => n + l.qty_shipped * l.unit_price, 0)
  const number = doc === 'bl' ? s.bl_number : doc === 'export' ? s.export_invoice_number : s.number
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6 text-sm print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/shipments/${id}`} className="text-brand-700 hover:underline">← Retour à l’expédition</Link>
        <div className="flex gap-2">
          {(['packing', ...(s.bl_number ? ['bl'] : []), ...(s.export_invoice_number ? ['export'] : [])] as string[]).map((d) => (
            <Link key={d} href={`/shipments/${id}/documents?doc=${d}`} className={d === doc ? 'font-semibold text-brand-700' : 'text-ink-soft hover:underline'}>{TITLES[d]}</Link>
          ))}
          <PrintButton />
        </div>
      </div>

      <header className="flex items-start justify-between gap-6 border-b border-line pb-4">
        <div>
          <h1 className="text-xl font-semibold">{TITLES[doc]}</h1>
          <p className="font-mono">{number}</p>
        </div>
        <div className="text-right text-ink-soft">
          <p>Date : {formatDateTime(s.shipped_at ?? s.created_at)}</p>
          <p>Commande : {order?.code ?? '—'}{order?.client_ref ? ` · réf. client ${order.client_ref}` : ''}</p>
        </div>
      </header>

      <section>
        <p className="font-semibold">Destinataire</p>
        <p>{client?.name ?? '—'}</p>
        <p className="text-ink-soft">{client?.country ?? s.destination_country ?? ''}</p>
      </section>

      {doc === 'export' && (
        <section className="grid grid-cols-2 gap-2">
          <p>Incoterm : <span className="font-semibold">{s.incoterm}</span></p>
          <p>Pays de destination : <span className="font-semibold">{s.destination_country}</span></p>
          <p>Devise : {s.currency}</p>
          <p>Expédition : {s.number}</p>
        </section>
      )}

      {doc === 'bl' && (
        <section className="grid grid-cols-2 gap-2">
          <p>Transporteur : {s.carrier ?? '—'}</p>
          <p>N° de suivi : {s.tracking_number ?? '—'}</p>
        </section>
      )}

      {doc === 'packing' && (
        <section className="grid grid-cols-3 gap-2">
          <p>Colis : {s.packages ?? '—'}</p>
          <p>Poids brut : {s.gross_weight_kg ?? '—'} kg</p>
          <p>Poids net : {s.net_weight_kg ?? '—'} kg</p>
        </section>
      )}

      <table className="w-full border-collapse text-left">
        <thead><tr className="border-b border-line text-xs text-ink-soft"><th className="py-2">Référence</th><th>Désignation</th><th>Taille</th><th>Couleur</th><th className="text-right">Quantité</th>{doc !== 'packing' && <><th className="text-right">Prix unitaire</th><th className="text-right">Montant</th></>}</tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.id} className="border-b border-line">
            <td className="py-2 font-mono text-xs">{l.sku}</td><td>{l.product}</td><td>{l.size ?? '—'}</td><td>{l.color ?? '—'}</td>
            <td className="text-right tabular-nums">{doc === 'packing' ? l.qty_picked : l.qty_shipped}</td>
            {doc !== 'packing' && <><td className="text-right tabular-nums">{formatMoney(l.unit_price)}</td><td className="text-right tabular-nums">{formatMoney(l.qty_shipped * l.unit_price)}</td></>}
          </tr>
        ))}</tbody>
        <tfoot>
          <tr className="font-semibold"><td colSpan={4} className="py-2 text-right">Total pièces</td><td className="text-right tabular-nums">{doc === 'packing' ? lines.reduce((n, l) => n + l.qty_picked, 0) : totalQty}</td>{doc !== 'packing' && <><td /><td className="text-right tabular-nums">{formatMoney(totalValue)} {s.currency}</td></>}</tr>
        </tfoot>
      </table>
    </main>
  )
}

import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import { clientLetteringAction, supplierLetteringAction, clientDisputeOpenAction, clientDisputeResolveAction, supplierDisputeAction } from '@/features/finance/lettering-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Lettrage et échéances' }

type Currency = { currency: string; balance: number; balance_base: number; disputed: number; not_due: number; overdue_1_30: number; overdue_31_60: number; overdue_61_90: number; overdue_plus_90: number }
type Item = { code?: string; number?: string; invoice?: string; supplier_invoice?: string; currency: string; due_date: string; balance: number; balance_base: number; disputed?: number; bucket: string; letters: string[]; status?: string }
type Statement = { currencies: Currency[]; items: Item[]; settled_items: number; base_currency: string }

const money = (v: unknown) => new Intl.NumberFormat('fr-FR', { style: 'decimal', minimumFractionDigits: 2 }).format(Number(v ?? 0))
const BUCKET: Record<string, string> = { non_echu: 'Non échu', '1_30': '1-30 j', '31_60': '31-60 j', '61_90': '61-90 j', plus_90: '> 90 j' }

/** Lettrage partiel, litiges et échéances d'un tiers. Soldes par devise d'origine et équivalent figé ; aucun mélange client / fournisseur. */
export default async function LetteringPage({ searchParams }: { searchParams: Promise<{ side?: string; id?: string }> }) {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canPay = ctx.permissions.includes(P.PAYMENTS_WRITE)
  const canFinance = ctx.permissions.includes(P.FINANCE_WRITE)
  const sp = await searchParams
  const side = sp.side === 'supplier' ? 'supplier' : sp.side === 'client' ? 'client' : null
  const id = /^[0-9a-f-]{36}$/i.test(sp.id ?? '') ? (sp.id as string) : null
  const supabase = await createClient()

  const [clients, suppliers, disputes] = await Promise.all([
    supabase.from('clients').select('id,code,name').order('name').limit(200),
    supabase.from('suppliers').select('id,code,name').order('name').limit(200),
    supabase.from('client_invoice_disputes').select('id,invoice_id,amount,reason').eq('status', 'open').limit(100),
  ])

  let statement: Statement | null = null
  let error: string | null = null
  if (side && id) {
    const res = side === 'client'
      ? await supabase.rpc('client_statement', { p_client: id })
      : await supabase.rpc('supplier_statement', { p_supplier: id })
    if (res.error) error = res.error.message
    else statement = res.data as Statement
  }

  return (
    <>
      <PageHeader title="Lettrage et échéances" description="Règlements répartis sur plusieurs pièces d'un même tiers, litiges, échéances et soldes par devise. Les encours clients et fournisseurs ne sont jamais compensés entre eux." />
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Clients</CardTitle></CardHeader>
            <CardContent className="max-h-64 overflow-y-auto">
              <ul className="space-y-1 text-sm">{(clients.data ?? []).map((c) => (
                <li key={c.id}><Link className="hover:underline" href={`/finance/lettrage?side=client&id=${c.id}`}>{c.name} <span className="text-ink-soft">{c.code}</span></Link></li>))}</ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Fournisseurs</CardTitle></CardHeader>
            <CardContent className="max-h-64 overflow-y-auto">
              <ul className="space-y-1 text-sm">{(suppliers.data ?? []).map((f) => (
                <li key={f.id}><Link className="hover:underline" href={`/finance/lettrage?side=supplier&id=${f.id}`}>{f.name} <span className="text-ink-soft">{f.code}</span></Link></li>))}</ul>
            </CardContent>
          </Card>
        </div>

        {error && <p className="rounded-md border border-warn-bg bg-warn-bg px-3 py-2 text-sm text-warn-text">Solde indisponible : {error}</p>}

        {statement && side && id && (
          <>
            <Card>
              <CardHeader><CardTitle>Solde {side === 'client' ? 'client' : 'fournisseur'} (devise d’origine)</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto p-0">
                {statement.currencies.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucun encours. Pièces soldées : {statement.settled_items}.</p> : (
                  <table className="w-full min-w-[48rem] text-sm">
                    <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Devise</th><th className="font-medium">Solde</th><th className="font-medium">Équivalent {statement.base_currency}</th><th className="font-medium">Litige</th><th className="font-medium">Non échu</th><th className="font-medium">1-30 j</th><th className="font-medium">31-60 j</th><th className="font-medium">61-90 j</th><th className="font-medium">&gt; 90 j</th></tr></thead>
                    <tbody>{statement.currencies.map((c) => (
                      <tr key={c.currency} className="border-t border-line"><td className="px-4 py-2 font-medium">{c.currency}</td><td>{money(c.balance)}</td><td>{money(c.balance_base)}</td><td>{money(c.disputed)}</td>
                        <td>{money(c.not_due)}</td><td>{money(c.overdue_1_30)}</td><td>{money(c.overdue_31_60)}</td><td>{money(c.overdue_61_90)}</td><td>{money(c.overdue_plus_90)}</td></tr>))}</tbody>
                  </table>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Pièces ouvertes ({statement.items.length}) — soldées : {statement.settled_items}</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto p-0">
                {statement.items.length === 0 ? <p className="p-6 text-sm text-ink-soft">Aucune pièce ouverte.</p> : (
                  <table className="w-full min-w-[48rem] text-sm">
                    <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Pièce</th><th className="font-medium">Échéance</th><th className="font-medium">Devise</th><th className="font-medium">Solde</th><th className="font-medium">Équivalent</th><th className="font-medium">Litige</th><th className="font-medium">Échéancier</th><th className="font-medium">Lettres</th></tr></thead>
                    <tbody>{statement.items.map((it) => (
                      <tr key={it.code ?? it.number} className="border-t border-line"><td className="px-4 py-2 font-medium">{it.code ?? it.number}</td><td>{it.due_date}</td><td>{it.currency}</td>
                        <td>{money(it.balance)}</td><td>{money(it.balance_base)}</td><td>{money(it.disputed ?? 0)}</td><td>{BUCKET[it.bucket] ?? it.bucket}</td><td>{it.letters?.join(', ') || '—'}</td></tr>))}</tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {side === 'client' && canPay && (
              <Card>
                <CardHeader><CardTitle>Lettrer un règlement client</CardTitle></CardHeader>
                <CardContent>
                  <TaxForm action={clientLetteringAction} submit="Lettrer" fields={[
                    { name: 'client', label: 'Client (identifiant)', required: true },
                    { name: 'amount', label: 'Montant du règlement', type: 'number', required: true },
                    { name: 'paid_on', label: 'Date', type: 'date', required: true },
                    { name: 'method', label: 'Mode (transfer, cheque, lc, cash, card, other)' },
                    { name: 'reference', label: 'Référence' },
                    { name: 'allocations', label: 'Affectations « id-pièce:montant ; … »', required: true }]} hidden={{ client: id }} />
                  <p className="mt-2 text-xs text-ink-soft">Somme des affectations = montant du règlement ; une seule devise par règlement.</p>
                </CardContent>
              </Card>
            )}
            {side === 'supplier' && canFinance && (
              <Card>
                <CardHeader><CardTitle>Lettrer un règlement fournisseur</CardTitle></CardHeader>
                <CardContent>
                  <TaxForm action={supplierLetteringAction} submit="Lettrer" fields={[
                    { name: 'amount', label: 'Montant du règlement', type: 'number', required: true },
                    { name: 'paid_on', label: 'Date', type: 'date', required: true },
                    { name: 'method', label: 'Mode' },
                    { name: 'reference', label: 'Référence' },
                    { name: 'allocations', label: 'Affectations « id-facture:montant ; … »', required: true }]} hidden={{ supplier: id }} />
                </CardContent>
              </Card>
            )}
            {side === 'client' && canFinance && (
              <Card>
                <CardHeader><CardTitle>Litige client</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <TaxForm action={clientDisputeOpenAction} submit="Ouvrir le litige" fields={[
                    { name: 'invoice', label: 'Identifiant de la pièce', required: true },
                    { name: 'amount', label: 'Montant contesté', type: 'number', required: true },
                    { name: 'reason', label: 'Motif', required: true }]} />
                  <ul className="space-y-2 text-sm">{(disputes.data ?? []).map((d) => (
                    <li key={d.id} className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
                      <span>Litige {money(d.amount)} — {d.reason}</span>
                      <TaxForm action={clientDisputeResolveAction} hidden={{ id: d.id }} submit="Résoudre" fields={[{ name: 'resolution', label: 'Résolution', required: true }]} />
                    </li>))}</ul>
                </CardContent>
              </Card>
            )}
            {side === 'supplier' && canFinance && (
              <Card>
                <CardHeader><CardTitle>Contester une facture fournisseur</CardTitle></CardHeader>
                <CardContent>
                  <TaxForm action={supplierDisputeAction} submit="Contester" fields={[
                    { name: 'invoice', label: 'Identifiant de la facture', required: true },
                    { name: 'reason', label: 'Motif', required: true }]} />
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </>
  )
}

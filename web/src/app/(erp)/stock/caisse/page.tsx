import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import {
  posRegisterCreateAction, posMethodCreateAction, posSessionOpenAction, posTicketCreateAction, posTicketReverseAction,
  posSessionCloseAction, posSessionVisaAction, posDepositAction,
} from '@/features/pos/pos-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Caisse magasin' }

const money = (v: unknown) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2 }).format(Number(v)))

/** Caisses, modes de paiement, sessions (ventes, annulation, clôture, visa, dépôt) et rapprochement du stock magasin. */
export default async function CaissePage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const ctx = await requirePermission(P.POS_READ)
  const canAdmin = ctx.permissions.includes(P.POS_ADMIN)
  const canSell = ctx.permissions.includes(P.POS_SELL)
  const canClose = ctx.permissions.includes(P.POS_CLOSE)
  const canSupervise = ctx.permissions.includes(P.POS_SUPERVISE)
  const sp = await searchParams
  const warehouse = /^[0-9a-f-]{36}$/.test(sp.warehouse ?? '') ? (sp.warehouse as string) : null
  const supabase = await createClient()

  const [registers, methods, sessions, tickets, shops] = await Promise.all([
    supabase.from('pos_registers').select('id,code,label,warehouse_id,active').order('code').limit(50),
    supabase.from('pos_payment_methods').select('id,code,label,kind,refund_allowed,active').order('code').limit(50),
    supabase.from('pos_sessions').select('id,register_id,opening_float,status,variance_total,visa_required,visa_by,opened_at').order('opened_at', { ascending: false }).limit(40),
    supabase.from('pos_tickets').select('id,code,kind,total,session_id,created_at').order('created_at', { ascending: false }).limit(60),
    supabase.from('warehouses').select('id,code,name').eq('kind', 'shop').is('archived_at', null).limit(50),
  ])
  const regRows = (registers.data ?? []) as { id: string; code: string; label: string; warehouse_id: string; active: boolean }[]
  const methodRows = (methods.data ?? []) as { id: string; code: string; label: string; kind: string; refund_allowed: boolean; active: boolean }[]
  const sessionRows = (sessions.data ?? []) as { id: string; register_id: string; opening_float: number; status: string; variance_total: number | null; visa_required: boolean | null; visa_by: string | null }[]
  const ticketRows = (tickets.data ?? []) as { id: string; code: string; kind: string; total: number; session_id: string }[]
  const regCode = new Map(regRows.map((r) => [r.id, r.code]))
  const reconcile = warehouse && ctx.permissions.includes(P.POS_READ)
    ? await supabase.rpc('pos_stock_reconcile', { p_warehouse: warehouse }) : null

  return (
    <>
      <PageHeader title="Caisse magasin" description="Caisses rattachées aux boutiques, sessions à fonds saisi, tickets dont les montants sont lus sur les variantes, annulation par contre-passation, clôture avec écart visible, visa d’une autre personne, dépôts et rapprochement du stock magasin." />
      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <CardHeader><CardTitle>Caisses et modes de paiement</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-ink-soft">Aucun mode de paiement ni fonds de caisse n’est fourni par défaut : ils se saisissent ici. Les règles fiscales de caisse restent à valider par l’expert-comptable.</p>
            <ul className="space-y-1">{regRows.map((r) => <li key={r.id}>{r.code} · {r.label} <span className="text-ink-soft">({r.id})</span></li>)}</ul>
            <ul className="space-y-1">{methodRows.map((m) => <li key={m.id}>{m.code} · {m.label} · {m.kind} · {m.refund_allowed ? 'remboursable' : 'non remboursable'} <span className="text-ink-soft">({m.id})</span></li>)}</ul>
            {canAdmin && <TaxForm action={posRegisterCreateAction} submit="Créer la caisse" fields={[
              { name: 'warehouse', label: 'Boutique (identifiant)', required: true }, { name: 'code', label: 'Code', required: true }, { name: 'label', label: 'Libellé', required: true }]} />}
            {canAdmin && <TaxForm action={posMethodCreateAction} submit="Créer le mode" fields={[
              { name: 'code', label: 'Code', required: true }, { name: 'label', label: 'Libellé', required: true },
              { name: 'kind', label: 'Nature (cash, card, cheque, transfer, other)', required: true }, { name: 'refund', label: 'Remboursable (on)', placeholder: 'on' }]} />}
            {(shops.data ?? []).length > 0 && <p className="text-ink-soft">Boutiques : {(shops.data ?? []).map((w: { code: string; name: string; id: string }) => `${w.code} ${w.name} (${w.id})`).join(' · ')}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Sessions de caisse</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {sessionRows.map((s) => (
              <div key={s.id} className="space-y-1 border-t border-line pt-2">
                <p className="font-medium">{regCode.get(s.register_id)} · session {s.id} · fonds {money(s.opening_float)} · {s.status === 'open' ? 'ouverte' : `close, écart ${money(s.variance_total)}${s.visa_required ? (s.visa_by ? ', visée' : ', visa à faire') : ''}`}</p>
                {s.status === 'open' && canSell && <TaxForm action={posTicketCreateAction} hidden={{ session: s.id }} submit="Enregistrer le ticket" fields={[
                  { name: 'lines', label: 'Lignes JSON [{variant, qty, vat_code}]', required: true, multiline: true },
                  { name: 'payments', label: 'Paiements JSON [{method, amount}]', required: true, multiline: true }]} />}
                {s.status === 'open' && canClose && <TaxForm action={posSessionCloseAction} hidden={{ session: s.id }} submit="Clôturer la caisse" fields={[
                  { name: 'counts', label: 'Comptage JSON [{method, counted}] (espèces et modes utilisés)', required: true, multiline: true }]} />}
                {s.status === 'closed' && s.visa_required && !s.visa_by && canSupervise && <TaxForm action={posSessionVisaAction} hidden={{ session: s.id }} submit="Viser l’écart" fields={[
                  { name: 'note', label: 'Motif du visa', required: true }]} />}
                {s.status === 'closed' && canClose && <TaxForm action={posDepositAction} hidden={{ session: s.id }} submit="Enregistrer un dépôt" fields={[
                  { name: 'amount', label: 'Montant', type: 'number', required: true }, { name: 'reference', label: 'Référence', required: true }]} />}
              </div>))}
            {canSell && regRows.filter((r) => r.active && !sessionRows.some((s) => s.register_id === r.id && s.status === 'open')).map((r) => (
              <TaxForm key={r.id} action={posSessionOpenAction} hidden={{ register: r.id }} submit={`Ouvrir ${r.code}`} fields={[
                { name: 'float', label: 'Fonds de caisse', type: 'number', required: true }]} />))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Tickets récents</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {ticketRows.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-2">
                <span>{t.code} · {t.kind === 'sale' ? 'vente' : 'annulation'} · {money(t.total)} · {t.id}</span>
                {t.kind === 'sale' && canSell && <TaxForm action={posTicketReverseAction} hidden={{ ticket: t.id }} submit="Annuler par contre-passation" fields={[{ name: 'reason', label: 'Motif', required: true }]} />}
              </div>))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Rapprochement du stock magasin</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <form method="get" className="flex items-end gap-2">
              <label className="flex flex-col gap-1">Boutique (identifiant)<input name="warehouse" defaultValue={warehouse ?? ''} className="h-8 rounded-md border border-line-strong px-2" /></label>
              <button className="h-8 rounded-md border border-line-strong px-3 font-medium">Rapprocher</button>
            </form>
            {reconcile?.error && <p className="text-warn-text">{reconcile.error.message}</p>}
            {reconcile?.data && (
              <table className="w-full min-w-[40rem]">
                <thead className="text-left text-xs text-ink-soft"><tr><th className="py-2">Article</th><th>Stock</th><th>Ventes nettes</th><th>Mouvements caisse</th><th>Solde mouvements</th><th>Rapproché</th></tr></thead>
                <tbody>{((reconcile.data ?? []) as { sku: string; on_hand: number; pos_net_sold: number; pos_moves: number; moves_balance: number; ok: boolean }[]).map((r) => (
                  <tr key={r.sku} className="border-t border-line"><td className="py-2">{r.sku}</td><td>{r.on_hand}</td><td>{r.pos_net_sold}</td><td>{r.pos_moves}</td><td>{r.moves_balance}</td><td>{r.ok ? 'oui' : 'écart'}</td></tr>))}</tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}

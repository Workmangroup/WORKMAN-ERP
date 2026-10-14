import type { Metadata } from 'next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RpcButton } from '@/features/stock/components/rpc-button'
import { TaxForm } from '@/features/finance/components/tax-form'
import {
  collectionPolicyCreateAction, collectionPolicyValidateAction, collectionScoreModelCreateAction, collectionScoreModelValidateAction, collectionScoresRunAction,
  promiseCreateAction, promiseFollowUpAction, promiseCancelAction, planCreateAction, planValidateAction, planFollowUpAction,
  remindersGenerateAction, draftApproveAction, draftAuthorizeSendAction, escalationsRunAction, escalationCloseAction,
} from '@/features/finance/collections-actions'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Recouvrement' }

const money = (v: unknown) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2 }).format(Number(v)))
const STATUS: Record<string, string> = {
  a_valider: 'à signer', valide: 'signée', solde: 'soldé', rompu: 'rompu', rejete: 'rejeté', open: 'ouverte', kept: 'tenue', broken: 'rompue', cancelled: 'annulée',
  brouillon: 'brouillon', approuve: 'approuvé', envoi_autorise: 'envoi autorisé', annule: 'annulé', pending: 'à venir', paid: 'couverte', late: 'en retard',
}

/** Balance âgée (hors litige), politique, promesses, plans, brouillons de relance, escalades et scores. Aucun envoi sans autorisation. */
export default async function RecouvrementPage({ searchParams }: { searchParams: Promise<{ as_of?: string }> }) {
  const ctx = await requirePermission(P.FINANCE_READ)
  const canWrite = ctx.permissions.includes(P.COLLECTIONS_WRITE)
  const canValidate = ctx.permissions.includes(P.COLLECTIONS_VALIDATE)
  const sp = await searchParams
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(sp.as_of ?? '') ? (sp.as_of as string) : new Date().toISOString().slice(0, 10)
  const supabase = await createClient()

  const [aging, policies, models, promises, plans, lines, drafts, escalations, scores] = await Promise.all([
    supabase.rpc('collection_aging', { p_as_of: asOf }),
    supabase.from('collection_policies').select('id,code,effective_from,contact_frequency_days,level2_from_days,level3_from_days,suspension_from_days,suspend_on_dispute,suspend_during_commitment,external_send_authorized,status').order('effective_from', { ascending: false }).limit(20),
    supabase.from('collection_score_models').select('id,code,effective_from,weight_days_late,weight_broken_promises,weight_open_disputes,weight_broken_plans,band_high_from,status').order('effective_from', { ascending: false }).limit(20),
    supabase.from('collection_promises').select('id,invoice_id,amount,promised_on,status,closed_reason').order('created_at', { ascending: false }).limit(50),
    supabase.from('payment_plans').select('id,client_id,total_base,status').order('created_at', { ascending: false }).limit(30),
    supabase.from('payment_plan_lines').select('id,plan_id,seq,due_on,amount,status').order('due_on').limit(200),
    supabase.from('collection_reminder_drafts').select('id,invoice_id,level,days_late,exigible_base,body,status').order('created_at', { ascending: false }).limit(80),
    supabase.from('collection_escalations').select('id,reason,status,resolution,invoice_id,promise_id,plan_id').order('opened_at', { ascending: false }).limit(80),
    supabase.from('collection_scores').select('client_id,band,score,features,as_of').order('created_at', { ascending: false }).limit(60),
  ])
  const agingRows = (aging.data ?? []) as { client_id: string; client_code: string; client_name: string; not_due: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; disputed: number; total: number; fx_missing: number }[]
  const linesByPlan = new Map<string, { seq: number; due_on: string; amount: number; status: string }[]>()
  for (const l of (lines.data ?? []) as { plan_id: string; seq: number; due_on: string; amount: number; status: string }[]) {
    linesByPlan.set(l.plan_id, [...(linesByPlan.get(l.plan_id) ?? []), l])
  }

  return (
    <>
      <PageHeader title="Recouvrement" description="Balance âgée hors litige, politique de relance signée, promesses et plans suivis sur encaissements réels, brouillons de relance (aucun envoi sans autorisation), escalades et scores révisables." />
      <div className="space-y-4 p-4 sm:p-6">
        <Card>
          <CardHeader><CardTitle>Balance âgée au {asOf}</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="text-left text-xs text-ink-soft"><tr><th className="px-4 py-2 font-medium">Client</th><th className="font-medium">Non échu</th><th className="font-medium">1-30 j</th><th className="font-medium">31-60 j</th><th className="font-medium">61-90 j</th><th className="font-medium">+90 j</th><th className="font-medium">En litige</th><th className="font-medium">Total</th><th className="font-medium">Sans taux</th></tr></thead>
              <tbody>{agingRows.map((r) => (
                <tr key={r.client_id} className="border-t border-line"><td className="px-4 py-2">{r.client_code} · {r.client_name}</td><td>{money(r.not_due)}</td><td>{money(r.d1_30)}</td><td>{money(r.d31_60)}</td><td>{money(r.d61_90)}</td><td>{money(r.d90_plus)}</td><td>{money(r.disputed)}</td><td>{money(r.total)}</td><td>{r.fx_missing || '—'}</td></tr>))}</tbody>
            </table>
            <form method="get" className="flex items-end gap-2 p-4 text-sm">
              <label className="flex flex-col gap-1">Date<input name="as_of" type="date" defaultValue={asOf} className="h-8 rounded-md border border-line-strong px-2" /></label>
              <button className="h-8 rounded-md border border-line-strong px-3 font-medium">Afficher</button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Politique de recouvrement</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-ink-soft">Aucune valeur n’est fournie par défaut : tant qu’une politique n’est pas créée et signée, la relance et l’escalade sont refusées.</p>
            <ul className="space-y-1">{((policies.data ?? []) as Record<string, string | number | boolean>[]).map((p) => (
              <li key={String(p.id)} className="flex flex-wrap items-center gap-2">{p.code} · effet {String(p.effective_from)} · contact tous les {String(p.contact_frequency_days)} j · niveau 2 à {String(p.level2_from_days)} j · niveau 3 à {String(p.level3_from_days)} j · suspension à {String(p.suspension_from_days)} j · litige suspend : {p.suspend_on_dispute ? 'oui' : 'non'} · engagement suspend : {p.suspend_during_commitment ? 'oui' : 'non'} · envoi externe : {p.external_send_authorized ? 'autorisé' : 'interdit'} · {STATUS[String(p.status)] ?? String(p.status)}
                {p.status === 'a_valider' && canValidate && <RpcButton action={collectionPolicyValidateAction} fields={{ id: String(p.id), validate: 'true' }} variant="secondary">Signer</RpcButton>}</li>))}</ul>
            {canWrite && <TaxForm action={collectionPolicyCreateAction} submit="Créer la politique" fields={[
              { name: 'code', label: 'Code', required: true }, { name: 'effective_from', label: 'Date d’effet', type: 'date', required: true },
              { name: 'contact_days', label: 'Contact (jours)', type: 'number', required: true }, { name: 'level2_days', label: 'Niveau 2 à (jours de retard)', type: 'number', required: true },
              { name: 'level3_days', label: 'Niveau 3 à (jours)', type: 'number', required: true }, { name: 'suspension_days', label: 'Suspension recommandée à (jours)', type: 'number', required: true },
              { name: 'suspend_dispute', label: 'Litige suspend la relance (on)', placeholder: 'on' }, { name: 'suspend_commitment', label: 'Engagement suspend la relance (on)', placeholder: 'on' },
              { name: 'external_send', label: 'Envoi externe autorisé (on)', placeholder: 'on' }]} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Promesses de paiement</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">{((promises.data ?? []) as { id: string; invoice_id: string; amount: number; promised_on: string; status: string; closed_reason: string | null }[]).map((p) => (
              <li key={p.id}>{p.promised_on} · pièce {p.invoice_id} · {money(p.amount)} · {STATUS[p.status] ?? p.status}{p.closed_reason ? ` (${p.closed_reason})` : ''}
                {p.status === 'open' && canWrite && <TaxForm action={promiseCancelAction} hidden={{ id: p.id }} submit="Annuler" fields={[{ name: 'reason', label: 'Motif', required: true }]} />}</li>))}</ul>
            {canWrite && <TaxForm action={promiseCreateAction} submit="Enregistrer la promesse" fields={[
              { name: 'invoice', label: 'Pièce (identifiant)', required: true }, { name: 'amount', label: 'Montant (devise de la pièce)', type: 'number', required: true },
              { name: 'promised_on', label: 'Date promise', type: 'date', required: true }, { name: 'note', label: 'Note' }]} />}
            {canWrite && <RpcButton action={promiseFollowUpAction} fields={{ as_of: asOf }} variant="secondary">Mettre à jour le suivi</RpcButton>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Plans de paiement</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {((plans.data ?? []) as { id: string; client_id: string; total_base: number; status: string }[]).map((p) => (
              <div key={p.id} className="space-y-1 border-t border-line pt-2">
                <p className="font-medium">Plan {p.id} · total {money(p.total_base)} · {STATUS[p.status] ?? p.status}
                  {p.status === 'a_valider' && canValidate && <> <RpcButton action={planValidateAction} fields={{ id: p.id, validate: 'true' }} variant="secondary">Signer</RpcButton></>}</p>
                <ul className="pl-4">{(linesByPlan.get(p.id) ?? []).map((l) => (
                  <li key={`${p.id}-${l.seq}`}>échéance {l.seq} · {l.due_on} · {money(l.amount)} · {STATUS[l.status] ?? l.status}</li>))}</ul>
              </div>))}
            {canWrite && <RpcButton action={planFollowUpAction} fields={{ as_of: asOf }} variant="secondary">Suivre les plans</RpcButton>}
            {canWrite && <TaxForm action={planCreateAction} submit="Créer le plan" fields={[
              { name: 'client', label: 'Client (identifiant)', required: true },
              { name: 'lines', label: 'Échéancier JSON [{due_on, amount}] en devise de base', required: true, multiline: true }]} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Brouillons de relance</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-2">{((drafts.data ?? []) as { id: string; invoice_id: string; level: number; days_late: number; exigible_base: number; body: string; status: string }[]).map((d) => (
              <li key={d.id} className="space-y-1 border-t border-line pt-2">
                <p>Niveau {d.level} · pièce {d.invoice_id} · {d.days_late} j de retard · exigible {money(d.exigible_base)} · {STATUS[d.status] ?? d.status}</p>
                <p className="text-ink-soft">{d.body}</p>
                <div className="flex flex-wrap gap-2">
                  {d.status === 'brouillon' && canValidate && <RpcButton action={draftApproveAction} fields={{ id: d.id, approve: 'true' }} variant="secondary">Approuver</RpcButton>}
                  {d.status === 'brouillon' && canValidate && <RpcButton action={draftApproveAction} fields={{ id: d.id, approve: 'false' }} variant="secondary">Annuler</RpcButton>}
                  {d.status === 'approuve' && canValidate && <RpcButton action={draftAuthorizeSendAction} fields={{ id: d.id }} variant="secondary">Autoriser l’envoi</RpcButton>}
                </div>
              </li>))}</ul>
            {canWrite && <RpcButton action={remindersGenerateAction} fields={{ as_of: asOf }}>Générer les brouillons</RpcButton>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Escalades</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">{((escalations.data ?? []) as { id: string; reason: string; status: string; resolution: string | null; invoice_id: string | null; promise_id: string | null; plan_id: string | null }[]).map((e) => (
              <li key={e.id}>{e.reason} · {e.status === 'open' ? 'ouverte' : `clôturée : ${e.resolution ?? ''}`}
                {e.status === 'open' && canWrite && <TaxForm action={escalationCloseAction} hidden={{ id: e.id }} submit="Clôturer" fields={[{ name: 'resolution', label: 'Motif de clôture', required: true }]} />}</li>))}</ul>
            {canWrite && <RpcButton action={escalationsRunAction} fields={{ as_of: asOf }}>Calculer les escalades</RpcButton>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Scores clients (révisables par modèle)</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1">{((models.data ?? []) as { id: string; code: string; effective_from: string; status: string; band_high_from: number }[]).map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">{m.code} · effet {m.effective_from} · seuil élevé {money(m.band_high_from)} · {STATUS[m.status] ?? m.status} <span className="text-ink-soft">({m.id})</span>
                {m.status === 'a_valider' && canValidate && <RpcButton action={collectionScoreModelValidateAction} fields={{ id: m.id, validate: 'true' }} variant="secondary">Signer</RpcButton>}</li>))}</ul>
            <ul className="space-y-1 text-ink-soft">{((scores.data ?? []) as { client_id: string; band: string; score: number }[]).slice(0, 20).map((s) => (
              <li key={`${s.client_id}-${s.score}`}>client {s.client_id} · score {money(s.score)} · {s.band === 'eleve' ? 'élevé' : 'standard'}</li>))}</ul>
            {canWrite && <TaxForm action={collectionScoreModelCreateAction} submit="Créer le modèle" fields={[
              { name: 'code', label: 'Code', required: true }, { name: 'effective_from', label: 'Date d’effet', type: 'date', required: true },
              { name: 'w_days', label: 'Poids jours de retard', type: 'number', required: true }, { name: 'w_broken_promises', label: 'Poids promesses rompues', type: 'number', required: true },
              { name: 'w_open_disputes', label: 'Poids litiges ouverts', type: 'number', required: true }, { name: 'w_broken_plans', label: 'Poids plans rompus', type: 'number', required: true },
              { name: 'band_high_from', label: 'Seuil « élevé »', type: 'number', required: true }]} />}
            {canWrite && <TaxForm action={collectionScoresRunAction} submit="Calculer les scores" fields={[
              { name: 'model', label: 'Modèle signé (identifiant)', required: true }, { name: 'as_of', label: 'Date', type: 'date', required: true }]} />}
          </CardContent>
        </Card>
      </div>
    </>
  )
}

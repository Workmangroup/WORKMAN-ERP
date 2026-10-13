import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ActionForm } from '@/features/commercial/components/crm-forms'
import {
  marketingCampaignCreateAction, marketingCampaignPrepareAction, marketingCampaignSendAction, marketingPhoneAuthorizeAction,
  marketingPolicySetAction, marketingPriceSetAction, marketingSegmentCreateAction, marketingTemplateApproveAction,
  marketingTemplateCreateAction,
} from '@/features/commercial/marketing-actions'
import { clientOptions } from '@/features/commercial/services/commercial.service'
import { marketingOverview } from '@/features/commercial/services/marketing.service'
import { fmtDay } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Marketing' }

const CH: Record<string, string> = { email: 'E-mail', sms: 'SMS', whatsapp: 'WhatsApp' }
const REASON: Record<string, string> = { no_consent: 'sans consentement', unsubscribed: 'désinscrit', suppressed: 'liste de suppression' }
const inputCls = 'rounded-md border border-line bg-white px-3 py-2 text-sm'
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="grid gap-1 text-sm">{label}{children}</label>

export default async function MarketingPage() {
  const ctx = await requirePermission(P.MARKETING_READ)
  const can = (p: string) => ctx.permissions.includes(p)
  const [o, clients] = await Promise.all([marketingOverview(), can(P.MARKETING_WRITE) ? clientOptions() : Promise.resolve([])])
  const summaryOf = new Map(o.summaries.map((s) => [s.campaign_id, s]))
  const approved = o.templates.filter((t) => t.status === 'approved')
  return (
    <>
      <PageHeader title="Marketing et canaux" description="Rien n’est envoyé sans connecteur homologué et politique d’envoi activée. Une désinscription exclut le client du canal ; une préparation est rejouable." />
      <div className="space-y-4 p-4 sm:p-6">
        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Politique d’envoi</h2>
          <p className="mt-2 text-sm">
            Envoi : <Badge tone={o.policy?.send_enabled ? 'warning' : 'neutral'}>{o.policy?.send_enabled ? 'activé par la politique' : 'désactivé'}</Badge>{' '}
            · canaux autorisés : {o.policy?.enabled_channels?.length ? o.policy.enabled_channels.map((c) => CH[c] ?? c).join(', ') : 'aucun'}{' '}
            · connecteur : <span className="font-semibold">aucun homologué</span>
          </p>
          {can(P.MARKETING_CONFIGURE) && (
            <div className="mt-3">
              <ActionForm action={marketingPolicySetAction} submit="Enregistrer la politique">
                <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" name="send_enabled" className="h-4 w-4" />Activer la politique d’envoi (sans connecteur, l’envoi reste refusé)</label>
                <fieldset className="flex flex-wrap gap-4 text-sm md:col-span-2">
                  {Object.entries(CH).map(([k, v]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" name="channels" value={k} className="h-4 w-4" />{v}</label>)}
                </fieldset>
              </ActionForm>
            </div>
          )}
        </section>

        {can(P.MARKETING_CONFIGURE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Tarif par canal (estimation de coût)</h2>
            <p className="mt-1 text-xs text-ink-soft">Dernier tarif : {o.prices.length ? o.prices.map((p) => `${CH[p.channel] ?? p.channel} ${p.unit_price} ${p.currency}`).join(' · ') : 'aucun (pas d’estimation).'}</p>
            <div className="mt-3">
              <ActionForm action={marketingPriceSetAction} submit="Enregistrer le tarif">
                <Field label="Canal"><select name="channel" className={inputCls}>{Object.entries(CH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Devise (ex. EUR)"><input name="currency" maxLength={3} required className={inputCls} /></Field>
                <Field label="Prix unitaire"><input name="unit_price" inputMode="decimal" required className={inputCls} /></Field>
              </ActionForm>
            </div>
          </section>
        )}

        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Modèles</h2>
          {can(P.MARKETING_WRITE) && (
            <div className="mt-3">
              <ActionForm action={marketingTemplateCreateAction} submit="Créer le modèle (brouillon)">
                <Field label="Canal"><select name="channel" className={inputCls}>{Object.entries(CH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Nom"><input name="name" required minLength={2} maxLength={120} className={inputCls} /></Field>
                <Field label="Objet (e-mail uniquement)"><input name="subject" maxLength={150} className={inputCls} /></Field>
                <Field label="Texte — variables : {{client}}, {{desinscription}} (obligatoire)"><textarea name="body" required minLength={10} maxLength={2000} rows={4} className={inputCls} /></Field>
              </ActionForm>
            </div>
          )}
          <ul className="mt-4 divide-y divide-line text-sm">
            {o.templates.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-semibold">{t.name}</span><span className="text-ink-soft">{CH[t.channel]}</span>
                <Badge tone={t.status === 'approved' ? 'success' : 'neutral'}>{t.status === 'approved' ? 'Approuvé' : 'Brouillon'}</Badge>
                {t.status === 'draft' && can(P.MARKETING_WRITE) && (
                  <div className="w-full sm:w-auto"><ActionForm action={marketingTemplateApproveAction} submit="Approuver (autre personne que l’auteur)"><input type="hidden" name="id" value={t.id} /></ActionForm></div>
                )}
              </li>
            ))}
            {o.templates.length === 0 && <li className="py-2 text-ink-soft">Aucun modèle.</li>}
          </ul>
        </section>

        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Segments</h2>
          {can(P.MARKETING_WRITE) && (
            <div className="mt-3">
              <ActionForm action={marketingSegmentCreateAction} submit="Créer le segment">
                <Field label="Nom"><input name="name" required minLength={2} maxLength={120} className={inputCls} /></Field>
                <Field label="Canal"><select name="channel" className={inputCls}>{Object.entries(CH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Pays (facultatif, ex. TN)"><input name="country" maxLength={2} className={inputCls} /></Field>
                <Field label="Clients (vide = tous les clients)"><select name="client_ids" multiple size={5} className={inputCls}>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              </ActionForm>
            </div>
          )}
          <p className="mt-3 text-xs text-ink-soft">{o.segments.length} segment(s) enregistré(s).</p>
        </section>

        {can(P.MARKETING_WRITE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Consentement SMS / WhatsApp</h2>
            <div className="mt-3">
              <ActionForm action={marketingPhoneAuthorizeAction} submit="Enregistrer le consentement">
                <Field label="Client"><select name="client_id" required className={inputCls}><option value="">Choisir…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                <Field label="Canal"><select name="channel" className={inputCls}><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></select></Field>
                <Field label="Numéro (format international, ex. +216…)"><input name="phone" required className={inputCls} /></Field>
                <Field label="Preuve du consentement"><input name="proof" required minLength={5} maxLength={300} className={inputCls} /></Field>
              </ActionForm>
            </div>
          </section>
        )}

        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Campagnes (brouillons)</h2>
          {can(P.MARKETING_WRITE) && (
            <div className="mt-3">
              <ActionForm action={marketingCampaignCreateAction} submit="Créer la campagne">
                <Field label="Nom"><input name="name" required minLength={2} maxLength={120} className={inputCls} /></Field>
                <Field label="Modèle approuvé"><select name="template_id" required className={inputCls}><option value="">Choisir…</option>{approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({CH[t.channel]})</option>)}</select></Field>
                <Field label="Segment"><select name="segment_id" required className={inputCls}><option value="">Choisir…</option>{o.segments.map((s) => <option key={s.id} value={s.id}>{s.name} ({CH[s.channel] ?? s.channel})</option>)}</select></Field>
              </ActionForm>
            </div>
          )}
          <ul className="mt-4 space-y-3">
            {o.campaigns.map((c) => {
              const s = summaryOf.get(c.id)
              return (
                <li key={c.id} className="rounded-md border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-semibold">{c.name}</span><span className="text-ink-soft">{CH[c.channel]}</span>
                    <Badge tone={c.status === 'prepared' ? 'brand' : 'neutral'}>{c.status === 'prepared' ? 'Préparée' : c.status === 'draft' ? 'Brouillon' : 'Annulée'}</Badge>
                    {c.prepared_at && <span className="text-xs text-ink-soft">préparée le {fmtDay(c.prepared_at)}</span>}
                  </div>
                  {s && (
                    <p className="mt-2 text-xs text-ink-soft">
                      Éligibles : <span className="font-semibold text-ink">{s.eligible}</span>
                      {Object.keys(s.excluded).length > 0 && <> · exclus : {Object.entries(s.excluded).map(([k, v]) => `${v} ${REASON[k] ?? k}`).join(', ')}</>}
                      {' '}· coût estimé : {s.estimated_cost === null ? 'non calculable (aucun tarif)' : `${s.estimated_cost} ${s.currency}`}
                      {Object.keys(s.events).length > 0 && <> · délivrabilité : {Object.entries(s.events).map(([k, v]) => `${k} ${v}`).join(', ')}</>}
                    </p>
                  )}
                  {can(P.MARKETING_WRITE) && c.status !== 'cancelled' && (
                    <div className="mt-2"><ActionForm action={marketingCampaignPrepareAction} submit={c.status === 'prepared' ? 'Re-préparer' : 'Préparer les destinataires'}><input type="hidden" name="id" value={c.id} /></ActionForm></div>
                  )}
                  {can(P.MARKETING_SEND) && c.status === 'prepared' && (
                    <div className="mt-2"><ActionForm action={marketingCampaignSendAction} submit="Demander l’envoi"><input type="hidden" name="id" value={c.id} /></ActionForm></div>
                  )}
                </li>
              )
            })}
            {o.campaigns.length === 0 && <li className="text-ink-soft">Aucune campagne.</li>}
          </ul>
        </section>
      </div>
    </>
  )
}

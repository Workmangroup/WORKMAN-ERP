import type { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { ActionForm } from '@/features/commercial/components/crm-forms'
import { batAcceptAction, batIssueAction, batRejectAction, logoRegisterAction, logoWithdrawAction, personalizationOperationAction, personalizationSpecAction } from '@/features/commercial/personalization-actions'
import { personalizationOverview } from '@/features/commercial/services/personalization.service'
import { clientOptions } from '@/features/commercial/services/commercial.service'
import { fmtDay } from '@/features/commercial/status'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Logos et BAT' }

const TECH: Record<string, string> = { embroidery: 'Broderie', screen_print: 'Sérigraphie', flock: 'Flocage', digital_print: 'Impression numérique' }
const STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'danger' | 'warning' }> = {
  issued: { label: 'En attente d’accord', tone: 'warning' }, approved: { label: 'Approuvé', tone: 'success' },
  rejected: { label: 'Refusé', tone: 'danger' }, superseded: { label: 'Remplacé / invalide', tone: 'neutral' },
}
const inputCls = 'rounded-md border border-line bg-white px-3 py-2 text-sm'
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="grid gap-1 text-sm">{label}{children}</label>

export default async function PersonalizationPage() {
  const ctx = await requirePermission(P.PERSONALIZATION_READ)
  const can = (p: string) => ctx.permissions.includes(p)
  const [o, clients] = await Promise.all([personalizationOverview(), clientOptions()])
  const clientName = new Map(clients.map((c) => [c.id, c.name]))
  const specById = new Map(o.specs.map((s) => [s.id, s]))
  const logoById = new Map(o.logos.map((l) => [l.id, l]))
  const docsOf = (client: string, key: string) => o.docs.filter((d) => d.client_id === client && d.folder?.system_key === key)
  const today = new Date().toISOString().slice(0, 10)
  return (
    <>
      <PageHeader title="Logos et BAT" description="Aucune opération de personnalisation sans BAT approuvé pour la version courante. Un accord se donne par un contact habilité, à une version et une empreinte précises." />
      <div className="space-y-4 p-4 sm:p-6">
        {can(P.PERSONALIZATION_WRITE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Logo et droits d’usage</h2>
            <div className="mt-3"><ActionForm action={logoRegisterAction} submit="Enregistrer le logo">
              <Field label="Client"><select name="client_id" required className={inputCls}><option value="">Choisir…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Pièce du dossier « logos » (id GED)"><input name="document_id" required className={inputCls} placeholder="Identifiant du document GED" /></Field>
              <Field label="Nom"><input name="name" required minLength={2} maxLength={120} className={inputCls} /></Field>
              <Field label="Nature des droits"><select name="rights_kind" className={inputCls}><option value="owned">Propriété du client</option><option value="licensed">Licence</option><option value="client_provided">Fourni par le client (preuve écrite)</option></select></Field>
              <Field label="Preuve des droits"><input name="rights_proof" required minLength={5} maxLength={300} className={inputCls} /></Field>
              <Field label="Droits valides jusqu’au (obligatoire pour une licence)"><input type="date" name="rights_valid_until" className={inputCls} /></Field>
            </ActionForm></div>
          </section>
        )}
        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Logos</h2>
          <ul className="mt-3 divide-y divide-line text-sm">
            {o.logos.map((l) => {
              const valid = !l.withdrawn_at && (!l.rights_valid_until || l.rights_valid_until >= today)
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-semibold">{l.name}</span><span className="text-ink-soft">{clientName.get(l.client_id) ?? '—'}</span>
                  <Badge tone={valid ? 'success' : 'danger'}>{l.withdrawn_at ? 'Retiré' : valid ? 'Droits valides' : 'Droits échus'}</Badge>
                  {l.rights_valid_until && <span className="text-xs text-ink-soft">jusqu’au {fmtDay(l.rights_valid_until)}</span>}
                  {can(P.PERSONALIZATION_WRITE) && !l.withdrawn_at && (
                    <div className="w-full sm:w-auto"><ActionForm action={logoWithdrawAction} submit="Retirer les droits"><input type="hidden" name="logo_id" value={l.id} /><Field label="Motif"><input name="reason" required minLength={5} maxLength={300} className={inputCls} /></Field></ActionForm></div>
                  )}
                </li>
              )
            })}
            {o.logos.length === 0 && <li className="py-2 text-ink-soft">Aucun logo enregistré.</li>}
          </ul>
        </section>

        {can(P.PERSONALIZATION_WRITE) && (
          <section className="rounded-md border border-line bg-white p-4 shadow-card">
            <h2 className="text-sm font-semibold">Personnalisation d’une ligne de commande</h2>
            <p className="mt-1 text-xs text-ink-soft">Toute modification crée une nouvelle version et invalide les BAT précédents.</p>
            <div className="mt-3"><ActionForm action={personalizationSpecAction} submit="Enregistrer la version">
              <Field label="Ligne de commande (id)"><input name="order_line_id" required className={inputCls} placeholder="Identifiant de la ligne" /></Field>
              <Field label="Logo"><select name="logo_id" required className={inputCls}><option value="">Choisir…</option>{o.logos.filter((l) => !l.withdrawn_at).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
              <Field label="Technique"><select name="technique" className={inputCls}>{Object.entries(TECH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Placement"><input name="placement" required minLength={2} maxLength={120} className={inputCls} /></Field>
              <Field label="Largeur (mm)"><input name="width_mm" required inputMode="decimal" className={inputCls} /></Field>
              <Field label="Hauteur (mm)"><input name="height_mm" required inputMode="decimal" className={inputCls} /></Field>
              <Field label="Couleurs (séparées par des virgules)"><input name="colors" required className={inputCls} /></Field>
              <Field label="Notes"><input name="notes" maxLength={500} className={inputCls} /></Field>
            </ActionForm></div>
          </section>
        )}

        <section className="rounded-md border border-line bg-white p-4 shadow-card">
          <h2 className="text-sm font-semibold">Versions courantes et BAT</h2>
          {o.specs.length === 0 ? <p className="mt-2 text-sm text-ink-soft">Aucune personnalisation.</p> : (
            <ul className="mt-3 space-y-4">
              {o.specs.map((s) => {
                const line = o.lines.find((l) => l.id === s.order_line_id)
                const bats = o.bats.filter((b) => b.spec_id === s.id)
                const approved = bats.find((b) => b.status === 'approved')
                const clientId = line?.order?.client_id ?? ''
                return (
                  <li key={s.id} className="rounded-md border border-line p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-semibold">{line?.order?.code ?? s.order_line_id} · {line?.article?.name ?? ''}</span>
                      <span>{TECH[s.technique] ?? s.technique} · {s.placement} · {s.width_mm}×{s.height_mm} mm · {s.colors.join(', ')}</span>
                      <span className="text-xs text-ink-soft">version {s.version_no} · logo {logoById.get(s.logo_id)?.name ?? '—'}</span>
                      <Badge tone={approved ? 'success' : 'warning'}>{approved ? 'BAT approuvé' : 'Aucun BAT approuvé'}</Badge>
                    </div>
                    {bats.length > 0 && (
                      <ul className="mt-2 divide-y divide-line">
                        {bats.map((b) => (
                          <li key={b.id} className="py-2">
                            <span>BAT v{b.version_no}</span> <Badge tone={STATUS[b.status]?.tone ?? 'neutral'}>{STATUS[b.status]?.label ?? b.status}</Badge>
                            <span className="ml-2 font-mono text-xs text-ink-soft">{b.pdf_sha256.slice(0, 12)}</span>
                            {b.status === 'approved' && <span className="ml-2 text-xs text-ink-soft">accord de {b.contact_name} le {fmtDay(b.accepted_on)} ({b.acceptance_channel}) — « {b.acceptance_proof} »</span>}
                            {b.status === 'rejected' && <span className="ml-2 text-xs text-ink-soft">refus : « {b.decision_note} »</span>}
                            {b.status === 'issued' && can(P.PERSONALIZATION_WRITE) && (
                              <div className="mt-2 grid gap-3 md:grid-cols-2">
                                <ActionForm action={batAcceptAction} submit="Enregistrer l’accord">
                                  <input type="hidden" name="bat_id" value={b.id} />
                                  <Field label="Contact habilité"><select name="contact_id" required className={inputCls}><option value="">Choisir…</option>{o.approvers.filter((c) => c.client_id === clientId).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Field>
                                  <Field label="Canal"><select name="channel" className={inputCls}><option value="email">E-mail</option><option value="signed_form">Formulaire signé</option><option value="portal">Portail</option><option value="meeting">Réunion</option></select></Field>
                                  <Field label="Empreinte du PDF reçu du client"><input name="pdf_sha256" required minLength={64} maxLength={64} className={inputCls} /></Field>
                                  <Field label="Date de l’accord"><input type="date" name="accepted_on" required max={today} className={inputCls} /></Field>
                                  <Field label="Preuve (référence du mail, formulaire…)"><input name="proof" required minLength={10} maxLength={500} className={inputCls} /></Field>
                                </ActionForm>
                                <ActionForm action={batRejectAction} submit="Enregistrer le refus">
                                  <input type="hidden" name="bat_id" value={b.id} />
                                  <Field label="Contact habilité"><select name="contact_id" required className={inputCls}><option value="">Choisir…</option>{o.approvers.filter((c) => c.client_id === clientId).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Field>
                                  <Field label="Motif du refus"><input name="note" required minLength={5} maxLength={300} className={inputCls} /></Field>
                                </ActionForm>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {can(P.PERSONALIZATION_WRITE) && (
                      <div className="mt-3"><ActionForm action={batIssueAction} submit="Émettre un BAT pour cette version">
                        <input type="hidden" name="spec_id" value={s.id} />
                        <Field label="PDF du BAT (dossier « bat » du client)"><select name="document_id" required className={inputCls}><option value="">Choisir…</option>{docsOf(clientId, 'bat').filter((d) => d.sha256).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
                      </ActionForm></div>
                    )}
                    {can(P.PERSONALIZATION_OPERATE) && approved && (
                      <div className="mt-3"><ActionForm action={personalizationOperationAction} submit="Lancer la personnalisation"><input type="hidden" name="spec_id" value={s.id} /></ActionForm></div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}

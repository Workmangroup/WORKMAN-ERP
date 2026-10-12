'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { FileCheck2, Pencil, Plus, Trash2 } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from '@/components/auth/form-field'
import { SubmitButton } from '@/components/auth/submit-button'
import { CERT_STATE_INFO, CERT_STATUS, CERT_TYPES, NORM_SUGGESTIONS, certState, label } from '@/lib/products/options'
import { fmtDay } from '@/features/orders/status'
import { deleteCertAction, saveCertAction } from '../actions'
import type { ProductCert } from '../types'

/** Certifications du produit (normes, classe, n°, organisme, validité, justificatif GED) avec alertes d'échéance. */
export function CertificationsPanel({ productId, clientId, certs, docs, editable }: {
  productId: string; clientId: string; certs: ProductCert[]; docs: { id: string; title: string }[]; editable: boolean
}) {
  const [dlg, setDlg] = useState<null | { cert?: ProductCert }>(null)
  const [state, action] = useActionState(async (p: Parameters<typeof saveCertAction>[0], fd: FormData) => {
    const r = await saveCertAction(p, fd)
    if (r?.ok) setDlg(null)
    return r
  }, null)
  const errs = state?.fieldErrors ?? {}
  const c = dlg?.cert
  const v = (k: string, fb: string | null | undefined = '') => state?.values?.[k] ?? fb ?? ''
  const docTitle = new Map(docs.map((d) => [d.id, d.title]))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">{certs.length} certification(s). Les échéances à moins de 60 jours et les certificats expirés remontent en alerte dans la liste des produits.</p>
        {editable && <Button size="sm" onClick={() => setDlg({})}><Plus className="h-4 w-4" /> Ajouter une certification</Button>}
      </div>

      {certs.length === 0 ? <p className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">Aucune certification enregistrée.</p> : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {certs.map((x) => {
            const st = certState(x)
            const info = CERT_STATE_INFO[st]
            return (
              <li key={x.id} className="rounded-md border border-line bg-white p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold"><FileCheck2 className="h-4 w-4 text-brand-500" aria-hidden />{x.standard_code}{x.class_level && <Badge tone="brand">Classe {x.class_level}</Badge>}<Badge tone={info.tone}>{info.label}</Badge></p>
                    {x.label && <p className="text-sm text-ink-soft">{x.label}</p>}
                  </div>
                  {editable && (
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="ghost" size="sm" aria-label={`Modifier ${x.standard_code}`} onClick={() => setDlg({ cert: x })}><Pencil className="h-4 w-4" /></Button>
                      <form action={deleteCertAction} onSubmit={(e) => { if (!window.confirm(`Supprimer la certification ${x.standard_code} ?`)) e.preventDefault() }}>
                        <input type="hidden" name="id" value={x.id} /><input type="hidden" name="product_id" value={productId} />
                        <Button type="submit" variant="ghost" size="sm" aria-label={`Supprimer ${x.standard_code}`}><Trash2 className="h-4 w-4 text-danger-text" /></Button>
                      </form>
                    </div>
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-ink-soft">Type</dt><dd>{label(CERT_TYPES, x.cert_type)}</dd>
                  {x.certificate_no && <><dt className="text-ink-soft">N° de certificat</dt><dd className="font-mono">{x.certificate_no}</dd></>}
                  {x.issuer && <><dt className="text-ink-soft">Organisme</dt><dd>{x.issuer}</dd></>}
                  <dt className="text-ink-soft">Émission</dt><dd>{fmtDay(x.issued_on)}</dd>
                  <dt className="text-ink-soft">Validité</dt><dd className={st === 'expired' ? 'font-semibold text-danger-text' : st === 'expiring' ? 'font-semibold text-warn-text' : ''}>{x.valid_until ? fmtDay(x.valid_until) : 'Sans échéance'}</dd>
                  {x.ged_document_id && <><dt className="text-ink-soft">Justificatif</dt><dd>{docTitle.has(x.ged_document_id) ? <Link href={`/ged/${clientId}/${x.ged_document_id}`} className="text-brand-700 hover:underline">{docTitle.get(x.ged_document_id)}</Link> : <span className="text-ink-faint">document non accessible</span>}</dd></>}
                  {x.notes && <><dt className="text-ink-soft">Notes</dt><dd className="whitespace-pre-wrap">{x.notes}</dd></>}
                </dl>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog open={dlg !== null} onClose={() => setDlg(null)} title={c ? `Modifier ${c.standard_code}` : 'Ajouter une certification'}>
        {dlg && (
          <form key={c?.id ?? 'new'} action={action} className="space-y-4" noValidate>
            <input type="hidden" name="product_id" value={productId} />
            {c && <input type="hidden" name="id" value={c.id} />}
            {state && !state.ok && state.message && <Alert tone="error">{state.message}</Alert>}
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField id="ce-std" label="Norme / référentiel *" errors={errs.standard_code}>
                <Input id="ce-std" name="standard_code" list="norm-list" maxLength={60} defaultValue={v('standard_code', c?.standard_code)} placeholder="EN ISO 20471" />
                <datalist id="norm-list">{NORM_SUGGESTIONS.map((n) => <option key={n.code} value={n.code}>{n.label}</option>)}</datalist>
              </FormField>
              <FormField id="ce-type" label="Type" errors={errs.cert_type}>
                <Select id="ce-type" name="cert_type" defaultValue={v('cert_type', c?.cert_type ?? 'product')}>{CERT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>
              </FormField>
              <div className="sm:col-span-2"><FormField id="ce-label" label="Intitulé" errors={errs.label}><Input id="ce-label" name="label" maxLength={160} defaultValue={v('label', c?.label)} placeholder="Vêtements de signalisation à haute visibilité" /></FormField></div>
              <FormField id="ce-class" label="Classe / niveau" errors={errs.class_level}><Input id="ce-class" name="class_level" maxLength={30} defaultValue={v('class_level', c?.class_level)} placeholder="2" /></FormField>
              <FormField id="ce-no" label="N° de certificat" errors={errs.certificate_no}><Input id="ce-no" name="certificate_no" maxLength={80} defaultValue={v('certificate_no', c?.certificate_no)} /></FormField>
              <FormField id="ce-issuer" label="Organisme" errors={errs.issuer}><Input id="ce-issuer" name="issuer" maxLength={120} defaultValue={v('issuer', c?.issuer)} placeholder="CTTN, SGS, Intertek…" /></FormField>
              <FormField id="ce-status" label="Statut" errors={errs.status}>
                <Select id="ce-status" name="status" defaultValue={v('status', c?.status ?? 'valid')}>{CERT_STATUS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>
              </FormField>
              <FormField id="ce-from" label="Date d’émission" errors={errs.issued_on}><Input id="ce-from" name="issued_on" type="date" defaultValue={v('issued_on', c?.issued_on)} /></FormField>
              <FormField id="ce-to" label="Valide jusqu’au" errors={errs.valid_until}><Input id="ce-to" name="valid_until" type="date" defaultValue={v('valid_until', c?.valid_until)} /></FormField>
              <div className="sm:col-span-2">
                <FormField id="ce-doc" label="Justificatif (document de la GED)" errors={errs.ged_document_id}>
                  <Select id="ce-doc" name="ged_document_id" defaultValue={v('ged_document_id', c?.ged_document_id)}><option value="">— Aucun —</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</Select>
                </FormField>
              </div>
              <div className="sm:col-span-2"><FormField id="ce-notes" label="Notes" errors={errs.notes}><Textarea id="ce-notes" name="notes" rows={2} maxLength={500} defaultValue={v('notes', c?.notes)} /></FormField></div>
            </div>
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setDlg(null)}>Annuler</Button><SubmitButton pendingText="Enregistrement…">{c ? 'Enregistrer' : 'Ajouter'}</SubmitButton></div>
          </form>
        )}
      </Dialog>
    </div>
  )
}

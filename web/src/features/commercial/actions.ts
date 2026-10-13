'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { commercialErrorMessage, isPermissionError } from './errors'

/** Écritures via la session de l'utilisateur : RLS et RPC (prospect_*, quote_*, invoice_*, credit_note_*) font autorité. */

const uuid = z.uuid()
const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null)
const optUuid = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.uuid('Valeur invalide')])).optional().transform((v) => v ?? null)
const optDate = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide')])).optional().transform((v) => v ?? null)
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date requise')
const dec = (label: string, o: { zero?: boolean; max?: number } = {}) =>
  z.string().trim().min(1, `${label} requis`).transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
    .refine((n) => Number.isFinite(n), `${label} invalide`)
    .refine((n) => (o.zero ? n >= 0 : n > 0), o.zero ? `${label} : minimum 0` : `${label} : supérieur à 0`)
    .refine((n) => n <= (o.max ?? 1_000_000_000), `${label} trop grand`)
const optDec = (label: string, o: { max?: number } = {}) =>
  z.string().trim().optional().transform((v) => (v === undefined || v === '' ? '0' : v)).pipe(dec(label, { zero: true, ...o }))
const pct = (label: string) => optDec(label, { max: 100 })

async function authorize(...anyOf: string[]): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!anyOf.some((p) => ctx.permissions.includes(p))) {
    await logAccessDenied(ctx, anyOf.join('|'), { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}
async function dbFail(ctx: AuthContextValue, permission: string, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, permission, { via: 'database' })
  return { ok: false, message: commercialErrorMessage(err), values }
}
const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}
const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => {
  const fe = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>
  return { ok: false, message: Object.values(fe).flat().find(Boolean) ?? 'Veuillez corriger les champs en erreur.', fieldErrors: fe, values }
}
const rev = () => { revalidatePath('/commercial', 'layout'); revalidatePath('/orders', 'layout') }
const idOf = (fd: FormData) => uuid.safeParse(fd.get('id'))

async function rpcAction(perm: string, fn: string, args: Record<string, unknown>, ok: string): Promise<FormState> {
  const auth = await authorize(perm)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc(fn, args)
  if (error) return dbFail(auth.ctx, perm, error)
  rev()
  return { ok: true, message: ok }
}
async function rpcRedirect(perm: string, fn: string, args: Record<string, unknown>, to: (data: string) => string): Promise<FormState> {
  const auth = await authorize(perm)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { data, error } = await supabase.rpc(fn, args)
  if (error) return dbFail(auth.ctx, perm, error)
  rev()
  redirect(to(String(data)))
}

// ---------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------
const prospectSchema = z.object({
  company_name: z.string().trim().min(2, 'Société requise (2 caractères minimum)').max(120),
  contact_name: opt(120), email: z.string().trim().max(160).transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.email('E-mail invalide')])).optional().transform((v) => v ?? null),
  phone: opt(40), country: z.string().trim().toUpperCase().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.string().regex(/^[A-Z]{2}$/, 'Code pays sur 2 lettres (ex. FR)')])).optional().transform((v) => v ?? null),
  city: opt(80), source: z.enum(['website', 'trade_show', 'referral', 'cold_call', 'social', 'other']),
  est_value: optDec('Valeur estimée'), expected_close: optDate, owner_id: optUuid, next_action: opt(200), next_action_date: optDate, notes: opt(2000),
})

export async function saveProspectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PROSPECTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = prospectSchema.extend({ id: optUuid }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const { id, ...fields } = parsed.data
  const supabase = await createClient()
  if (id) {
    const { data, error } = await supabase.from('prospects').update(fields).eq('id', id).select('id')
    if (error) return dbFail(auth.ctx, P.PROSPECTS_WRITE, error, values)
    if (!data?.length) return { ok: false, message: 'Prospect introuvable ou modification non autorisée.', values }
    rev()
    redirect(`/commercial/prospects/${id}?updated=1`)
  }
  const { data, error } = await supabase.from('prospects').insert(fields).select('id').single()
  if (error) return dbFail(auth.ctx, P.PROSPECTS_WRITE, error, values)
  rev()
  redirect(`/commercial/prospects/${data.id}?created=1`)
}

export async function setStageAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  const stage = z.enum(['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'lost']).safeParse(fd.get('stage'))
  if (!id.success || !stage.success) return { ok: false, message: 'Données invalides.' }
  return rpcAction(P.PROSPECTS_WRITE, 'prospect_set_stage', { p_prospect: id.data, p_stage: stage.data, p_reason: String(fd.get('reason') ?? '').trim().slice(0, 300) || null }, 'Étape mise à jour.')
}
export async function convertProspectAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(P.PROSPECTS_WRITE)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('prospect_convert', { p_prospect: id.data })
  if (error) return dbFail(auth.ctx, P.PROSPECTS_WRITE, error)
  rev()
  redirect(`/clients/${data}`)
}
export async function addActivityAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PROSPECTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ prospect_id: z.uuid(), kind: z.enum(['call', 'email', 'meeting', 'note']), summary: z.string().trim().min(2, 'Résumé requis').max(500) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('prospect_activities').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.PROSPECTS_WRITE, error, values)
  rev()
  return { ok: true, message: 'Activité ajoutée.' }
}

// ---------------------------------------------------------------------
// Devis
// ---------------------------------------------------------------------
export async function createQuoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.QUOTES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ party: z.string().regex(/^[cp]:[0-9a-f-]{36}$/i, 'Choisissez un client ou un prospect'), valid_until: optDate, tax_rate: optDec('TVA', { max: 100 }), payment_terms: opt(120), lead_days: z.string().trim().transform((v) => (v === '' ? 30 : Number(v))).refine((n) => Number.isInteger(n) && n >= 0 && n <= 365, 'Délai : entier entre 0 et 365'), notes: opt(2000) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const { party, ...rest } = parsed.data
  const id = party.slice(2)
  const supabase = await createClient()
  const row: Record<string, unknown> = { ...rest, client_id: party.startsWith('c') ? id : null, prospect_id: party.startsWith('p') ? id : null }
  if (!rest.valid_until) delete row.valid_until
  const { data, error } = await supabase.from('quotes').insert(row).select('id').single()
  if (error) return dbFail(auth.ctx, P.QUOTES_WRITE, error, values)
  rev()
  redirect(`/commercial/quotes/${data.id}`)
}
export async function updateQuoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.QUOTES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ id: z.uuid(), valid_until: date, tax_rate: optDec('TVA', { max: 100 }), payment_terms: opt(120), lead_days: z.string().trim().transform((v) => Number(v)).refine((n) => Number.isInteger(n) && n >= 0 && n <= 365, 'Délai : entier entre 0 et 365'), notes: opt(2000) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const { id, ...fields } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.from('quotes').update(fields).eq('id', id).select('id')
  if (error) return dbFail(auth.ctx, P.QUOTES_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Devis introuvable ou modification non autorisée.', values }
  rev()
  return { ok: true, message: 'Devis enregistré.' }
}
export async function addQuoteLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.QUOTES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ quote_id: z.uuid(), article_id: optUuid, description: opt(300), qty: dec('Quantité'), unit_price: optDec('Prix unitaire'), discount_pct: pct('Remise') }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  if (!parsed.data.article_id && !parsed.data.description) return { ok: false, message: 'Choisissez un article ou saisissez une désignation.', fieldErrors: { description: ['Désignation requise'] }, values }
  const supabase = await createClient()
  const { error } = await supabase.from('quote_lines').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.QUOTES_WRITE, error, values)
  rev()
  return { ok: true, message: 'Ligne ajoutée.' }
}
const lineEdit = z.object({ id: z.uuid(), description: z.string().trim().min(1, 'Désignation requise').max(300), qty: dec('Quantité'), unit_price: optDec('Prix unitaire'), discount_pct: pct('Remise') })
export async function updateQuoteLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.QUOTES_WRITE)
  if ('error' in auth) return auth.error
  const parsed = lineEdit.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const { id, ...f } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.from('quote_lines').update(f).eq('id', id).select('id')
  if (error) return dbFail(auth.ctx, P.QUOTES_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Ligne introuvable ou modification non autorisée.' }
  rev()
  return { ok: true, message: 'Enregistré.' }
}
export async function deleteQuoteLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.QUOTES_WRITE)
  if ('error' in auth) return auth.error
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.from('quote_lines').delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.QUOTES_WRITE, error)
  rev()
  return { ok: true, message: 'Ligne supprimée.' }
}
export async function sendQuoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcAction(P.QUOTES_WRITE, 'quote_send', { p_quote: id.data }, 'Devis envoyé au client.')
}
export async function decideQuoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const accept = fd.get('decision') === 'accept'
  return rpcAction(P.QUOTES_WRITE, 'quote_decide', { p_quote: id.data, p_accept: accept, p_reason: String(fd.get('reason') ?? '').trim().slice(0, 300) || null }, accept ? 'Devis accepté.' : 'Refus enregistré.')
}
export async function cancelQuoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcAction(P.QUOTES_WRITE, 'quote_cancel', { p_quote: id.data }, 'Devis annulé.')
}
export async function duplicateQuoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcRedirect(P.QUOTES_WRITE, 'quote_duplicate', { p_quote: id.data }, (q) => `/commercial/quotes/${q}`)
}
export async function quoteToOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcRedirect(P.QUOTES_WRITE, 'quote_to_order', { p_quote: id.data }, (o) => `/orders/${o}`)
}

/** Demande d'accord pour les remises hors seuil : la base crée la demande d'approbation (SOD : le demandeur ne décide pas). */
export async function quoteRequestApprovalAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcAction(P.QUOTES_WRITE, 'quote_request_approval', { p_quote: id.data }, 'Demande d’accord envoyée au responsable.')
}
/** Nouvelle version d'un devis envoyé, accepté ou refusé : l'ancienne version passe en « remplacé ». */
export async function quoteReviseAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcRedirect(P.QUOTES_WRITE, 'quote_revise', { p_quote: id.data }, (q) => `/commercial/quotes/${q}`)
}
/** Conversion en commande : clé dérivée du devis, donc un double envoi renvoie la même commande. */
export async function quoteConvertAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcRedirect(P.ORDERS_WRITE, 'quote_convert', { p_quote: id.data, p_key: `quote-convert:${id.data}` }, (o) => `/orders/${o}`)
}

// ---------------------------------------------------------------------
// Factures et avoirs
// ---------------------------------------------------------------------
export async function invoiceFromOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = z.uuid().safeParse(fd.get('order_id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcRedirect(P.INVOICES_WRITE, 'invoice_from_order', { p_order: id.data }, (i) => `/commercial/invoices/${i}`)
}
export async function createManualInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ client_id: z.uuid('Choisissez un client'), tax_rate: optDec('TVA', { max: 100 }), payment_terms: opt(120), notes: opt(2000) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.from('invoices').insert(parsed.data).select('id').single()
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error, values)
  rev()
  redirect(`/commercial/invoices/${data.id}`)
}
export async function updateInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ id: z.uuid(), tax_rate: optDec('TVA', { max: 100 }), payment_terms: opt(120), notes: opt(2000) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const { id, ...fields } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.from('invoices').update(fields).eq('id', id).select('id')
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error, values)
  if (!data?.length) return { ok: false, message: 'Facture introuvable ou modification non autorisée.', values }
  rev()
  return { ok: true, message: 'Facture enregistrée.' }
}
export async function addInvoiceLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ invoice_id: z.uuid(), description: z.string().trim().min(1, 'Désignation requise').max(300), qty: dec('Quantité'), unit_price: optDec('Prix unitaire'), discount_pct: pct('Remise') }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.from('invoice_lines').insert(parsed.data)
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error, values)
  rev()
  return { ok: true, message: 'Ligne ajoutée.' }
}
export async function updateInvoiceLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const parsed = lineEdit.safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const { id, ...f } = parsed.data
  const supabase = await createClient()
  const { data, error } = await supabase.from('invoice_lines').update(f).eq('id', id).select('id')
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Ligne introuvable ou modification non autorisée.' }
  rev()
  return { ok: true, message: 'Enregistré.' }
}
export async function deleteInvoiceLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.from('invoice_lines').delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error)
  rev()
  return { ok: true, message: 'Ligne supprimée.' }
}
export async function issueInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('invoice_issue', { p_invoice: id.data })
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error)
  rev()
  return { ok: true, message: `Facture émise : ${data}.` }
}
export async function cancelInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc('invoice_cancel', { p_invoice: id.data })
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error)
  rev()
  redirect('/commercial/invoices')
}
export async function recordPaymentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.PAYMENTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ invoice_id: z.uuid(), amount: dec('Montant'), paid_on: optDate, method: z.enum(['transfer', 'cheque', 'lc', 'cash', 'card', 'other']), reference: opt(120) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.rpc('invoice_record_payment', { p_invoice: parsed.data.invoice_id, p_amount: parsed.data.amount, p_paid_on: parsed.data.paid_on, p_method: parsed.data.method, p_reference: parsed.data.reference })
  if (error) return dbFail(auth.ctx, P.PAYMENTS_WRITE, error, values)
  rev()
  return { ok: true, message: 'Encaissement enregistré.' }
}
// Acomptes et facturation par BL (P031, migration 0056). La clé d'idempotence est fournie par le formulaire ;
// la reprise avec la même clé renvoie le même document, et les bornes SQL empêchent toute double facturation.
const idemKey = z.string().trim().min(8, 'Clé d’idempotence requise (8 caractères minimum)').max(120)
export async function createDepositInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ order_id: z.uuid(), amount: dec('Montant HT de l’acompte'), idem_key: idemKey }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('invoice_deposit_create', { p_order: parsed.data.order_id, p_amount: parsed.data.amount, p_key: parsed.data.idem_key })
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error, values)
  rev()
  redirect(`/commercial/invoices/${String(data)}`)
}
export async function applyDepositAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const pay = await authorize(P.PAYMENTS_WRITE)
  if ('error' in pay) return pay.error
  const values = raw(fd)
  const parsed = z.object({ invoice_id: z.uuid(), deposit_id: z.uuid(), amount: dec('Montant imputé') }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { error } = await supabase.rpc('invoice_deposit_apply', { p_invoice: parsed.data.invoice_id, p_deposit: parsed.data.deposit_id, p_amount: parsed.data.amount })
  if (error) return dbFail(auth.ctx, P.PAYMENTS_WRITE, error, values)
  rev()
  return { ok: true, message: 'Acompte imputé sur la facture.' }
}
export async function invoiceFromShipmentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ shipment_id: z.uuid(), idem_key: idemKey }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('invoice_from_shipment', { p_shipment: parsed.data.shipment_id, p_key: parsed.data.idem_key })
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error, values)
  rev()
  redirect(`/commercial/invoices/${String(data)}`)
}

export async function createCreditNoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = z.object({ invoice_id: z.uuid(), reason: z.string().trim().min(3, 'Motif requis (3 caractères minimum)').max(300) }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, values)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('credit_note_create', { p_invoice: parsed.data.invoice_id, p_reason: parsed.data.reason })
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error, values)
  rev()
  redirect(`/commercial/credit-notes/${data}`)
}
export async function updateCreditLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const parsed = z.object({ id: z.uuid(), qty: dec('Quantité') }).safeParse(obj(fd))
  if (!parsed.success) return invalid(parsed.error, raw(fd))
  const supabase = await createClient()
  const { data, error } = await supabase.from('credit_note_lines').update({ qty: parsed.data.qty }).eq('id', parsed.data.id).select('id')
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error)
  if (!data?.length) return { ok: false, message: 'Ligne introuvable ou modification non autorisée.' }
  rev()
  return { ok: true, message: 'Enregistré.' }
}
export async function deleteCreditLineAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.from('credit_note_lines').delete().eq('id', id.data)
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error)
  rev()
  return { ok: true, message: 'Ligne supprimée.' }
}
export async function issueCreditNoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('credit_note_issue', { p_credit_note: id.data, p_reopen: fd.get('reopen') === 'on' })
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error)
  rev()
  return { ok: true, message: `Avoir émis : ${data}.` }
}
export async function cancelCreditNoteAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const auth = await authorize(P.INVOICES_WRITE)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { error } = await supabase.rpc('credit_note_cancel', { p_credit_note: id.data })
  if (error) return dbFail(auth.ctx, P.INVOICES_WRITE, error)
  rev()
  redirect('/commercial/credit-notes')
}

// ---------------------------------------------------------------------
// Leads : affectation, qualification, consentements, tâches, conversion (migration 0046)
// ---------------------------------------------------------------------
const bool = (fd: FormData, k: string) => fd.get(k) === 'on'
const shortText = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v))

export async function assignLeadAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  const owner = uuid.safeParse(String(fd.get('owner') ?? ''))
  if (!id.success || !owner.success) return { ok: false, message: 'Données invalides.' }
  return rpcAction(P.PROSPECTS_WRITE, 'prospect_assign', { p_prospect: id.data, p_owner: owner.data }, 'Responsable mis à jour.')
}

export async function qualifyLeadAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  return rpcAction(P.PROSPECTS_WRITE, 'prospect_qualify', {
    p_prospect: id.data, p_budget: bool(fd, 'budget'), p_need: bool(fd, 'need'), p_decision_maker: bool(fd, 'decision_maker'),
    p_timeline: String(fd.get('timeline') ?? '').trim().slice(0, 120) || null,
  }, 'Qualification enregistrée.')
}

export async function recordConsentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  const purpose = z.enum(['commercial_prospection', 'phone_contact', 'email_marketing']).safeParse(fd.get('purpose'))
  const status = z.enum(['granted', 'withdrawn']).safeParse(fd.get('status'))
  const proof = shortText(300).safeParse(fd.get('proof'))
  if (!id.success || !purpose.success || !status.success || !proof.success) return { ok: false, message: 'Données invalides.' }
  return rpcAction(P.PROSPECTS_WRITE, 'prospect_consent_record', { p_prospect: id.data, p_purpose: purpose.data, p_status: status.data, p_proof: proof.data ?? '' }, 'Consentement enregistré.')
}

export async function createLeadTaskAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  const title = shortText(200).safeParse(fd.get('title'))
  const due = date.safeParse(String(fd.get('due') ?? ''))
  const owner = optUuid.safeParse(String(fd.get('owner') ?? ''))
  if (!id.success || !title.success || !due.success || !owner.success) return { ok: false, message: 'Données invalides.' }
  return rpcAction(P.PROSPECTS_WRITE, 'prospect_task_create', { p_prospect: id.data, p_title: title.data ?? '', p_due: due.data, p_owner: owner.data }, 'Tâche créée.')
}

export async function completeLeadTaskAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const t = uuid.safeParse(String(fd.get('task') ?? ''))
  if (!t.success) return { ok: false, message: 'Tâche invalide.' }
  return rpcAction(P.PROSPECTS_WRITE, 'prospect_task_complete', { p_task: t.data }, 'Tâche terminée.')
}

/** Conversion : sans client choisi, la base refuse s'il existe un client au même e-mail ou nom (LEAD_DUPLICATE_CANDIDATE). */
export async function convertLeadAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idOf(fd)
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const client = optUuid.safeParse(String(fd.get('client') ?? ''))
  if (!client.success) return { ok: false, message: 'Client invalide.' }
  const auth = await authorize(P.PROSPECTS_WRITE)
  if ('error' in auth) return auth.error
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('lead_convert', { p_prospect: id.data, p_client: client.data })
  if (error) return dbFail(auth.ctx, P.PROSPECTS_WRITE, error)
  rev()
  redirect(`/clients/${(data as { client_id: string }).client_id}`)
}

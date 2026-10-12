'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { isPermissionError } from '@/features/stock/errors'

/** Finance : affectations, relances, trésorerie et prévisions sont calculées par les fonctions SQL (0022). */

const uuid = (label: string) => z.uuid(`${label} invalide`)
const date = (label: string) => z.string().trim().min(1, `${label} requis`).regex(/^\d{4}-\d{2}-\d{2}$/, `${label} invalide`)
const amount = (label: string) => z.string().trim().min(1, `${label} requis`)
  .transform((v) => Number(v.replace(/\s/g, '').replace(',', '.')))
  .refine((n) => Number.isFinite(n) && n > 0, `${label} : supérieur à 0`)
  .refine((n) => n <= 100_000_000, `${label} trop grand`)
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : null))
const METHODS = ['transfer', 'cheque', 'lc', 'cash', 'card', 'other'] as const

const obj = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([k, v]) => typeof v === 'string' && !k.startsWith('$ACTION')))
const raw = (fd: FormData): Record<string, string> => Object.fromEntries(Object.entries(obj(fd)).map(([k, v]) => [k, String(v)]))
const invalid = (error: z.ZodError, values: Record<string, string>): FormState => {
  const fe = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>
  return { ok: false, message: Object.values(fe).flat().find(Boolean) ?? 'Veuillez corriger les champs en erreur.', fieldErrors: fe, values }
}
async function requireCtx(): Promise<AuthContextValue> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  return ctx
}
const MESSAGES: [string, string][] = [
  ['FINANCE_OVERPAYMENT', 'Le montant dépasse le solde ouvert : aucun règlement d’avance n’est enregistré.'],
  ['FINANCE_REASON_REQUIRED', 'Motif trop court (5 caractères minimum).'],
  ['FINANCE_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel.'],
  ['FINANCE_BEFORE_OPENING', 'La date est antérieure à l’ouverture du compte.'],
  ['FINANCE_ACCOUNT_INACTIVE', 'Ce compte de trésorerie est inactif.'],
  ['FINANCE_SUPPLIER_NOT_FOUND', 'Fournisseur introuvable.'],
  ['FINANCE_NOT_FOUND', 'Élément introuvable.'],
  ['FINANCE_BAD_AMOUNT', 'Montant invalide.'],
  ['supplier_invoices_company_id_supplier_id_supplier_ref_key', 'Cette référence de facture existe déjà pour ce fournisseur.'],
  ['check constraint', 'Une valeur ne respecte pas les règles de saisie (dates ou montants).'],
  ['RBAC_FORBIDDEN', 'Vous n’avez pas la permission d’effectuer cette action.'],
]
const messageOf = (err: { message?: string; code?: string; details?: string | null }) => {
  const text = `${err.message ?? ''} ${err.details ?? ''}`
  for (const [k, m] of MESSAGES) if (text.includes(k)) return m
  if (err.code === '42501' || text.includes('row-level security')) return 'Vous n’avez pas la permission d’effectuer cette action.'
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}
async function dbFail(ctx: AuthContextValue, err: { message?: string; code?: string; details?: string | null }, values?: Record<string, string>): Promise<FormState> {
  if (isPermissionError(err)) await logAccessDenied(ctx, P.FINANCE_WRITE, { via: 'database' })
  return { ok: false, message: messageOf(err), values }
}
const rev = () => revalidatePath('/finance', 'layout')

async function run(fn: string, args: Record<string, unknown>, values: Record<string, string>, success: string | ((data: unknown) => string)): Promise<FormState> {
  const ctx = await requireCtx()
  const supabase = await createClient()
  const { data, error } = await supabase.rpc(fn, args)
  if (error) return dbFail(ctx, error, values)
  rev()
  return { ok: true, message: typeof success === 'function' ? success(data) : success }
}

const methodField = z.enum(METHODS, { message: 'Mode de règlement inconnu' })

export async function recordReceiptAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ client_id: uuid('Client'), amount: amount('Montant'), paid_on: date('Date'), method: methodField, reference: optText(120) })
    .safeParse({ client_id: fd.get('client_id'), amount: fd.get('amount'), paid_on: fd.get('paid_on'), method: fd.get('method'), reference: fd.get('reference') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('customer_receipt_record', { p_client: d.client_id, p_amount: d.amount, p_paid_on: d.paid_on, p_method: d.method, p_reference: d.reference },
    values, (r) => {
      const x = r as { allocated_invoices: number }
      return `Encaissement affecté à ${x.allocated_invoices} facture(s).`
    })
}

export async function recordSupplierPaymentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ supplier_id: uuid('Fournisseur'), amount: amount('Montant'), paid_on: date('Date'), method: methodField, reference: optText(120) })
    .safeParse({ supplier_id: fd.get('supplier_id'), amount: fd.get('amount'), paid_on: fd.get('paid_on'), method: fd.get('method'), reference: fd.get('reference') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('supplier_payment_record', { p_supplier: d.supplier_id, p_amount: d.amount, p_paid_on: d.paid_on, p_method: d.method, p_reference: d.reference },
    values, (r) => `Règlement ${(r as { number: string }).number} enregistré.`)
}

export async function createSupplierInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    supplier_id: uuid('Fournisseur'), supplier_ref: z.string().trim().min(1, 'Référence fournisseur requise').max(60),
    invoice_date: date('Date de facture'), due_date: date('Échéance'), total: amount('Montant TTC'),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Devise : code ISO à 3 lettres'),
  }).safeParse({ supplier_id: fd.get('supplier_id'), supplier_ref: fd.get('supplier_ref'), invoice_date: fd.get('invoice_date'), due_date: fd.get('due_date'),
    total: fd.get('total'), currency: fd.get('currency') || 'EUR' })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('supplier_invoice_record', { p_supplier: d.supplier_id, p_ref: d.supplier_ref, p_invoice_date: d.invoice_date, p_due_date: d.due_date,
    p_total: d.total, p_currency: d.currency, p_purchase_order: null }, values, 'Facture fournisseur enregistrée.')
}

export async function disputeInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({ invoice_id: uuid('Facture'), reason: z.string().trim().min(5, 'Motif : 5 caractères minimum').max(300) })
    .safeParse({ invoice_id: fd.get('invoice_id'), reason: fd.get('reason') })
  if (!parsed.success) return invalid(parsed.error, values)
  return run('supplier_invoice_dispute', { p_invoice: parsed.data.invoice_id, p_reason: parsed.data.reason }, values, 'Facture mise en litige.')
}

export async function resolveInvoiceAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = z.object({ invoice_id: uuid('Facture') }).safeParse({ invoice_id: fd.get('invoice_id') })
  if (!parsed.success) return { ok: false, message: 'Facture invalide.' }
  return run('supplier_invoice_resolve', { p_invoice: parsed.data.invoice_id }, {}, 'Litige résolu.')
}

export async function generateRemindersAction(_prev: FormState): Promise<FormState> {
  return run('finance_generate_reminders', {}, {}, (n) => `${String(n)} relance(s) créée(s).`)
}

export async function markReminderSentAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = z.object({ reminder_id: uuid('Relance') }).safeParse({ reminder_id: fd.get('reminder_id') })
  if (!parsed.success) return { ok: false, message: 'Relance invalide.' }
  return run('finance_reminder_mark_sent', { p_reminder: parsed.data.reminder_id }, {}, 'Relance marquée comme envoyée.')
}

export async function createCashAccountAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    name: z.string().trim().min(2, 'Nom : 2 caractères minimum').max(80),
    opening: z.string().trim().optional().transform((v) => (v ? Number(v.replace(/\s/g, '').replace(',', '.')) : 0))
      .refine((n) => Number.isFinite(n), 'Solde d’ouverture invalide'),
    opening_date: date('Date d’ouverture'),
  }).safeParse({ name: fd.get('name'), opening: fd.get('opening'), opening_date: fd.get('opening_date') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('cash_account_create', { p_name: d.name, p_opening: d.opening, p_opening_date: d.opening_date }, values, 'Compte de trésorerie créé.')
}

export async function cashMovementAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const values = raw(fd)
  const parsed = z.object({
    account_id: uuid('Compte'), direction: z.enum(['in', 'out'], { message: 'Sens inconnu' }), amount: amount('Montant'),
    moved_on: date('Date'), label: z.string().trim().min(2, 'Libellé : 2 caractères minimum').max(160),
  }).safeParse({ account_id: fd.get('account_id'), direction: fd.get('direction'), amount: fd.get('amount'), moved_on: fd.get('moved_on'), label: fd.get('label') })
  if (!parsed.success) return invalid(parsed.error, values)
  const d = parsed.data
  return run('cash_movement_add', { p_account: d.account_id, p_direction: d.direction, p_amount: d.amount, p_moved_on: d.moved_on, p_label: d.label }, values, 'Mouvement enregistré.')
}

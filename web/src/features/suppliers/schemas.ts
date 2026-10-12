import { z } from 'zod'
import { COUNTRY_CODES, CURRENCIES, INCOTERMS, LANGUAGES, PAYMENT_METHODS } from '@/lib/clients/options'
import { QUALIFICATIONS, SUPPLIER_CATEGORIES, SUPPLIER_DOC_TYPES } from '@/lib/suppliers/options'

const optText = (max: number) =>
  z.string().trim().max(max, `${max} caractères maximum`).transform((v) => (v === '' ? null : v)).nullable().optional().transform((v) => v ?? null)

const optEmail = z.string().trim().max(160).transform((v) => (v === '' ? null : v))
  .pipe(z.email({ error: 'Adresse e-mail invalide' }).nullable()).nullable().optional().transform((v) => v ?? null)

const optUrl = z.string().trim().max(200).transform((v) => (v === '' ? null : v))
  .refine((v) => v === null || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v), 'Adresse de site invalide').nullable().optional().transform((v) => v ?? null)

const uuidOrNull = z.string().trim().transform((v) => (v === '' ? null : v))
  .pipe(z.uuid({ error: 'Valeur invalide' }).nullable()).nullable().optional().transform((v) => v ?? null)

const oneOf = (list: readonly string[], msg: string) => z.enum(list as unknown as [string, ...string[]], { error: msg })
const optOneOf = (list: readonly string[]) =>
  z.string().trim().transform((v) => (v === '' ? null : v)).pipe(oneOf(list, 'Valeur invalide').nullable()).nullable().optional().transform((v) => v ?? null)

const optNumber = (min: number, max: number, msg: string, integer = false) =>
  z.string().trim().transform((v) => (v === '' ? null : Number(v.replace(',', '.').replace(/\s/g, ''))))
    .refine((v) => v === null || (Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v))), msg)
    .nullable().optional().transform((v) => v ?? null)

const langs = LANGUAGES.map((l) => l.value) as readonly string[]

export const supplierSchema = z.object({
  code: z.string().trim().transform((v) => v.toUpperCase())
    .refine((v) => v === '' || /^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(v), 'Lettres, chiffres, - et _ (2 à 20 caractères)')
    .transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null),
  name: z.string().trim().min(2, 'Raison sociale requise (2 caractères minimum)').max(120, '120 caractères maximum'),
  legal_name: optText(160),
  category: oneOf(SUPPLIER_CATEGORIES.map((c) => c.value), 'Catégorie requise'),
  qualification: oneOf(QUALIFICATIONS.map((q) => q.value), 'Qualification invalide'),
  rating: optNumber(1, 5, 'Note de 1 à 5', true),
  tax_id: optText(40),
  registration_no: optText(40),
  website: optUrl,
  email: optEmail,
  phone: optText(40),
  address_line1: optText(160),
  address_line2: optText(160),
  postal_code: optText(20),
  city: optText(80),
  region: optText(80),
  country: oneOf(COUNTRY_CODES, 'Pays requis'),
  currency: oneOf(CURRENCIES, 'Devise requise'),
  language: oneOf(langs, 'Langue invalide'),
  payment_terms_id: uuidOrNull,
  payment_method: optOneOf(PAYMENT_METHODS.map((m) => m.value)),
  lead_time_days: optNumber(0, 365, 'Entre 0 et 365 jours', true),
  min_order_amount: optNumber(0, 1_000_000_000, 'Montant invalide'),
  incoterm: optOneOf(INCOTERMS),
  incoterm_place: optText(80),
  buyer_id: uuidOrNull,
  notes: optText(2000),
})

export const supplierContactSchema = z.object({
  full_name: z.string().trim().min(2, 'Nom requis').max(100),
  job_title: optText(100),
  email: optEmail,
  phone: optText(40),
  mobile: optText(40),
  language: optOneOf(langs),
  is_primary: z.boolean(),
  notes: optText(1000),
})

export const supplierDocumentSchema = z.object({
  title: z.string().trim().min(2, 'Titre requis').max(120),
  doc_type: oneOf(SUPPLIER_DOC_TYPES.map((t) => t.value), 'Type requis'),
  valid_until: z.string().trim().transform((v) => (v === '' ? null : v))
    .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Date invalide').nullable().optional().transform((v) => v ?? null),
  notes: optText(500),
})

export function formToObject(fd: FormData, booleans: string[] = []) {
  const out: Record<string, string | boolean> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  for (const b of booleans) out[b] = fd.get(b) === 'on' || fd.get(b) === 'true'
  return out
}

export const ALLOWED_MIME = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const
export const MAX_FILE_BYTES = 10 * 1024 * 1024

import { z } from 'zod'
import { COUNTRY_CODES, CURRENCIES, INCOTERMS, LANGUAGES, PAYMENT_METHODS, ADDRESS_TYPES } from '@/lib/clients/options'

/** Champ texte facultatif : '' -> null. */
const optText = (max: number, msg = `${max} caractères maximum`) =>
  z
    .string()
    .trim()
    .max(max, msg)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()
    .transform((v) => v ?? null)

const optEmail = z
  .string()
  .trim()
  .max(160)
  .transform((v) => (v === '' ? null : v))
  .pipe(z.email({ error: 'Adresse e-mail invalide' }).nullable())
  .nullable()
  .optional()
  .transform((v) => v ?? null)

const optUrl = z
  .string()
  .trim()
  .max(200)
  .transform((v) => (v === '' ? null : v))
  .refine((v) => v === null || /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(v), 'Adresse de site invalide')
  .nullable()
  .optional()
  .transform((v) => v ?? null)

const uuidOrNull = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .pipe(z.uuid({ error: 'Valeur invalide' }).nullable())
  .nullable()
  .optional()
  .transform((v) => v ?? null)

const oneOf = <T extends readonly string[]>(list: T, msg: string) => z.enum(list as unknown as [string, ...string[]], { error: msg })
const optOneOf = <T extends readonly string[]>(list: T) =>
  z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : v))
    .pipe(oneOf(list, 'Valeur invalide').nullable())
    .nullable()
    .optional()
    .transform((v) => v ?? null)

const optNumber = (min: number, max: number, msg: string) =>
  z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : Number(v.replace(',', '.').replace(/\s/g, ''))))
    .refine((v) => v === null || (Number.isFinite(v) && v >= min && v <= max), msg)
    .nullable()
    .optional()
    .transform((v) => v ?? null)

export const clientSchema = z.object({
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => v === '' || /^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(v), 'Lettres, chiffres, - et _ (2 à 20 caractères)')
    .transform((v) => (v === '' ? null : v))
    .optional()
    .transform((v) => v ?? null),
  name: z.string().trim().min(2, 'Raison sociale requise (2 caractères minimum)').max(120, '120 caractères maximum'),
  legal_name: optText(160),
  tax_id: optText(40),
  registration_no: optText(40),
  website: optUrl,
  email: optEmail,
  phone: optText(40),
  country: oneOf(COUNTRY_CODES, 'Pays requis'),
  currency: oneOf(CURRENCIES, 'Devise requise'),
  language: oneOf(LANGUAGES.map((l) => l.value) as unknown as readonly string[], 'Langue invalide'),
  payment_terms_id: uuidOrNull,
  payment_method: optOneOf(PAYMENT_METHODS.map((m) => m.value)),
  credit_limit: optNumber(0, 1_000_000_000, 'Montant invalide'),
  incoterm: optOneOf(INCOTERMS),
  vat_exempt: z.boolean(),
  delivery_tolerance_pct: z
    .string()
    .trim()
    .transform((v) => (v === '' ? 5 : Number(v.replace(',', '.'))))
    .refine((v) => Number.isFinite(v) && v >= 0 && v <= 50, 'Entre 0 et 50 %'),
  aql_level: optText(20),
  sales_rep_id: uuidOrNull,
  notes: optText(2000, '2 000 caractères maximum'),
})
export type ClientInput = z.infer<typeof clientSchema>

export const contactSchema = z.object({
  full_name: z.string().trim().min(2, 'Nom requis').max(100),
  job_title: optText(100),
  email: optEmail,
  phone: optText(40),
  mobile: optText(40),
  language: optOneOf(LANGUAGES.map((l) => l.value)),
  is_primary: z.boolean(),
  notes: optText(1000),
})

export const addressSchema = z.object({
  type: oneOf(ADDRESS_TYPES.map((t) => t.value) as unknown as readonly string[], 'Type requis'),
  label: optText(60),
  line1: z.string().trim().min(2, 'Adresse requise').max(160),
  line2: optText(160),
  postal_code: optText(20),
  city: z.string().trim().min(1, 'Ville requise').max(80),
  region: optText(80),
  country: oneOf(COUNTRY_CODES, 'Pays requis'),
  is_default: z.boolean(),
  notes: optText(500),
})

/** Lecture d'un FormData en objet de chaînes (cases à cocher -> booléens). */
export function formToObject(fd: FormData, booleans: string[] = []) {
  const out: Record<string, string | boolean> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  for (const b of booleans) out[b] = fd.get(b) === 'on' || fd.get(b) === 'true'
  return out
}

import { z } from 'zod'
import { COST_KINDS, DEV_DOC_KINDS, EXCHANGE_CHANNEL, EXCHANGE_DIRECTION, FAMILIES } from '@/lib/development/options'

const nul = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null)
const dateOrNull = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide').nullable())
const uuidOrNull = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.uuid('Identifiant invalide').nullable())
const intOrNull = (min: number, max: number, msg: string) => z.string().trim().transform((v) => (v === '' ? null : Number(v.replace(',', '.')))).pipe(z.number().int(msg).min(min, msg).max(max, msg).nullable())
const decimal = (min: number, max: number, msg: string) => z.string().trim().min(1, msg).transform((v) => Number(v.replace(',', '.'))).pipe(z.number().min(min, msg).max(max, msg))
const oneOf = <T extends readonly { value: string }[]>(list: T, msg: string) => z.enum(list.map((l) => l.value) as [string, ...string[]], { error: msg })

export const projectSchema = z.object({
  client_id: z.uuid({ error: 'Client requis' }),
  name: z.string().trim().min(2, 'Désignation requise (2 caractères minimum)').max(160),
  family: oneOf(FAMILIES, 'Famille requise'),
  description: nul(4000),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  owner_id: uuidOrNull,
  requested_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date de la demande requise'),
  due_date: dateOrNull,
  target_qty: intOrNull(1, 10_000_000, 'Quantité : entier supérieur à 0'),
  product_id: uuidOrNull,
})
export const projectEditSchema = projectSchema.omit({ client_id: true, requested_on: true })

export const prototypeSchema = z.object({ project_id: z.uuid(), name: nul(160), description: nul(2000), owner_id: uuidOrNull, due_date: dateOrNull })
export const costSchema = z.object({
  prototype_id: z.uuid(), kind: oneOf(COST_KINDS, 'Type requis'), description: z.string().trim().min(1, 'Description requise').max(200),
  quantity: decimal(0.001, 99_999_999, 'Quantité : supérieure à 0'), unit_cost: decimal(0, 999_999_999, 'Coût unitaire invalide'),
  incurred_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide'),
})
export const sampleSchema = z.object({
  project_id: z.uuid(), prototype_id: uuidOrNull, qty: intOrNull(1, 10000, 'Quantité : entier de 1 à 10 000').pipe(z.number({ error: 'Quantité requise' })),
  size_label: nul(12), color: nul(60), due_date: dateOrNull, notes: nul(1000),
})
export const validationSchema = z.object({ project_id: z.uuid(), kind: z.enum(['sample', 'bat']), sample_id: uuidOrNull, due_date: dateOrNull, comment: nul(1000) })
export const exchangeSchema = z.object({
  project_id: z.uuid(), direction: oneOf(EXCHANGE_DIRECTION, 'Sens requis'), channel: oneOf(EXCHANGE_CHANNEL, 'Canal requis'),
  subject: z.string().trim().min(1, 'Objet requis').max(160), body: nul(4000), contact_name: nul(120),
  exchanged_on: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide'),
})
export const docKindSchema = oneOf(DEV_DOC_KINDS, 'Type requis')
export const industrializationSchema = z.object({
  target_date: dateOrNull, pilot_qty: intOrNull(1, 1_000_000, 'Série pilote : entier supérieur à 0'), lead_time_days: intOrNull(0, 1000, 'Délai : 0 à 1000 jours'),
  bom_id: uuidOrNull, notes: nul(2000),
})

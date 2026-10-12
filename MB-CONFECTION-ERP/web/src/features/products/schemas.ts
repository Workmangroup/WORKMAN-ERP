import { z } from 'zod'
import { BLEACH, CERT_STATUS, CERT_TYPES, DOC_KINDS, DRY_CLEAN, FAMILIES, IRON, TUMBLE, WASH } from '@/lib/products/options'

const txt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? undefined : v)).optional()
const nul = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null)
const oneOf = (list: readonly { value: string }[]) => z.enum(list.map((l) => l.value) as [string, ...string[]]).optional().or(z.literal('').transform(() => undefined))
const num = (min: number, max: number) => z.number().min(min).max(max).optional()
const uuidOrNull = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.uuid('Identifiant invalide').nullable())
const dateOrNull = z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide').nullable())

/** Fiche d'une version (re-validée en base par product_spec_valid). */
export const specSchema = z.object({
  tech: z.object({
    composition: txt(300), fabric: txt(160), weight_gsm: num(0, 5000), season: txt(40), gender: txt(20), construction: txt(300), finishing: txt(300), notes: txt(2000),
  }),
  colors: z.array(z.object({
    name: z.string().trim().min(1, 'Nom de couleur requis').max(60),
    pantone: txt(30), client_code: txt(30),
    hex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Code couleur invalide (#RRGGBB)').optional().or(z.literal('').transform(() => undefined)),
  })).max(60, '60 couleurs maximum'),
  sizes: z.array(z.object({ label: z.string().trim().min(1, 'Taille requise').max(12, '12 caractères maximum'), client_code: txt(30) })).max(40, '40 tailles maximum'),
  variants: z.array(z.object({
    sku: z.string().trim().min(1, 'SKU requis').max(40), color: txt(60), size: txt(12), barcode: txt(20), active: z.boolean().optional(),
  })).max(800, '800 variantes maximum'),
  measurements: z.array(z.object({
    point: z.string().trim().min(1, 'Point de mesure requis').max(80), tolerance: num(0, 100),
    values: z.record(z.string().max(12), z.number().min(0).max(1000)),
  })).max(60, '60 points de mesure maximum'),
  care: z.object({ wash: oneOf(WASH), bleach: oneOf(BLEACH), tumble: oneOf(TUMBLE), iron: oneOf(IRON), dry_clean: oneOf(DRY_CLEAN), instructions: txt(1000) }),
  packaging: z.object({
    unit: txt(160), units_per_carton: num(1, 100000), carton_weight_kg: num(0, 1000),
    carton_dims_cm: z.object({ l: num(0, 500), w: num(0, 500), h: num(0, 500) }).optional(), labeling: txt(300), instructions: txt(1000),
  }),
}).superRefine((s, ctx) => {
  const dup = (vals: string[], path: string, msg: string) => {
    const seen = new Set<string>()
    for (const v of vals) { const k = v.trim().toLowerCase(); if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [path], message: `${msg} : « ${v} »` }); seen.add(k) }
  }
  dup(s.colors.map((c) => c.name), 'colors', 'Couleur en double')
  dup(s.sizes.map((x) => x.label), 'sizes', 'Taille en double')
  dup(s.variants.map((v) => v.sku), 'variants', 'SKU en double')
  dup(s.measurements.map((m) => m.point), 'measurements', 'Point de mesure en double')
})

export const productSchema = z.object({
  client_id: z.uuid({ error: 'Client requis' }),
  name: z.string().trim().min(2, 'Désignation requise (2 caractères minimum)').max(160),
  family: z.enum(FAMILIES.map((f) => f.value) as [string, ...string[]], { error: 'Famille requise' }),
  description: nul(2000),
})
export const productEditSchema = productSchema.omit({ client_id: true }).extend({ article_id: uuidOrNull })

export const certSchema = z.object({
  standard_code: z.string().trim().min(2, 'Norme requise').max(60),
  label: nul(160),
  cert_type: z.enum(CERT_TYPES.map((c) => c.value) as [string, ...string[]]),
  class_level: nul(30), certificate_no: nul(80), issuer: nul(120),
  issued_on: dateOrNull, valid_until: dateOrNull,
  status: z.enum(CERT_STATUS.map((c) => c.value) as [string, ...string[]]),
  ged_document_id: uuidOrNull,
  notes: nul(500),
})
export const docKindSchema = z.enum(DOC_KINDS.map((d) => d.value) as [string, ...string[]])

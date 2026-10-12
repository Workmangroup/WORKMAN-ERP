import { z } from 'zod'
import { BLEACH, DRY_CLEAN, FAMILIES, IRON, TUMBLE, WASH } from '@/lib/articles/options'

const txt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? undefined : v)).optional()
const oneOf = (list: readonly { value: string }[]) => z.enum(list.map((l) => l.value) as [string, ...string[]]).optional().or(z.literal('').transform(() => undefined))
const num = (min: number, max: number) => z.number().min(min).max(max).optional()

/** Fiche d'une version : couleurs, tailles, normes, packaging, lavage (re-validée en base par article_spec_valid). */
export const specSchema = z.object({
  colors: z.array(z.object({
    name: z.string().trim().min(1, 'Nom de couleur requis').max(60),
    code: txt(30), pantone: txt(30), client_code: txt(30),
    hex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Code couleur invalide (#RRGGBB)').optional().or(z.literal('').transform(() => undefined)),
  })).max(60, '60 couleurs maximum'),
  sizes: z.array(z.object({ label: z.string().trim().min(1, 'Taille requise').max(12, '12 caractères maximum'), client_code: txt(30) })).max(40, '40 tailles maximum'),
  norms: z.array(z.object({
    code: z.string().trim().min(1, 'Code de norme requis').max(60),
    label: txt(120), class: txt(20), certificate_ref: txt(60),
    valid_until: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide').optional().or(z.literal('').transform(() => undefined)),
  })).max(30, '30 normes maximum'),
  packaging: z.object({
    unit: txt(160), units_per_carton: num(1, 100000), carton_weight_kg: num(0, 1000),
    carton_dims_cm: z.object({ l: num(0, 500), w: num(0, 500), h: num(0, 500) }).optional(),
    labeling: txt(300), instructions: txt(1000),
  }),
  care: z.object({
    wash: oneOf(WASH), bleach: oneOf(BLEACH), tumble: oneOf(TUMBLE), iron: oneOf(IRON), dry_clean: oneOf(DRY_CLEAN),
    composition: txt(200), instructions: txt(1000),
  }),
}).superRefine((s, ctx) => {
  const dup = (vals: string[], path: string, msg: string) => {
    const seen = new Set<string>()
    for (const v of vals) { const k = v.trim().toLowerCase(); if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [path], message: `${msg} : « ${v} »` }); seen.add(k) }
  }
  dup(s.colors.map((c) => c.name), 'colors', 'Couleur en double')
  dup(s.sizes.map((x) => x.label), 'sizes', 'Taille en double')
  dup(s.norms.map((n) => n.code), 'norms', 'Norme en double')
})

export const articleSchema = z.object({
  client_id: z.uuid({ error: 'Client requis' }),
  internal_ref: z.string().trim().toUpperCase()
    .refine((v) => v === '' || /^[A-Z0-9][A-Z0-9_-]{1,29}$/.test(v), 'Lettres, chiffres, - et _ (2 à 30 caractères)')
    .transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null),
  client_ref: z.string().trim().min(1, 'Référence client requise').max(60, '60 caractères maximum'),
  name: z.string().trim().min(2, 'Désignation requise (2 caractères minimum)').max(160),
  family: z.enum(FAMILIES.map((f) => f.value) as [string, ...string[]], { error: 'Famille requise' }),
  description: z.string().trim().max(2000).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null),
})

export const articleEditSchema = articleSchema.omit({ client_id: true, internal_ref: true }).extend({
  status: z.enum(['draft', 'active', 'discontinued']),
})

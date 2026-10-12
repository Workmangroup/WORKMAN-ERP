import { z } from 'zod'
import { MATERIAL_CATEGORIES, UNITS } from '@/lib/bom/options'

const opt = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).optional().transform((v) => v ?? null)
/** Nombre saisi avec virgule ou point décimal. */
const decimal = (label: string, min: number, max: number, opts: { gt?: boolean } = {}) =>
  z.string().trim().min(1, `${label} requis`).transform((v) => Number(v.replace(',', '.').replace(/\s/g, '')))
    .refine((n) => Number.isFinite(n), `${label} invalide`)
    .refine((n) => (opts.gt ? n > min : n >= min), opts.gt ? `${label} : supérieur à ${min}` : `${label} : minimum ${min}`)
    .refine((n) => n <= max, `${label} : maximum ${max}`)
const optDecimal = (label: string, min: number, max: number) =>
  z.string().trim().optional().transform((v) => (v === undefined || v === '' ? null : v)).pipe(z.union([z.null(), decimal(label, min, max)]))

export const materialSchema = z.object({
  name: z.string().trim().min(2, 'Désignation requise (2 caractères minimum)').max(160),
  category: z.enum(MATERIAL_CATEGORIES.map((c) => c.value) as [string, ...string[]], { error: 'Catégorie requise' }),
  unit: z.enum(UNITS.map((u) => u.value) as [string, ...string[]], { error: 'Unité requise' }),
  color: opt(60),
  supplier_id: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.uuid('Fournisseur invalide')])).optional().transform((v) => v ?? null),
  description: opt(500),
  unit_cost: optDecimal('Prix unitaire', 0, 999999),
})

export const bomSchema = z.object({
  name: z.string().trim().min(2, 'Nom requis (2 caractères minimum)').max(160),
  kind: z.enum(['product', 'subassembly'], { error: 'Type requis' }),
  article_id: z.string().trim().transform((v) => (v === '' ? null : v)).pipe(z.union([z.null(), z.uuid('Article invalide')])).optional().transform((v) => v ?? null),
  description: opt(2000),
})
export const bomEditSchema = bomSchema.omit({ kind: true })

/** Ligne : composant (material_id) ou sous-ensemble (child_bom_id). */
export const lineSchema = z.object({
  version_id: z.uuid(),
  component: z.string().trim().min(1, 'Choisissez un composant ou un sous-ensemble'),
  quantity: decimal('Quantité', 0, 1_000_000, { gt: true }),
  waste_pct: optDecimal('Perte', 0, 100),
  note: opt(300),
})
export const lineEditSchema = z.object({
  id: z.uuid(),
  quantity: decimal('Quantité', 0, 1_000_000, { gt: true }),
  waste_pct: optDecimal('Perte', 0, 100),
  note: opt(300),
})

export const opSchema = z.object({
  version_id: z.uuid(),
  name: z.string().trim().min(2, 'Nom de l’opération requis').max(120),
  minutes: decimal('Durée (min)', 0, 600, { gt: true }),
  note: opt(300),
})
export const opEditSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(2, 'Nom de l’opération requis').max(120),
  minutes: decimal('Durée (min)', 0, 600, { gt: true }),
})

export const costingSchema = z.object({
  version_id: z.uuid(),
  hourly_rate: decimal('Taux horaire', 0, 1000),
  overhead_pct: decimal('Frais généraux', 0, 300),
})

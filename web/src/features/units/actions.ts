'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { FormState } from '@/features/auth/types'

/**
 * Conversions d'unités : saisie explicite par composant, avec sa base. La base (material_conversion_set) contrôle le droit
 * bom.write, le facteur et la base ; aucune conversion n'est déduite ici.
 */
const MESSAGES: Record<string, string> = {
  RBAC_FORBIDDEN: 'Vous n’avez pas la permission de saisir une conversion.',
  UNIT_SAME: 'Les deux unités sont identiques.',
  UNIT_BAD_FACTOR: 'Le facteur doit être supérieur à 0.',
  UNIT_BASIS_REQUIRED: 'Indiquez la source de la valeur (fiche technique, mesure…), 5 caractères minimum.',
  MATERIAL_NOT_FOUND: 'Composant introuvable.',
  UNIT_UNKNOWN: 'Unité inconnue.',
}

const schema = z.object({
  material: z.uuid(),
  from_unit: z.string().min(1).max(8),
  to_unit: z.string().min(1).max(8),
  factor: z.string().trim().transform((v) => Number(v.replace(',', '.'))).pipe(z.number().positive('Facteur supérieur à 0').max(1_000_000_000)),
  basis: z.string().trim().min(5, 'Source : 5 caractères minimum').max(300),
})

export async function saveConversionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const v = schema.safeParse(Object.fromEntries([...fd.entries()].filter(([, x]) => typeof x === 'string')))
  if (!v.success) return { ok: false, message: v.error.issues[0]?.message ?? 'Saisie invalide.' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('material_conversion_set', {
    p_material: v.data.material, p_from: v.data.from_unit, p_to: v.data.to_unit, p_factor: v.data.factor, p_basis: v.data.basis,
  })
  if (error) {
    const key = Object.keys(MESSAGES).find((k) => `${error.message} ${error.details ?? ''}`.includes(k))
    return { ok: false, message: key ? MESSAGES[key] : 'Conversion non enregistrée : vérifiez les données et vos droits.' }
  }
  revalidatePath('/bom/conversions')
  return { ok: true, message: 'Conversion enregistrée et tracée.' }
}

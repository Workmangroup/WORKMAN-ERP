'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { FormState } from '@/features/auth/types'

/** Résolution d'un code scanné (P042, migration 0067) : un seul résultat, sinon erreur explicite. Périmètre entrepôt appliqué en base. */
const KIND: Record<string, string> = {
  material: 'Composant', variant: 'Article (SKU)', location: 'Emplacement', lot: 'Lot', unit: 'Unité', pick: 'Préparation', transfer: 'Transfert', inventory: 'Inventaire',
}

export async function resolveStockCodeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(P.STOCK_READ)) return { ok: false, message: 'Vous n’avez pas la permission de consulter les stocks.' }
  const parsed = z.string().trim().max(60).safeParse(String(fd.get('code') ?? ''))
  if (!parsed.success || !parsed.data) return { ok: false, message: 'Saisissez ou scannez un code.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('scan_resolve', { p_code: parsed.data })
  if (error) return { ok: false, message: 'Recherche impossible pour le moment.' }
  const res = data as { ok: boolean; code?: string; message?: string; hit?: { kind: string; label: string } }
  if (!res.ok) return { ok: false, message: res.message ?? 'Code non reconnu.' }
  return { ok: true, message: `${KIND[res.hit?.kind ?? ''] ?? 'Élément'} : ${res.hit?.label ?? ''}` }
}

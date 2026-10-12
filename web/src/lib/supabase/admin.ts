import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { publicEnv } from '@/lib/env'

/**
 * Client « service_role » : contourne la RLS. SERVEUR UNIQUEMENT.
 * Utilisé pour le journal d'authentification, le verrouillage de compte et
 * la mise à jour des indicateurs de profil (must_change_password...).
 */
export function hasServiceRole() {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && publicEnv.supabaseUrl)
}

export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY manquante (serveur uniquement).')
  return createClient(publicEnv.supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

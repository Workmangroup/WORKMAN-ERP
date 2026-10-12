import { createBrowserClient } from '@supabase/ssr'
import { assertPublicEnv, publicEnv } from '@/lib/env'

/** Client Supabase côté navigateur (clé anon + session de l'utilisateur). */
export function createClient() {
  assertPublicEnv()
  return createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey)
}

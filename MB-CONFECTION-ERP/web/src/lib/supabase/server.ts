import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { assertPublicEnv, publicEnv } from '@/lib/env'

/** Client Supabase serveur (Server Components, Server Actions, Route Handlers). */
export async function createClient() {
  assertPublicEnv()
  const cookieStore = await cookies()
  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(list) {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Appelé depuis un Server Component : le middleware rafraîchit la session.
        }
      },
    },
  })
}

'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { publicEnv } from '@/lib/env'

/**
 * Désinscription publique : client anonyme (aucune session). La réponse est la même que le jeton existe ou non,
 * afin de ne rien révéler sur les destinataires.
 */
export async function confirmUnsubscribeAction(fd: FormData): Promise<void> {
  const token = String(fd.get('token') ?? '').trim()
  if (publicEnv.supabaseUrl && publicEnv.supabaseAnonKey) {
    const supabase = createClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    await supabase.rpc('marketing_unsubscribe', { p_token: token })
  }
  redirect('/desinscription?done=1')
}

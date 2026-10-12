import type { EmailOtpType } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { COOKIE_RECOVERY, RECOVERY_MAX_AGE_S, ROUTES } from '@/lib/auth/constants'

/**
 * Variante « token_hash » (templates e-mail personnalisés) :
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery
 * Fonctionne même si le lien est ouvert dans un autre navigateur que celui
 * de la demande (contrairement au flux PKCE de /auth/callback).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  const fail = () => NextResponse.redirect(`${origin}${ROUTES.login}?error=link_invalid`)
  if (!tokenHash || !type) return fail()

  const supabase = await createClient()
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
  if (error) return fail()

  const isRecovery = type === 'recovery'
  const response = NextResponse.redirect(`${origin}${isRecovery ? ROUTES.resetPassword : ROUTES.home}`)
  if (isRecovery) {
    response.cookies.set(COOKIE_RECOVERY, '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: RECOVERY_MAX_AGE_S,
    })
  }
  return response
}

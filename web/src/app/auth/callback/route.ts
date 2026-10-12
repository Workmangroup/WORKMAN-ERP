import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { COOKIE_RECOVERY, RECOVERY_MAX_AGE_S, ROUTES } from '@/lib/auth/constants'

/**
 * Retour du lien e-mail (PKCE) : échange le `code` contre une session.
 * Pour le lien de récupération, pose le cookie mb_recovery qui limite la
 * session à la seule page /reset-password (voir middleware).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next')
  const isRecovery = next === ROUTES.resetPassword

  const fail = () => NextResponse.redirect(`${origin}${ROUTES.login}?error=link_invalid`)
  if (!code) return fail()

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) return fail()

  const response = NextResponse.redirect(`${origin}${isRecovery ? ROUTES.resetPassword : ROUTES.home}`)
  if (isRecovery) {
    response.cookies.set(COOKIE_RECOVERY, '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: RECOVERY_MAX_AGE_S,
    })
  } else {
    ;(await cookies()).delete(COOKIE_RECOVERY)
  }
  return response
}

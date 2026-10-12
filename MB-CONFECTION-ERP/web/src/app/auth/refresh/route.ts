import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decodeJwtClaims } from '@/lib/auth/claims'
import { ROUTES } from '@/lib/auth/constants'
import { safeNext } from '@/lib/auth/redirect'
import { isAllowed, ruleForPath } from '@/lib/rbac/menu'

/**
 * Le middleware refuse une route d'après les permissions du JWT. Si les droits ont changé
 * depuis l'émission du jeton, on le renouvelle (le hook recalcule app_permissions) puis on
 * ré-évalue : accès accordé -> retour à la page, sinon -> /unauthorized (pas de boucle).
 */
export async function GET(request: NextRequest) {
  const { origin, searchParams } = new URL(request.url)
  const next = safeNext(searchParams.get('next'), ROUTES.home)

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(`${origin}${ROUTES.login}?next=${encodeURIComponent(next)}`)

  const { data, error } = await supabase.auth.refreshSession()
  const claims = decodeJwtClaims(data.session?.access_token)
  const path = next.split('?')[0]
  const rule = ruleForPath(path)
  const allowed = !error && (!rule || isAllowed(rule.permission, claims?.app_permissions ?? []))

  return NextResponse.redirect(`${origin}${allowed ? next : ROUTES.unauthorized}`)
}

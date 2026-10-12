import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { publicEnv, securityPolicy } from '@/lib/env'
import { decodeJwtClaims } from '@/lib/auth/claims'
import { isAllowed, ruleForPath } from '@/lib/rbac/menu'
import {
  ACTIVITY_REFRESH_MS,
  COOKIE_ACTIVITY,
  COOKIE_RECOVERY,
  GUEST_ONLY_PATHS,
  PUBLIC_PATHS,
  ROUTES,
  matchesPath,
} from '@/lib/auth/constants'

const isProd = process.env.NODE_ENV === 'production'

/**
 * Cœur du middleware d'authentification :
 *  1. rafraîchit la session Supabase (cookies) et la valide via getUser() ;
 *  2. protège les routes (redirection vers /login?next=...) ;
 *  3. applique le timeout d'inactivité ;
 *  4. force le changement de mot de passe si demandé ;
 *  5. restreint la session de récupération à /reset-password ;
 *  6. applique le contrôle d'accès RBAC par route (claim JWT app_permissions).
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list) {
        list.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })

  const { pathname, search } = request.nextUrl
  const isApi = pathname.startsWith('/api/')

  const redirect = (to: string, extra?: Record<string, string>) => {
    const url = request.nextUrl.clone()
    url.pathname = to
    url.search = ''
    Object.entries(extra ?? {}).forEach(([k, v]) => url.searchParams.set(k, v))
    const res = NextResponse.redirect(url)
    response.cookies.getAll().forEach((c) => res.cookies.set(c))
    return res
  }

  // getUser() valide le JWT auprès du serveur Auth (ne jamais se fier à getSession() seul).
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isPublic = matchesPath(pathname, PUBLIC_PATHS)

  // ---- Non authentifié ------------------------------------------------
  if (!user) {
    if (request.cookies.get(COOKIE_ACTIVITY)) response.cookies.delete(COOKIE_ACTIVITY)
    if (isPublic) return response
    if (isApi) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
    return redirect(ROUTES.login, { next: pathname + search })
  }

  // ---- Session de récupération de mot de passe -------------------------
  const inRecovery = request.cookies.get(COOKIE_RECOVERY)?.value === '1'
  if (inRecovery && pathname !== ROUTES.resetPassword && !pathname.startsWith('/auth/')) {
    return isApi ? NextResponse.json({ error: 'RECOVERY_ONLY' }, { status: 403 }) : redirect(ROUTES.resetPassword)
  }

  // ---- Timeout d'inactivité -------------------------------------------
  const now = Date.now()
  const last = Number(request.cookies.get(COOKIE_ACTIVITY)?.value ?? 0)
  if (last && now - last > securityPolicy.idleTimeoutMs && !inRecovery) {
    await supabase.auth.signOut()
    response.cookies.delete(COOKIE_ACTIVITY)
    return isApi
      ? NextResponse.json({ error: 'IDLE_TIMEOUT' }, { status: 401 })
      : redirect(ROUTES.login, { reason: 'idle', next: pathname + search })
  }
  if (!last || now - last > ACTIVITY_REFRESH_MS) {
    response.cookies.set(COOKIE_ACTIVITY, String(now), {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      path: '/',
    })
  }

  // ---- Claims JWT (ajoutés par le hook custom_access_token) -----------
  const {
    data: { session },
  } = await supabase.auth.getSession()
  const claims = decodeJwtClaims(session?.access_token)

  if (claims?.is_active === false) {
    await supabase.auth.signOut()
    return redirect(ROUTES.login, { reason: 'disabled' })
  }

  // Utilisateur connecté sur une page réservée aux invités -> accueil
  if (matchesPath(pathname, GUEST_ONLY_PATHS)) return redirect(ROUTES.home)

  // Changement de mot de passe obligatoire
  if (
    claims?.must_change_password &&
    pathname !== ROUTES.changePassword &&
    !pathname.startsWith('/auth/') &&
    !isApi
  ) {
    return redirect(ROUTES.changePassword)
  }

  // RBAC : permission requise par route (menu + règles). Le claim peut être en retard sur la base
  // (jusqu'au prochain renouvellement du jeton) ; les guards serveur restent la source de vérité.
  const rule = ruleForPath(pathname)
  if (rule && !isAllowed(rule.permission, claims?.app_permissions ?? [])) {
    return isApi ? NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 }) : redirect('/auth/refresh', { next: pathname + search })
  }

  return response
}

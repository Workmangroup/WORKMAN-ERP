'use server'

import { createClient as createBareClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin'
import { publicEnv } from '@/lib/env'
import { COOKIE_ACTIVITY, COOKIE_RECOVERY, ROUTES } from '@/lib/auth/constants'
import { safeNext } from '@/lib/auth/redirect'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
} from './schemas'
import { getLockout, logAuthEvent } from './services/audit.service'
import { getAuthContext } from './services/access.service'
import type { FormState } from './types'

const GENERIC_LOGIN_ERROR = 'Adresse e-mail ou mot de passe incorrect.'

function fieldErrors(error: z.ZodError, values?: Record<string, string>): FormState {
  return { ok: false, fieldErrors: z.flattenError(error).fieldErrors, message: 'Veuillez corriger les champs en erreur.', values }
}

async function clearAppCookies() {
  const store = await cookies()
  store.delete(COOKIE_ACTIVITY)
  store.delete(COOKIE_RECOVERY)
}

/** Met à jour les indicateurs de profil (service_role : colonnes non modifiables par l'utilisateur). */
async function markPasswordChanged(userId: string) {
  if (!hasServiceRole()) return
  await createAdminClient()
    .from('profiles')
    .update({ must_change_password: false, password_changed_at: new Date().toISOString() })
    .eq('id', userId)
}

// ---------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------
export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  })
  const emailValue = String(formData.get('email') ?? '')
  if (!parsed.success) return fieldErrors(parsed.error, { email: emailValue })
  const { email, password } = parsed.data

  const lock = await getLockout(email)
  if (lock.locked) {
    await logAuthEvent({ type: 'login_locked', email, success: false })
    return {
      ok: false,
      message: `Compte temporairement verrouillé après plusieurs échecs. Réessayez dans ${lock.retryAfterMin} min ou réinitialisez votre mot de passe.`,
      values: { email },
    }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error || !data.user) {
    await logAuthEvent({ type: 'login_failed', email, success: false, metadata: { code: error?.code } })
    return { ok: false, message: GENERIC_LOGIN_ERROR, values: { email } }
  }

  // Compte désactivé ? (la RLS autorise la lecture de son propre profil)
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_active, company_id, must_change_password')
    .eq('id', data.user.id)
    .maybeSingle()
  if (!profile || !profile.is_active) {
    await supabase.auth.signOut()
    await logAuthEvent({ type: 'login_failed', email, userId: data.user.id, success: false, metadata: { reason: 'inactive' } })
    return { ok: false, message: "Ce compte est désactivé. Contactez votre administrateur.", values: { email } }
  }

  if (hasServiceRole()) {
    await createAdminClient().from('profiles').update({ last_sign_in_at: new Date().toISOString() }).eq('id', data.user.id)
  }
  await logAuthEvent({ type: 'login_success', email, userId: data.user.id, companyId: profile.company_id })

  if (profile.must_change_password) redirect(ROUTES.changePassword)
  redirect(safeNext(parsed.data.next))
}

// ---------------------------------------------------------------------
// Déconnexion
// ---------------------------------------------------------------------
export async function signOutAction(): Promise<void> {
  const ctx = await getAuthContext()
  const supabase = await createClient()
  await supabase.auth.signOut({ scope: 'local' })
  await clearAppCookies()
  if (ctx) await logAuthEvent({ type: 'logout', email: ctx.user.email, userId: ctx.user.id, companyId: ctx.profile.company_id })
  redirect(`${ROUTES.login}?reason=signedout`)
}

/** Déconnecte TOUTES les sessions de l'utilisateur (tous appareils). */
export async function signOutEverywhereAction(): Promise<void> {
  const ctx = await getAuthContext()
  const supabase = await createClient()
  await supabase.auth.signOut({ scope: 'global' })
  await clearAppCookies()
  if (ctx) await logAuthEvent({ type: 'logout_all', email: ctx.user.email, userId: ctx.user.id, companyId: ctx.profile.company_id })
  redirect(`${ROUTES.login}?reason=signedout`)
}

// ---------------------------------------------------------------------
// Mot de passe oublié -> e-mail avec lien de récupération
// ---------------------------------------------------------------------
export async function forgotPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get('email') })
  if (!parsed.success) return fieldErrors(parsed.error)
  const { email } = parsed.data

  const supabase = await createClient()
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${publicEnv.siteUrl}/auth/callback?next=${encodeURIComponent(ROUTES.resetPassword)}`,
  })
  await logAuthEvent({ type: 'password_reset_requested', email, success: !error })

  // Réponse volontairement identique que le compte existe ou non (anti-énumération).
  if (error && error.status === 429) {
    return { ok: false, message: 'Trop de demandes. Réessayez dans quelques minutes.' }
  }
  return {
    ok: true,
    message: "Si un compte correspond à cette adresse, un e-mail contenant un lien de réinitialisation vient d'être envoyé.",
  }
}

// ---------------------------------------------------------------------
// Réinitialisation (depuis le lien reçu par e-mail ; session de récupération)
// ---------------------------------------------------------------------
export async function resetPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) return fieldErrors(parsed.error)

  const store = await cookies()
  if (store.get(COOKIE_RECOVERY)?.value !== '1') {
    return { ok: false, message: 'Lien de récupération invalide ou expiré. Demandez un nouveau lien.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, message: 'Session de récupération expirée. Demandez un nouveau lien.' }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
  if (error) {
    const msg = /same|different/i.test(error.message)
      ? 'Le nouveau mot de passe doit être différent de l’ancien.'
      : /weak|password/i.test(error.message)
        ? 'Mot de passe refusé par la politique de sécurité.'
        : 'Impossible de mettre à jour le mot de passe. Réessayez.'
    return { ok: false, message: msg }
  }

  await markPasswordChanged(user.id)
  await logAuthEvent({ type: 'password_reset_completed', email: user.email, userId: user.id })

  // Révoque toutes les sessions (y compris celle de récupération) : reconnexion obligatoire.
  await supabase.auth.signOut({ scope: 'global' })
  await clearAppCookies()
  redirect(`${ROUTES.login}?reset=success`)
}

// ---------------------------------------------------------------------
// Changement de mot de passe (utilisateur connecté)
// ---------------------------------------------------------------------
export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = changePasswordSchema.safeParse({
    current: formData.get('current'),
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })
  if (!parsed.success) return fieldErrors(parsed.error)

  const ctx = await getAuthContext()
  if (!ctx) redirect(ROUTES.login)

  // Vérifie le mot de passe actuel avec un client éphémère (n'affecte pas la session en cours).
  const probe = createBareClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data: check, error: checkError } = await probe.auth.signInWithPassword({
    email: ctx.user.email,
    password: parsed.data.current,
  })
  if (checkError || !check.session) {
    await logAuthEvent({ type: 'password_change_failed', email: ctx.user.email, userId: ctx.user.id, success: false })
    return { ok: false, fieldErrors: { current: ['Mot de passe actuel incorrect'] }, message: 'Mot de passe actuel incorrect.' }
  }
  // Supprime la session éphémère créée par la vérification.
  await probe.auth.signOut({ scope: 'local' }).catch(() => undefined)

  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
  if (error) {
    return {
      ok: false,
      message: /same|different/i.test(error.message)
        ? 'Le nouveau mot de passe doit être différent de l’ancien.'
        : 'Impossible de modifier le mot de passe. Vérifiez la politique de sécurité et réessayez.',
    }
  }

  await markPasswordChanged(ctx.user.id)
  // Révoque les autres appareils, conserve la session courante et rafraîchit les claims JWT.
  await supabase.auth.signOut({ scope: 'others' })
  await supabase.auth.refreshSession()
  await logAuthEvent({
    type: 'password_changed',
    email: ctx.user.email,
    userId: ctx.user.id,
    companyId: ctx.profile.company_id,
    metadata: { forced: ctx.profile.must_change_password },
  })

  if (ctx.profile.must_change_password) redirect(ROUTES.home)
  revalidatePath(ROUTES.security)
  return { ok: true, message: 'Mot de passe modifié. Les autres appareils ont été déconnectés.' }
}

// ---------------------------------------------------------------------
// Gestion des sessions
// ---------------------------------------------------------------------
export async function revokeSessionAction(formData: FormData): Promise<void> {
  const ctx = await getAuthContext()
  if (!ctx) redirect(ROUTES.login)
  const id = z.uuid().safeParse(formData.get('session_id'))
  if (!id.success) return
  if (id.data === ctx.sessionId) return // la session courante se ferme via « Se déconnecter »

  const supabase = await createClient()
  const { data: ok } = await supabase.rpc('revoke_session', { p_session_id: id.data })
  if (ok) {
    await logAuthEvent({ type: 'session_revoked', email: ctx.user.email, userId: ctx.user.id, companyId: ctx.profile.company_id })
  }
  revalidatePath(ROUTES.security)
}

export async function revokeOtherSessionsAction(): Promise<void> {
  const ctx = await getAuthContext()
  if (!ctx) redirect(ROUTES.login)
  const supabase = await createClient()
  const { data: count } = await supabase.rpc('revoke_other_sessions')
  await logAuthEvent({
    type: 'sessions_revoked_others',
    email: ctx.user.email,
    userId: ctx.user.id,
    companyId: ctx.profile.company_id,
    metadata: { count: count ?? 0 },
  })
  revalidatePath(ROUTES.security)
}

/** Enregistre l'expiration d'inactivité (appelé par l'UI avant déconnexion). */
export async function idleSignOutAction(): Promise<void> {
  const ctx = await getAuthContext()
  const supabase = await createClient()
  await supabase.auth.signOut({ scope: 'local' })
  await clearAppCookies()
  if (ctx) await logAuthEvent({ type: 'session_idle_timeout', email: ctx.user.email, userId: ctx.user.id, companyId: ctx.profile.company_id })
  redirect(`${ROUTES.login}?reason=idle`)
}

import 'server-only'
import { createClient } from '@/lib/supabase/server'

/**
 * Appels à l'API WORKMAN (Laravel) depuis le serveur Next.js, au nom de l'utilisateur connecté.
 * Le jeton de session Supabase est transmis tel quel : l'API applique les droits (RLS).
 * Le frontend ne lit jamais la base directement pour les modules migrés.
 */
const API_URL = (process.env.WORKMAN_API_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
  }
}

/** Erreur de validation renvoyée par l'API : messages par champ. */
export type ApiFieldErrors = Record<string, string[] | undefined>

export type ApiWriteResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; fieldErrors?: ApiFieldErrors }

export async function apiWrite<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiWriteResult<T>> {
  if (!API_URL) return { ok: false, status: 500, code: 'API_NOT_CONFIGURED', message: 'WORKMAN_API_URL non défini.' }

  const supabase = await createClient()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, status: 401, code: 'UNAUTHENTICATED', message: 'Session absente.' }

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const json = (await res.json().catch(() => ({}))) as {
    data?: T; error?: string; message?: string; errors?: ApiFieldErrors
  }
  if (res.ok) return { ok: true, status: res.status, data: json.data as T }

  return {
    ok: false,
    status: res.status,
    code: json.error ?? 'API_ERROR',
    message: json.message ?? `Erreur API ${res.status}`,
    fieldErrors: json.errors,
  }
}

export async function apiGet<T>(path: string, query: Record<string, string | number | undefined | null> = {}): Promise<T> {
  if (!API_URL) throw new ApiError(500, 'API_NOT_CONFIGURED', 'WORKMAN_API_URL non défini.')

  const supabase = await createClient()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Session absente.')

  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
  }
  const qs = params.toString()

  const res = await fetch(`${API_URL}${path}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'API_ERROR', body.message ?? `Erreur API ${res.status}`)

  return body as T
}

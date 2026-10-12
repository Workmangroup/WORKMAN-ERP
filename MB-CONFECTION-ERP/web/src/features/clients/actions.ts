'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { removeFiles } from '@/features/ged/services/storage.service'
import { P } from '@/lib/rbac/permissions'
import { getAuthContext } from '@/features/auth/services/access.service'
import type { AuthContextValue, FormState } from '@/features/auth/types'
import { logAccessDenied } from '@/features/rbac/services/audit-write.service'
import { apiWrite, type ApiWriteResult } from '@/lib/api/server'
import { clientErrorMessage } from './errors'
import { addressSchema, clientSchema, contactSchema, formToObject } from './schemas'

/**
 * Actions du module Clients. Chaque écriture passe par l'API WORKMAN, au nom de l'utilisateur connecté :
 * la validation et les droits (clients.read / clients.write / clients.delete, RLS, RPC) sont appliqués côté API et base.
 * Le contrôle de permission ci-dessous ne sert qu'à refuser tôt et à journaliser le refus.
 */

const uuid = z.uuid()

type ApiFailure = Extract<ApiWriteResult<unknown>, { ok: false }>

async function authorize(permission: string): Promise<{ ctx: AuthContextValue } | { error: FormState }> {
  const ctx = await getAuthContext()
  if (!ctx) redirect('/login')
  if (!ctx.permissions.includes(permission)) {
    await logAccessDenied(ctx, permission, { via: 'server-action' })
    return { error: { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.' } }
  }
  return { ctx }
}

const raw = (fd: FormData): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of fd.entries()) if (typeof v === 'string' && !k.startsWith('$ACTION')) out[k] = v
  return out
}

const invalid = (e: z.ZodError, values: Record<string, string>): FormState => ({
  ok: false,
  message: 'Veuillez corriger les champs en erreur.',
  fieldErrors: z.flattenError(e).fieldErrors,
  values,
})

/** Traduit une réponse d'erreur de l'API en état de formulaire. */
async function apiFail(
  ctx: AuthContextValue,
  permission: string,
  res: ApiFailure,
  values?: Record<string, string>,
  notFound = 'Élément introuvable ou modification non autorisée.',
): Promise<FormState> {
  if (res.status === 403) {
    await logAccessDenied(ctx, permission, { via: 'api' })
    return { ok: false, message: 'Vous n’avez pas la permission d’effectuer cette action.', values }
  }
  if (res.status === 401) return { ok: false, message: 'Session expirée. Reconnectez-vous.', values }
  if (res.status === 404) return { ok: false, message: notFound, values }
  if (res.status === 422 && res.fieldErrors) {
    return { ok: false, message: 'Veuillez corriger les champs en erreur.', fieldErrors: res.fieldErrors, values }
  }
  // Code métier renvoyé par la base (ex. CLIENT_NOT_ARCHIVED) : message lisible, sinon message générique.
  return { ok: false, message: clientErrorMessage({ message: res.code }), values }
}

const CLIENT_BOOLS = ['vat_exempt']

// ---------------------------------------------------------------------
// Client : création / modification
// ---------------------------------------------------------------------
export async function createClientAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.CLIENTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const parsed = clientSchema.safeParse(formToObject(fd, CLIENT_BOOLS))
  if (!parsed.success) return invalid(parsed.error, values)

  const res = await apiWrite<{ id: string }>('POST', '/api/v1/clients', parsed.data)
  if (!res.ok) return apiFail(auth.ctx, P.CLIENTS_WRITE, res, values)
  revalidatePath('/clients')
  redirect(`/clients/${res.data.id}?created=1`)
}

export async function updateClientAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.CLIENTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.', values }
  const parsed = clientSchema.safeParse(formToObject(fd, CLIENT_BOOLS))
  if (!parsed.success) return invalid(parsed.error, values)

  // Le code est immuable après création
  const { code: _code, ...changes } = parsed.data
  void _code
  const res = await apiWrite<{ id: string }>('PATCH', `/api/v1/clients/${id.data}`, changes)
  if (!res.ok) return apiFail(auth.ctx, P.CLIENTS_WRITE, res, values)
  revalidatePath('/clients', 'layout')
  redirect(`/clients/${id.data}?updated=1`)
}

// ---------------------------------------------------------------------
// Archivage / restauration / suppression définitive (clients.delete)
// ---------------------------------------------------------------------
export async function archiveClientAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.CLIENTS_DELETE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  const reason = String(fd.get('reason') ?? '').trim().slice(0, 300)

  const res = await apiWrite<{ id: string; archived: boolean }>('POST', `/api/v1/clients/${id.data}/archive`, { reason: reason || null })
  if (!res.ok) return apiFail(auth.ctx, P.CLIENTS_DELETE, res)
  revalidatePath('/clients', 'layout')
  redirect(`/clients/${id.data}?archived=1`)
}

export async function restoreClientAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.CLIENTS_DELETE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }

  const res = await apiWrite<{ id: string; archived: boolean }>('POST', `/api/v1/clients/${id.data}/restore`)
  if (!res.ok) return apiFail(auth.ctx, P.CLIENTS_DELETE, res)
  revalidatePath('/clients', 'layout')
  redirect(`/clients/${id.data}?restored=1`)
}

export async function deleteClientAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.CLIENTS_DELETE)
  if ('error' in auth) return auth.error
  const id = uuid.safeParse(fd.get('id'))
  if (!id.success) return { ok: false, message: 'Identifiant invalide.' }
  if (String(fd.get('confirm') ?? '').trim().toUpperCase() !== 'SUPPRIMER') {
    return { ok: false, message: 'Saisissez « SUPPRIMER » pour confirmer la suppression définitive.' }
  }

  // L'API supprime le client et renvoie les fichiers GED à retirer du stockage.
  const res = await apiWrite<{ id: string; deleted: boolean; storage: { bucket: string; path: string }[] }>(
    'DELETE', `/api/v1/clients/${id.data}`, { confirm: 'SUPPRIMER' },
  )
  if (!res.ok) return apiFail(auth.ctx, P.CLIENTS_DELETE, res)
  await removeFiles(res.data.storage)
  revalidatePath('/clients')
  redirect('/clients?deleted=1')
}

// ---------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------
export async function saveContactAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.CLIENTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const clientId = uuid.safeParse(fd.get('client_id'))
  if (!clientId.success) return { ok: false, message: 'Client invalide.', values }
  const contactId = fd.get('id') ? uuid.safeParse(fd.get('id')) : null
  if (contactId && !contactId.success) return { ok: false, message: 'Contact invalide.', values }
  const parsed = contactSchema.safeParse(formToObject(fd, ['is_primary']))
  if (!parsed.success) return invalid(parsed.error, values)

  const res = contactId?.success
    ? await apiWrite<unknown>('PATCH', `/api/v1/contacts/${contactId.data}`, parsed.data)
    : await apiWrite<unknown>('POST', `/api/v1/clients/${clientId.data}/contacts`, parsed.data)
  if (!res.ok) return apiFail(auth.ctx, P.CLIENTS_WRITE, res, values, 'Contact ou client introuvable.')
  revalidatePath(`/clients/${clientId.data}`)
  return { ok: true, message: contactId?.success ? 'Contact mis à jour.' : 'Contact ajouté.' }
}

export async function deleteContactAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.CLIENTS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const clientId = uuid.safeParse(fd.get('client_id'))
  if (!id.success || !clientId.success) return
  await apiWrite<unknown>('DELETE', `/api/v1/contacts/${id.data}`)
  revalidatePath(`/clients/${clientId.data}`)
}

// ---------------------------------------------------------------------
// Adresses
// ---------------------------------------------------------------------
export async function saveAddressAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const auth = await authorize(P.CLIENTS_WRITE)
  if ('error' in auth) return auth.error
  const values = raw(fd)
  const clientId = uuid.safeParse(fd.get('client_id'))
  if (!clientId.success) return { ok: false, message: 'Client invalide.', values }
  const addressId = fd.get('id') ? uuid.safeParse(fd.get('id')) : null
  if (addressId && !addressId.success) return { ok: false, message: 'Adresse invalide.', values }
  const parsed = addressSchema.safeParse(formToObject(fd, ['is_default']))
  if (!parsed.success) return invalid(parsed.error, values)

  const res = addressId?.success
    ? await apiWrite<unknown>('PATCH', `/api/v1/addresses/${addressId.data}`, parsed.data)
    : await apiWrite<unknown>('POST', `/api/v1/clients/${clientId.data}/addresses`, parsed.data)
  if (!res.ok) return apiFail(auth.ctx, P.CLIENTS_WRITE, res, values, 'Adresse ou client introuvable.')
  revalidatePath(`/clients/${clientId.data}`)
  return { ok: true, message: addressId?.success ? 'Adresse mise à jour.' : 'Adresse ajoutée.' }
}

export async function deleteAddressAction(fd: FormData): Promise<void> {
  const auth = await authorize(P.CLIENTS_WRITE)
  if ('error' in auth) return
  const id = uuid.safeParse(fd.get('id'))
  const clientId = uuid.safeParse(fd.get('client_id'))
  if (!id.success || !clientId.success) return
  await apiWrite<unknown>('DELETE', `/api/v1/addresses/${id.data}`)
  revalidatePath(`/clients/${clientId.data}`)
}

import 'server-only'
import { ApiError, apiGet } from '@/lib/api/server'
import type { Client, ClientAddress, ClientContact, DirectoryUser, PaymentTerm } from '../types'

/**
 * Lectures du module Clients et des références partagées (conditions de paiement, commerciaux, annuaire).
 * Toutes passent par l'API WORKMAN : le frontend ne lit plus la base directement.
 */

/** Fiche client ; null si absente ou non accessible (l'API répond 404 dans les deux cas). */
export async function getClient(id: string): Promise<Client | null> {
  try {
    return (await apiGet<{ data: Client }>(`/api/v1/clients/${id}`)).data
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

export async function listContacts(clientId: string): Promise<ClientContact[]> {
  return (await apiGet<{ data: ClientContact[] }>(`/api/v1/clients/${clientId}/contacts`)).data
}

export async function listAddresses(clientId: string): Promise<ClientAddress[]> {
  return (await apiGet<{ data: ClientAddress[] }>(`/api/v1/clients/${clientId}/addresses`)).data
}

export async function listPaymentTerms(): Promise<PaymentTerm[]> {
  return (await apiGet<{ data: PaymentTerm[] }>('/api/v1/payment-terms')).data
}

/** Utilisateurs pouvant être affectés comme commercial (détenteurs de clients.write). */
export async function listSalesReps(): Promise<DirectoryUser[]> {
  return (await apiGet<{ data: DirectoryUser[] }>('/api/v1/sales-reps')).data
}

/** Noms des utilisateurs (annuaire de la société) pour afficher commercial / auteurs. */
export async function directoryByIds(ids: (string | null | undefined)[]): Promise<Map<string, DirectoryUser>> {
  const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))]
  const map = new Map<string, DirectoryUser>()
  if (unique.length === 0) return map
  const { data } = await apiGet<{ data: DirectoryUser[] }>('/api/v1/users/directory', { ids: unique.join(',') })
  for (const u of data) map.set(u.id, u)
  return map
}

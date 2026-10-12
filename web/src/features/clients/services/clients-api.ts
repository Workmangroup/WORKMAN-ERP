import 'server-only'
import { apiGet } from '@/lib/api/server'
import type { ClientFilters, ClientListRow } from '../types'

/** Lecture de la liste des clients via l'API WORKMAN (mêmes filtres, tris et compteurs que l'écran). */
export const PAGE_SIZE = 25

interface ClientPageResponse {
  data: ClientListRow[]
  meta: {
    page: number
    per_page: number
    total: number
    counts: { active: number; archived: number }
    facets: { countries: string[]; currencies: string[] }
  }
}

export async function listClients(f: ClientFilters): Promise<{ rows: ClientListRow[]; total: number }> {
  const res = await apiGet<ClientPageResponse>('/api/v1/clients', {
    q: f.q,
    status: f.status ?? 'active',
    country: f.country,
    currency: f.currency,
    terms: f.terms,
    rep: f.rep,
    sort: f.sort ?? 'name',
    page: Math.max(1, f.page ?? 1),
    per_page: PAGE_SIZE,
  })
  return { rows: res.data, total: res.meta.total }
}

export async function countByStatus(): Promise<{ active: number; archived: number }> {
  const res = await apiGet<ClientPageResponse>('/api/v1/clients', { per_page: 1 })
  return res.meta.counts
}

export async function getFacets(): Promise<{ countries: string[]; currencies: string[] }> {
  const res = await apiGet<ClientPageResponse>('/api/v1/clients', { per_page: 1 })
  return res.meta.facets
}

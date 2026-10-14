import type { QuoteStatus, Stage, InvoiceStatus } from './services/commercial.service'

/** Libellés et tons seulement : aucune probabilité n'est codée ici (le pondéré vient des étapes paramétrées, migration 0047). */
export const STAGE_INFO: Record<Stage, { label: string; tone: 'neutral' | 'brand' | 'warning' | 'success' | 'danger' }> = {
  new: { label: 'Nouveau', tone: 'neutral' },
  contacted: { label: 'Contacté', tone: 'neutral' },
  qualified: { label: 'Qualifié', tone: 'brand' },
  proposal: { label: 'Proposition', tone: 'brand' },
  negotiation: { label: 'Négociation', tone: 'warning' },
  won: { label: 'Gagné', tone: 'success' },
  lost: { label: 'Perdu', tone: 'danger' },
}
export const SOURCES = [
  { value: 'website', label: 'Site web' }, { value: 'trade_show', label: 'Salon' }, { value: 'referral', label: 'Recommandation' },
  { value: 'cold_call', label: 'Prospection' }, { value: 'social', label: 'Réseaux sociaux' }, { value: 'other', label: 'Autre' },
] as const

export const QUOTE_STATUS: Record<QuoteStatus, { label: string; tone: 'neutral' | 'brand' | 'warning' | 'success' | 'danger' }> = {
  draft: { label: 'Brouillon', tone: 'neutral' }, sent: { label: 'Envoyé', tone: 'brand' }, accepted: { label: 'Accepté', tone: 'success' },
  rejected: { label: 'Refusé', tone: 'danger' }, converted: { label: 'Transformé en commande', tone: 'success' }, cancelled: { label: 'Annulé', tone: 'neutral' },
}
export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: 'neutral' | 'brand' | 'warning' | 'success' | 'danger' }> = {
  draft: { label: 'Brouillon', tone: 'neutral' }, issued: { label: 'Émise', tone: 'brand' }, partially_paid: { label: 'Partiellement payée', tone: 'warning' },
  paid: { label: 'Payée', tone: 'success' }, credited: { label: 'Créditée', tone: 'neutral' }, cancelled: { label: 'Annulée', tone: 'neutral' },
}
export const CREDIT_STATUS = { draft: { label: 'Brouillon', tone: 'neutral' }, issued: { label: 'Émis', tone: 'success' }, cancelled: { label: 'Annulé', tone: 'neutral' } } as const
export const PAY_METHODS = [
  { value: 'transfer', label: 'Virement' }, { value: 'cheque', label: 'Chèque' }, { value: 'lc', label: 'Lettre de crédit' },
  { value: 'cash', label: 'Espèces' }, { value: 'card', label: 'Carte' }, { value: 'other', label: 'Autre' },
] as const

export const money = (v: number, currency = 'EUR') => new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
export const fmtDay = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`)) : '—')

export const INVOICE_LINK = {
  none: { label: 'Non facturée', tone: 'neutral' },
  partial: { label: 'Facturée en partie', tone: 'warning' },
  full: { label: 'Facturée', tone: 'success' },
} as const

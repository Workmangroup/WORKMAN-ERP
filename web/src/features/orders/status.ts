export const ORDER_STATUS = {
  draft: { label: 'Brouillon', tone: 'warning' },
  confirmed: { label: 'Confirmée', tone: 'success' },
  delivered: { label: 'Livrée', tone: 'brand' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
} as const

export const fmtDay = (d: string | null) => (d ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`)) : '—')

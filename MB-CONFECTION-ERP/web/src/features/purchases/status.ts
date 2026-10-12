export const REQUEST_STATUS = {
  draft: { label: 'Brouillon', tone: 'neutral' },
  submitted: { label: 'À valider', tone: 'warning' },
  approved: { label: 'Validée', tone: 'success' },
  rejected: { label: 'Rejetée', tone: 'danger' },
  ordered: { label: 'Commandée', tone: 'brand' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
} as const

export const PO_STATUS = {
  draft: { label: 'Brouillon', tone: 'neutral' },
  sent: { label: 'Envoyée', tone: 'brand' },
  partial: { label: 'Partiellement reçue', tone: 'warning' },
  received: { label: 'Reçue', tone: 'success' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
} as const

export const fmtDay = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`)) : '—')

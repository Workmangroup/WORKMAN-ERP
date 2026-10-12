/** Statuts et libellés de la production (0019). */
export const ORDER_STATUS: Record<string, { label: string; tone: 'neutral' | 'brand' | 'success' | 'warning' | 'danger' }> = {
  planned: { label: 'Planifié', tone: 'neutral' },
  launched: { label: 'Lancé', tone: 'brand' },
  in_progress: { label: 'En cours', tone: 'brand' },
  suspended: { label: 'Suspendu', tone: 'warning' },
  done: { label: 'Terminé', tone: 'success' },
}

export const WORK_CENTER_KINDS = [
  { value: 'coupe', label: 'Coupe' }, { value: 'couture', label: 'Couture' }, { value: 'finition', label: 'Finition' },
  { value: 'repassage', label: 'Repassage' }, { value: 'controle', label: 'Contrôle' }, { value: 'other', label: 'Autre' },
] as const

export const orderStatusLabel = (s: string) => ORDER_STATUS[s]?.label ?? s
export const kindLabel = (k: string) => WORK_CENTER_KINDS.find((x) => x.value === k)?.label ?? k

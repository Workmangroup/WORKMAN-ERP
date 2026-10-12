/** Forme d'une réponse du copilote (texte, cartes, tableau, graphique, alertes, actions, liens). Pure. */

export interface CopilotCard { label: string; value: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
export interface CopilotTable { columns: string[]; rows: (string | number)[][] }
export interface CopilotChart { kind: 'bar' | 'line'; title: string; points: { label: string; value: number }[] }
export interface CopilotLink { label: string; href: string }

export interface CopilotAnswer {
  title: string
  text: string[]
  cards?: CopilotCard[]
  table?: CopilotTable
  chart?: CopilotChart
  alerts?: { severity: 'critical' | 'warning' | 'info'; text: string; href?: string }[]
  /** Actions recommandées : décisions concrètes, dérivées des données (ex. « commander 240 m de tissu HV »). */
  recommendations?: string[]
  /** Questions de suite proposées automatiquement. */
  followUps?: string[]
  links?: CopilotLink[]
  /** Données utilisées (traçabilité : aucune réponse n'est inventée hors de ces données). */
  sources: string[]
}

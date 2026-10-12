/** Constantes de la GED. À garder alignées avec 0005_ged.sql (statuts, dossiers système, limites). */

export const GED_BUCKET = 'ged'
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const TRASH_RETENTION_DAYS = 30
export const EXPIRY_WARNING_DAYS = 60

export const SYSTEM_FOLDERS = [
  { key: 'contracts', name: 'Contrats' },
  { key: 'orders', name: 'Commandes' },
  { key: 'invoices', name: 'Factures' },
  { key: 'bat', name: 'BAT' },
  { key: 'patterns', name: 'Patronages' },
  { key: 'certifications', name: 'Certifications' },
  { key: 'logos', name: 'Logos' },
  { key: 'correspondence', name: 'Correspondances' },
  { key: 'quality', name: 'Qualité' },
] as const

export const STATUS = {
  draft: { label: 'Brouillon', tone: 'neutral' },
  pending_review: { label: 'En validation', tone: 'warning' },
  validated: { label: 'Validé', tone: 'success' },
  rejected: { label: 'Rejeté', tone: 'danger' },
} as const
export type DocStatus = keyof typeof STATUS

export type FileKind = 'pdf' | 'image' | 'text' | 'office' | 'cad' | 'archive' | 'vector' | 'mail' | 'other'

interface FileType {
  mime: string
  kind: FileKind
  /** Prévisualisation intégrée possible (types sûrs uniquement : jamais HTML ni SVG). */
  inline: boolean
  /** Signature (magic bytes) attendue en début de fichier ; absente = pas de contrôle. */
  magic?: number[][]
}

const OLE = [[0xd0, 0xcf, 0x11, 0xe0]]
const ZIP = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06]]

/** Extensions autorisées (la liste est la source de vérité, pas le type MIME déclaré par le navigateur). */
export const FILE_TYPES: Record<string, FileType> = {
  pdf: { mime: 'application/pdf', kind: 'pdf', inline: true, magic: [[0x25, 0x50, 0x44, 0x46]] },
  png: { mime: 'image/png', kind: 'image', inline: true, magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg: { mime: 'image/jpeg', kind: 'image', inline: true, magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: 'image/jpeg', kind: 'image', inline: true, magic: [[0xff, 0xd8, 0xff]] },
  webp: { mime: 'image/webp', kind: 'image', inline: true, magic: [[0x52, 0x49, 0x46, 0x46]] },
  txt: { mime: 'text/plain', kind: 'text', inline: true },
  csv: { mime: 'text/csv', kind: 'text', inline: true },
  doc: { mime: 'application/msword', kind: 'office', inline: false, magic: OLE },
  xls: { mime: 'application/vnd.ms-excel', kind: 'office', inline: false, magic: OLE },
  ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'office', inline: false, magic: OLE },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'office', inline: false, magic: ZIP },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'office', inline: false, magic: ZIP },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'office', inline: false, magic: ZIP },
  zip: { mime: 'application/zip', kind: 'archive', inline: false, magic: ZIP },
  dxf: { mime: 'application/dxf', kind: 'cad', inline: false },
  plt: { mime: 'application/vnd.hp-hpgl', kind: 'cad', inline: false },
  dwg: { mime: 'application/acad', kind: 'cad', inline: false, magic: [[0x41, 0x43, 0x31]] },
  ai: { mime: 'application/postscript', kind: 'vector', inline: false },
  eps: { mime: 'application/postscript', kind: 'vector', inline: false },
  svg: { mime: 'image/svg+xml', kind: 'vector', inline: false },
  eml: { mime: 'message/rfc822', kind: 'mail', inline: false },
  msg: { mime: 'application/vnd.ms-outlook', kind: 'mail', inline: false, magic: OLE },
}

export const ACCEPT_ATTR = Object.keys(FILE_TYPES).map((e) => `.${e}`).join(',')

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name.trim())
  return m ? m[1].toLowerCase() : ''
}

export const fileTypeOf = (name: string): FileType | null => FILE_TYPES[extensionOf(name)] ?? null

/** Types servis en ligne (prévisualisation). Tout autre type est forcé en téléchargement. */
export const isInlineMime = (mime: string) => Object.values(FILE_TYPES).some((t) => t.inline && t.mime === mime)

export function kindOfMime(mime: string | null | undefined): FileKind {
  return Object.values(FILE_TYPES).find((t) => t.mime === mime)?.kind ?? 'other'
}

export function humanSize(n: number | string | null | undefined): string {
  const v = Number(n ?? 0)
  if (v < 1024) return `${v} o`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} Ko`
  return `${(v / 1024 / 1024).toFixed(1)} Mo`
}

export function matchesMagic(ext: string, bytes: Uint8Array): boolean {
  const t = FILE_TYPES[ext]
  if (!t) return false
  if (t.magic) return t.magic.some((sig) => sig.every((b, i) => bytes[i] === b))
  if (t.kind === 'text') return !bytes.slice(0, 32).includes(0) // pas de binaire déguisé en texte
  return true
}

/** Jours restants avant la date de validité (négatif = expiré). */
export function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null
  return Math.ceil((new Date(date + 'T23:59:59').getTime() - Date.now()) / 86_400_000)
}

/** Nom de fichier sûr pour le chemin de stockage. */
export const safeFileName = (name: string) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'fichier'

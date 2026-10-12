import { File, FileArchive, FileCode2, FileImage, FileSpreadsheet, FileText, Mail, PenTool } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EXPIRY_WARNING_DAYS, STATUS, daysUntil, kindOfMime, type DocStatus, type FileKind } from '@/lib/ged/constants'

export function StatusBadge({ status }: { status: DocStatus }) {
  const s = STATUS[status] ?? STATUS.draft
  return <Badge tone={s.tone}>{s.label}</Badge>
}

export function ExpiryBadge({ validUntil }: { validUntil: string | null }) {
  const days = daysUntil(validUntil)
  if (days === null) return null
  const date = new Date(validUntil + 'T12:00:00').toLocaleDateString('fr-FR')
  if (days < 0) return <Badge tone="danger">Expiré le {date}</Badge>
  if (days <= EXPIRY_WARNING_DAYS) return <Badge tone="warning">Expire dans {days} j</Badge>
  return <Badge>Valide jusqu’au {date}</Badge>
}

const ICONS: Record<FileKind, React.ElementType> = {
  pdf: FileText, image: FileImage, text: FileText, office: FileSpreadsheet, cad: PenTool,
  archive: FileArchive, vector: FileCode2, mail: Mail, other: File,
}
const COLORS: Record<FileKind, string> = {
  pdf: 'text-danger-text', image: 'text-success-text', text: 'text-ink-soft', office: 'text-brand-600', cad: 'text-[#8a6100]',
  archive: 'text-ink-soft', vector: 'text-[#8a2be2]', mail: 'text-brand-500', other: 'text-ink-faint',
}

export function FileIcon({ mime, className = 'h-5 w-5' }: { mime: string | null | undefined; className?: string }) {
  const kind = kindOfMime(mime)
  const Icon = ICONS[kind]
  return <Icon className={`${className} ${COLORS[kind]} shrink-0`} aria-hidden />
}

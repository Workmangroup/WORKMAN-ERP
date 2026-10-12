import { Download, Eye } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { isInlineMime, kindOfMime } from '@/lib/ged/constants'
import type { GedVersion } from '../types'
import { FileIcon } from './badges'

/** Prévisualisation intégrée (PDF, images, texte). Les fichiers sont servis par notre route (jamais par un lien public). */
export function DocumentPreview({ version }: { version: GedVersion }) {
  const src = `/ged/files/${version.id}?inline=1`
  const download = `/ged/files/${version.id}?download=1`
  const kind = kindOfMime(version.mime_type)

  if (isInlineMime(version.mime_type)) {
    if (kind === 'image') {
      return (
        <div className="flex max-h-[75vh] min-h-48 items-center justify-center overflow-auto rounded-md border border-line bg-[repeating-conic-gradient(#f3f2f1_0_25%,#fff_0_50%)] bg-[length:16px_16px] p-2">
          <img src={src} alt={`Aperçu de ${version.file_name}`} className="max-h-[72vh] max-w-full object-contain" />
        </div>
      )
    }
    return (
      <iframe
        src={kind === 'pdf' ? `${src}#view=FitH` : src}
        title={`Aperçu de ${version.file_name}`}
        className={`w-full rounded-md border border-line bg-white ${kind === 'pdf' ? 'h-[75vh]' : 'h-[50vh]'}`}
        referrerPolicy="no-referrer"
      />
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-line-strong bg-white px-6 py-12 text-center">
      <FileIcon mime={version.mime_type} className="h-12 w-12" />
      <p className="font-semibold">{version.file_name}</p>
      <p className="max-w-sm text-sm text-ink-soft">
        <Eye className="mr-1 inline h-4 w-4" aria-hidden />
        L’aperçu n’est pas disponible pour ce format. Téléchargez le fichier pour l’ouvrir dans l’application adaptée.
      </p>
      <a href={download} className={buttonVariants({})}><Download className="h-4 w-4" /> Télécharger</a>
    </div>
  )
}

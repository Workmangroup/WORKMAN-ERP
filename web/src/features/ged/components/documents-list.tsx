import Link from 'next/link'
import { RotateCcw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TRASH_RETENTION_DAYS, humanSize } from '@/lib/ged/constants'
import { formatDateTime } from '@/lib/utils'
import { restoreDocumentAction, trashDocumentAction } from '../actions'
import type { GedDocument } from '../types'
import { ExpiryBadge, FileIcon, StatusBadge } from './badges'
import { PurgeButton } from './document-forms'

/** Liste de documents : tableau (≥ md) et cartes (mobile). */
export function DocumentsList({
  docs,
  folderNames,
  users,
  clientNames,
  trash = false,
  canWrite,
  canDelete,
  showClient = false,
  empty,
}: {
  docs: GedDocument[]
  folderNames: Map<string, string>
  users: Map<string, { full_name: string }>
  clientNames?: Map<string, string>
  trash?: boolean
  canWrite: boolean
  canDelete: boolean
  showClient?: boolean
  empty: string
}) {
  const href = (d: GedDocument) => `/ged/${d.client_id}/${d.id}`
  const daysLeft = (d: GedDocument) =>
    d.deleted_at ? Math.max(0, TRASH_RETENTION_DAYS - Math.floor((Date.now() - new Date(d.deleted_at).getTime()) / 86_400_000)) : null

  const rowActions = (d: GedDocument) => (
    <div className="flex items-center justify-end gap-1">
      {trash ? (
        <>
          {canWrite && (
            <form action={restoreDocumentAction}>
              <input type="hidden" name="id" value={d.id} /><input type="hidden" name="client_id" value={d.client_id} />
              <Button size="sm" variant="secondary" type="submit"><RotateCcw className="h-4 w-4" /> Restaurer</Button>
            </form>
          )}
          {canDelete && <PurgeButton id={d.id} clientId={d.client_id} title={d.title} />}
        </>
      ) : (
        canWrite && (d.status !== 'validated' || canDelete) && (
          <form action={trashDocumentAction}>
            <input type="hidden" name="id" value={d.id} /><input type="hidden" name="client_id" value={d.client_id} />
            <Button size="sm" variant="ghost" type="submit" aria-label={`Mettre « ${d.title} » à la corbeille`}><Trash2 className="h-4 w-4 text-danger-text" /></Button>
          </form>
        )
      )}
    </div>
  )

  if (docs.length === 0) {
    return <div className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center text-sm text-ink-soft">{empty}</div>
  }

  return (
    <>
      {/* Cartes (mobile) */}
      <ul className="grid gap-3 md:hidden">
        {docs.map((d) => (
          <li key={d.id} className="rounded-md border border-line bg-white p-4 shadow-card">
            <Link href={href(d)} className="flex items-start gap-3">
              <FileIcon mime={d.mime_type} className="mt-0.5 h-6 w-6" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-brand-700">{d.title}</p>
                <p className="truncate text-xs text-ink-soft">{d.file_name}</p>
              </div>
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={d.status} /><Badge>v{d.version_count}</Badge><ExpiryBadge validUntil={d.valid_until} />
              {d.deleted_at && <Badge tone="warning">Suppression dans {daysLeft(d)} j</Badge>}
            </div>
            <p className="mt-2 text-xs text-ink-faint">{humanSize(d.size_bytes)} · {formatDateTime(d.updated_at)}</p>
            <div className="mt-2">{rowActions(d)}</div>
          </li>
        ))}
      </ul>

      {/* Tableau (≥ md) */}
      <div className="hidden overflow-x-auto rounded-md border border-line bg-white shadow-card md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-canvas text-xs uppercase text-ink-soft">
            <tr>
              <th className="px-4 py-2 font-semibold">Document</th>
              {showClient && <th className="px-3 py-2 font-semibold">Client</th>}
              <th className="px-3 py-2 font-semibold">Dossier</th>
              <th className="px-3 py-2 font-semibold">Statut</th>
              <th className="px-3 py-2 font-semibold">Version</th>
              <th className="px-3 py-2 font-semibold">Taille</th>
              <th className="px-3 py-2 font-semibold">{trash ? 'Supprimé' : 'Modifié'}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-t border-line align-top hover:bg-canvas/60">
                <td className="px-4 py-3">
                  <Link href={href(d)} className="flex items-start gap-3">
                    <FileIcon mime={d.mime_type} className="mt-0.5 h-5 w-5" />
                    <span className="min-w-0">
                      <span className="block font-semibold text-brand-700 hover:underline">{d.title}</span>
                      <span className="block max-w-sm truncate text-xs text-ink-soft">{d.file_name}</span>
                      {d.tags.length > 0 && <span className="mt-1 flex flex-wrap gap-1">{d.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span>}
                    </span>
                  </Link>
                </td>
                {showClient && <td className="px-3 py-3">{clientNames?.get(d.client_id) ?? '—'}</td>}
                <td className="px-3 py-3 text-ink-soft">{folderNames.get(d.folder_id) ?? '—'}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-col items-start gap-1"><StatusBadge status={d.status} /><ExpiryBadge validUntil={d.valid_until} /></div>
                </td>
                <td className="px-3 py-3"><Badge>v{d.version_count}</Badge></td>
                <td className="whitespace-nowrap px-3 py-3 text-ink-soft">{humanSize(d.size_bytes)}</td>
                <td className="px-3 py-3 text-xs text-ink-soft">
                  {formatDateTime(trash ? d.deleted_at : d.updated_at)}
                  <div>{users.get((trash ? d.deleted_by : d.updated_by) ?? '')?.full_name ?? ''}</div>
                  {trash && <div className="text-warn-text">Suppression définitive dans {daysLeft(d)} j</div>}
                </td>
                <td className="px-4 py-3">{rowActions(d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

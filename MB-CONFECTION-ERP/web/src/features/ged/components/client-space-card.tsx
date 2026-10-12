import Link from 'next/link'
import { AlertTriangle, ClipboardCheck, Folder, FolderOpen } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { humanSize } from '@/lib/ged/constants'
import type { ClientStats, GedFolder } from '../types'

/** Résumé de l'espace documentaire d'un client (affiché dans sa fiche). */
export function ClientSpaceCard({
  clientId,
  folders,
  counts,
  stats,
}: {
  clientId: string
  folders: GedFolder[]
  counts: Map<string, number>
  stats?: ClientStats
}) {
  const roots = folders.filter((f) => !f.parent_id).sort((a, b) => a.sort_order - b.sort_order)
  const sum = (id: string): number => (counts.get(id) ?? 0) + folders.filter((f) => f.parent_id === id).reduce((n, c) => n + sum(c.id), 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FolderOpen className="h-5 w-5 text-brand-500" /> Espace documentaire</CardTitle>
        <Link href={`/ged/${clientId}`} className={buttonVariants({ size: 'sm' })}>Ouvrir la GED</Link>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-ink-soft">
          {stats?.documents ?? 0} document(s) · {humanSize(stats?.size_bytes ?? 0)}. Les documents du client (contrats, commandes, factures, BAT, patronages…) sont gérés dans la GED :
          versions, validation, commentaires et historique.
        </p>
        {((stats?.pending ?? 0) > 0 || (stats?.expiring ?? 0) > 0) && (
          <div className="flex flex-wrap gap-2">
            {(stats?.pending ?? 0) > 0 && <Badge tone="warning"><ClipboardCheck className="mr-1 h-3 w-3" />{stats!.pending} à valider</Badge>}
            {(stats?.expiring ?? 0) > 0 && <Badge tone="danger"><AlertTriangle className="mr-1 h-3 w-3" />{stats!.expiring} expirés / bientôt expirés</Badge>}
          </div>
        )}
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {roots.map((f) => (
            <li key={f.id}>
              <Link href={`/ged/${clientId}?folder=${f.id}`} className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2.5 text-sm hover:border-brand-400 hover:bg-brand-50/40">
                <Folder className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                <span className="text-xs text-ink-soft">{sum(f.id)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

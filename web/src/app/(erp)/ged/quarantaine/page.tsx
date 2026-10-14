import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'
import { formatDateTime } from '@/lib/utils'

export const metadata: Metadata = { title: 'Fichiers en quarantaine' }

const LABEL: Record<string, { label: string; tone: 'warning' | 'danger' | 'neutral' }> = {
  pending: { label: 'En attente d’analyse', tone: 'warning' },
  infected: { label: 'Menace détectée', tone: 'danger' },
  error: { label: 'Analyse en erreur', tone: 'danger' },
}

/** Versions non publiées : aucun téléchargement ni lien n'est possible tant que l'analyse n'a pas conclu « sans menace ». */
export default async function QuarantinePage() {
  await requirePermission(P.DOCUMENTS_READ)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('ged_quarantine_list')
  const rows = (data ?? []) as { version_id: string; title: string; version_no: number; file_name: string; scan_status: string; scan_details: string | null; created_at: string }[]
  return (
    <>
      <PageHeader title="Fichiers en quarantaine" description="Versions qui ne sont pas publiées : en attente d’analyse, menace détectée ou analyse en erreur." />
      <div className="space-y-4 p-4 sm:p-6">
        <Alert tone="info">Un fichier n’est publié qu’après une analyse antivirus sans menace. Les fichiers ci-dessous ne peuvent être ni téléchargés ni partagés.</Alert>
        {error && <Alert tone="error">La liste n’est pas disponible pour le moment. Réessayez dans quelques instants.</Alert>}
        {!error && rows.length === 0 && <p className="text-sm text-ink-soft">Aucun fichier en quarantaine.</p>}
        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-line bg-canvas text-left text-xs text-ink-soft">
                <tr><th className="px-3 py-2">Document</th><th className="px-3 py-2">Version</th><th className="px-3 py-2">Fichier</th><th className="px-3 py-2">État</th><th className="px-3 py-2">Détail</th><th className="px-3 py-2">Déposé le</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.version_id} className="align-top">
                    <td className="px-3 py-2">{r.title}</td>
                    <td className="px-3 py-2">v{r.version_no}</td>
                    <td className="px-3 py-2 break-all">{r.file_name}</td>
                    <td className="px-3 py-2"><Badge tone={LABEL[r.scan_status]?.tone ?? 'neutral'}>{LABEL[r.scan_status]?.label ?? r.scan_status}</Badge></td>
                    <td className="px-3 py-2 text-xs text-ink-soft">{r.scan_details ?? '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

import type { Metadata } from 'next'
import { PageHeader } from '@/components/layout/page-header'
import { Card } from '@/components/ui/card'
import { requirePermission } from '@/features/auth/guards'
import { getAuthContext } from '@/features/auth/services/access.service'
import { ImportPanel } from '@/features/imports/components/import-panel'
import { integrityReport, listImportBatches } from '@/features/imports/services/imports.service'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Imports et référentiels' }

const STATUS: Record<string, string> = { staged: 'Préparé', simulated: 'Simulé', committed: 'Validé' }
const KIND: Record<string, string> = {
  sites: 'Sites',
  warehouse_locations: 'Emplacements',
  cost_centers: 'Centres analytiques',
  calendars: 'Calendriers',
}

export default async function ImportsPage() {
  await requirePermission(P.IMPORTS_READ)
  const ctx = await getAuthContext()
  const perms = ctx?.permissions ?? []
  const canWrite = perms.includes(P.IMPORTS_WRITE)
  const canCommit = perms.includes(P.IMPORTS_COMMIT)
  const canIntegrity = perms.includes(P.REFERENTIALS_READ)

  const [batches, integrity] = await Promise.all([listImportBatches(), canIntegrity ? integrityReport() : Promise.resolve(null)])

  return (
    <>
      <PageHeader
        title="Imports et référentiels"
        description="Simulation avant écriture, rejets expliqués, reprise sans doublon. Aucune donnée n’est modifiée avant validation par une autre personne."
      />

      {canWrite && (
        <section className="mb-6 space-y-3">
          <h2 className="text-base font-semibold text-ink">Nouvel import</h2>
          <ImportPanel canCommit={canCommit} />
        </section>
      )}

      <section className="mb-6 space-y-3">
        <h2 className="text-base font-semibold text-ink">Lots récents</h2>
        <Card className="overflow-x-auto">
          {batches.length === 0 ? (
            <p className="p-4 text-sm text-ink-soft">Aucun lot d’import pour l’instant.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-ink-soft">
                <tr>
                  <th className="p-3">Date</th><th className="p-3">Type</th><th className="p-3">Fichier</th><th className="p-3">Statut</th>
                  <th className="p-3">Lignes</th><th className="p-3">À créer</th><th className="p-3">Déjà présents</th><th className="p-3">Rejets</th><th className="p-3">Créés</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} className="border-t border-line">
                    <td className="p-3">{new Date(b.created_at).toLocaleString('fr-FR')}</td>
                    <td className="p-3">{KIND[b.kind] ?? b.kind}</td>
                    <td className="p-3">{b.file_name}</td>
                    <td className="p-3">{STATUS[b.status] ?? b.status}</td>
                    <td className="p-3">{b.total_rows}</td>
                    <td className="p-3">{b.to_create}</td>
                    <td className="p-3">{b.already_exist}</td>
                    <td className="p-3">{b.rejected_rows}</td>
                    <td className="p-3">{b.created_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>

      {canIntegrity && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-ink">Doublons et orphelins des référentiels</h2>
          <p className="text-sm text-ink-soft">Constat seulement : rien n’est corrigé ni supprimé automatiquement.</p>
          <Card className="overflow-x-auto">
            {!integrity || !integrity.ok ? (
              <p className="p-4 text-sm text-danger">Rapport indisponible.</p>
            ) : integrity.rows.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">Aucun doublon ni orphelin détecté.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-ink-soft">
                  <tr><th className="p-3">Référentiel</th><th className="p-3">Code</th><th className="p-3">Constat</th><th className="p-3">Détail</th></tr>
                </thead>
                <tbody>
                  {integrity.rows.map((r, i) => (
                    <tr key={`${r.ref_kind}-${r.ref_code}-${r.issue}-${i}`} className="border-t border-line">
                      <td className="p-3">{KIND[r.ref_kind] ?? r.ref_kind}</td>
                      <td className="p-3 font-mono">{r.ref_code}</td>
                      <td className="p-3">{r.issue}</td>
                      <td className="p-3">{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </section>
      )}
    </>
  )
}

'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { importKey, parseCsv, rejectsToCsv, sha256Hex, type CsvRow } from '@/lib/imports/csv'
import { commitImportAction, prepareImportAction, rejectsAction, simulateImportAction } from '../actions'

const KINDS = [
  { value: 'sites', label: 'Sites' },
  { value: 'warehouse_locations', label: 'Emplacements d’entrepôt' },
  { value: 'cost_centers', label: 'Centres analytiques' },
  { value: 'calendars', label: 'Calendriers de travail' },
] as const

type Summary = { to_create: number; already_exist: number; rejected: number }
type Reject = { line_no: number; raw: Record<string, string>; errors: { code: string; field?: string }[] }

/** Import simulable : charger, simuler (sans écriture), voir les rejets, exporter les rejets, puis valider (autre personne). */
export function ImportPanel({ canCommit }: { canCommit: boolean }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('sites')
  const [file, setFile] = useState<{ name: string; sha: string; rows: CsvRow[] } | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [rejects, setRejects] = useState<Reject[]>([])
  const [committed, setCommitted] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onFile(f: File | undefined) {
    setMessage(null); setBatchId(null); setSummary(null); setRejects([]); setCommitted(null)
    if (!f) { setFile(null); return }
    try {
      const text = await f.text()
      const parsed = parseCsv(text)
      const sha = await sha256Hex(await f.arrayBuffer())
      setFile({ name: f.name, sha, rows: parsed.rows })
    } catch (e) {
      setFile(null)
      setMessage(e instanceof Error ? e.message : 'Fichier illisible.')
    }
  }

  async function prepareAndSimulate() {
    if (!file) return
    setBusy(true); setMessage(null); setCommitted(null)
    const prep = await prepareImportAction({ kind, fileName: file.name, sha256: file.sha, key: importKey(kind, file.sha), rows: file.rows })
    if (!prep.ok) { setBusy(false); setMessage(prep.message); return }
    setBatchId(prep.data.batchId)
    const sim = await simulateImportAction(prep.data.batchId)
    if (!sim.ok) { setBusy(false); setMessage(sim.message); return }
    setSummary(sim.data as Summary)
    const rej = await rejectsAction(prep.data.batchId)
    if (rej.ok) setRejects(rej.data)
    setMessage(prep.data.resumed ? 'Lot déjà préparé : reprise sans doublon.' : null)
    setBusy(false)
  }

  async function commit() {
    if (!batchId) return
    setBusy(true); setMessage(null)
    const res = await commitImportAction(batchId)
    setBusy(false)
    if (!res.ok) { setMessage(res.message); return }
    setCommitted(Number((res.data as { created?: number }).created ?? 0))
  }

  async function exportRejects() {
    if (!batchId) return
    const res = await rejectsAction(batchId)
    if (!res.ok) { setMessage(res.message); return }
    const blob = new Blob([rejectsToCsv(res.data)], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `rejets-${kind}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="font-medium">Type de référentiel</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} disabled={busy}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </Select>
        </label>
        <label className="space-y-1 text-sm sm:col-span-2">
          <span className="font-medium">Fichier CSV (en-tête obligatoire)</span>
          <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} className="block w-full text-sm" />
        </label>
      </div>

      {file && (
        <p className="text-sm text-ink-soft">
          {file.name} : {file.rows.length} ligne(s) lue(s). Empreinte {file.sha.slice(0, 12)}… (la même empreinte reprend le même lot).
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={prepareAndSimulate} disabled={!file || busy}>Préparer et simuler</Button>
        {batchId && canCommit && !committed && (
          <Button type="button" variant="secondary" onClick={commit} disabled={busy || !summary || summary.to_create === 0}>
            Valider le lot (autre personne que le chargeur)
          </Button>
        )}
        {batchId && rejects.length > 0 && (
          <Button type="button" variant="secondary" onClick={exportRejects} disabled={busy}>Exporter les rejets (CSV)</Button>
        )}
      </div>

      {message && <p role="status" className="text-sm text-danger">{message}</p>}

      {summary && (
        <div className="grid gap-2 text-sm sm:grid-cols-3" aria-live="polite">
          <p><strong>{summary.to_create}</strong> à créer</p>
          <p><strong>{summary.already_exist}</strong> déjà présent(s), non recréé(s)</p>
          <p><strong>{summary.rejected}</strong> rejet(s)</p>
        </div>
      )}

      {committed !== null && <p className="text-sm">Lot validé : {committed} élément(s) créé(s).</p>}

      {rejects.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr><th className="p-2">Ligne</th><th className="p-2">Motifs</th><th className="p-2">Données</th></tr></thead>
            <tbody>
              {rejects.map((r) => (
                <tr key={r.line_no} className="border-t">
                  <td className="p-2">{r.line_no}</td>
                  <td className="p-2">{r.errors.map((e) => (e.field ? `${e.code} (${e.field})` : e.code)).join(', ')}</td>
                  <td className="p-2 font-mono text-xs">{Object.values(r.raw).join(' ; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

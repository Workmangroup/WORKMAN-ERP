import { Badge } from '@/components/ui/badge'
import { ACTION_LABELS, AUTH_EVENT_LABELS, ENTITY_LABELS } from '@/lib/rbac/audit-labels'
import { describeUserAgent } from '@/lib/ua'
import { formatDateTime } from '@/lib/utils'
import type { AuditRow, AuthEventFull } from '../types'

const isArr = (v: unknown): v is unknown[] => Array.isArray(v)
const text = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v))

function Chips({ items, tone }: { items: unknown[]; tone: 'success' | 'danger' | 'neutral' }) {
  if (items.length === 0) return <span className="text-ink-faint">—</span>
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.map((i) => (
        <Badge key={String(i)} tone={tone}>{String(i)}</Badge>
      ))}
    </span>
  )
}

/** Détails d'une entrée : listes ajouté/retiré, changements de champs avant → après, métadonnées. */
function AuditDetails({ row }: { row: AuditRow }) {
  const meta = row.metadata ?? {}
  const before = row.before_data ?? {}
  const after = row.after_data ?? {}
  const added = isArr(meta.added) ? meta.added : null
  const removed = isArr(meta.removed) ? meta.removed : null
  const skipKeys = new Set(['updated_at', 'created_at'])
  if (added || removed) ['permissions', 'roles'].forEach((k) => skipKeys.add(k))

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !skipKeys.has(k))
  const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
  const metaRest = Object.entries(meta).filter(([k]) => k !== 'added' && k !== 'removed')

  const hasContent = added || removed || changed.length > 0 || metaRest.length > 0
  if (!hasContent) return <span className="text-ink-faint">—</span>

  return (
    <details className="group">
      <summary className="cursor-pointer text-xs text-brand-600 hover:underline">Voir le détail</summary>
      <dl className="mt-2 space-y-1.5 text-xs">
        {added && <div className="flex gap-2"><dt className="w-16 shrink-0 text-ink-soft">Ajouté</dt><dd><Chips items={added} tone="success" /></dd></div>}
        {removed && <div className="flex gap-2"><dt className="w-16 shrink-0 text-ink-soft">Retiré</dt><dd><Chips items={removed} tone="danger" /></dd></div>}
        {changed.map((k) => (
          <div key={k} className="flex gap-2">
            <dt className="w-16 shrink-0 break-words text-ink-soft">{k}</dt>
            <dd className="min-w-0 break-words">
              <span className="text-danger-text line-through">{text(before[k])}</span> → <span className="text-success-text">{text(after[k])}</span>
            </dd>
          </div>
        ))}
        {metaRest.map(([k, v]) => (
          <div key={k} className="flex gap-2"><dt className="w-16 shrink-0 text-ink-soft">{k}</dt><dd className="break-words">{text(v)}</dd></div>
        ))}
      </dl>
    </details>
  )
}

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-canvas text-xs uppercase text-ink-soft">
          <tr>
            <th className="px-4 py-2 font-semibold">Date</th>
            <th className="px-3 py-2 font-semibold">Acteur</th>
            <th className="px-3 py-2 font-semibold">Action</th>
            <th className="px-3 py-2 font-semibold">Cible</th>
            <th className="px-3 py-2 font-semibold">Détails</th>
            <th className="px-4 py-2 font-semibold">Origine</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line align-top">
              <td className="whitespace-nowrap px-4 py-3 text-ink-soft">{formatDateTime(r.created_at)}</td>
              <td className="px-3 py-3">{r.actor_email ?? <span className="text-ink-faint">Système</span>}</td>
              <td className="px-3 py-3">
                <div className="font-medium">{ACTION_LABELS[r.action] ?? r.action}</div>
                <div className="font-mono text-xs text-ink-faint">{r.action}</div>
              </td>
              <td className="px-3 py-3">
                <div>{r.entity_label ?? '—'}</div>
                <div className="text-xs text-ink-faint">{ENTITY_LABELS[r.entity_type] ?? r.entity_type}</div>
              </td>
              <td className="px-3 py-3"><AuditDetails row={r} /></td>
              <td className="px-4 py-3 text-xs text-ink-soft">
                <Badge tone={r.action === 'access.denied' ? 'danger' : 'neutral'}>{r.source}</Badge>
                <div className="mt-1">{r.ip ?? ''}</div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-ink-soft">Aucune entrée pour ces critères.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export function AuthEventsTable({ rows }: { rows: AuthEventFull[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-canvas text-xs uppercase text-ink-soft">
          <tr>
            <th className="px-4 py-2 font-semibold">Date</th>
            <th className="px-3 py-2 font-semibold">E-mail</th>
            <th className="px-3 py-2 font-semibold">Événement</th>
            <th className="px-3 py-2 font-semibold">Résultat</th>
            <th className="px-3 py-2 font-semibold">Appareil</th>
            <th className="px-4 py-2 font-semibold">IP</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <td className="whitespace-nowrap px-4 py-2.5 text-ink-soft">{formatDateTime(r.created_at)}</td>
              <td className="px-3 py-2.5">{r.email ?? '—'}</td>
              <td className="px-3 py-2.5">{AUTH_EVENT_LABELS[r.event_type] ?? r.event_type}</td>
              <td className="px-3 py-2.5"><Badge tone={r.success ? 'success' : 'danger'}>{r.success ? 'OK' : 'Échec'}</Badge></td>
              <td className="px-3 py-2.5 text-ink-soft">{describeUserAgent(r.user_agent)}</td>
              <td className="px-4 py-2.5 text-ink-soft">{r.ip ?? ''}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-ink-soft">Aucun événement pour ces critères.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

'use client'

import { useState } from 'react'

/** Graphiques SVG sans dépendance : survol pour le détail, clic pour sélectionner (interactifs). */

const W = 640
const H = 220
const PAD = { t: 16, r: 12, b: 28, l: 56 }

const fmt = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 0 })

export function BarChart({ data, label, onSelect, selected }: {
  data: { key: string; label: string; value: number }[]
  label: string
  onSelect?: (key: string) => void
  selected?: string | null
}) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...data.map((d) => d.value))
  const bw = (W - PAD.l - PAD.r) / Math.max(1, data.length)
  const plotH = H - PAD.t - PAD.b
  return (
    <figure className="relative">
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH * (1 - f)} y2={PAD.t + plotH * (1 - f)} className="stroke-line" />
            <text x={PAD.l - 6} y={PAD.t + plotH * (1 - f) + 4} textAnchor="end" className="fill-ink-soft text-[10px]">{fmt(max * f)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const h = (d.value / max) * plotH
          const x = PAD.l + i * bw + bw * 0.15
          const isSel = selected === d.key
          return (
            <g key={d.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(d.key)} className="cursor-pointer">
              <rect x={x} y={PAD.t + plotH - h} width={bw * 0.7} height={Math.max(h, 0)} rx={3}
                className={isSel ? 'fill-brand-700' : hover === i ? 'fill-brand-500' : 'fill-brand-300'} />
              <text x={x + bw * 0.35} y={H - 8} textAnchor="middle" className="fill-ink-soft text-[10px]">{d.label}</text>
            </g>
          )
        })}
      </svg>
      {hover !== null && data[hover] && (
        <figcaption className="pointer-events-none absolute right-2 top-2 rounded-md border border-line bg-white px-2 py-1 text-xs shadow-card">
          <span className="font-semibold">{data[hover].label}</span> : {fmt(data[hover].value)}
        </figcaption>
      )}
    </figure>
  )
}

export function LineChart({ points, label, zeroLine = true }: { points: { label: string; value: number }[]; label: string; zeroLine?: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length === 0) return <p className="text-sm text-ink-soft">Aucune donnée.</p>
  const vals = points.map((p) => p.value)
  const min = Math.min(0, ...vals)
  const max = Math.max(1, ...vals)
  const plotH = H - PAD.t - PAD.b
  const plotW = W - PAD.l - PAD.r
  const x = (i: number) => PAD.l + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1))
  const y = (v: number) => PAD.t + plotH - ((v - min) / (max - min || 1)) * plotH
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  return (
    <figure className="relative">
      <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" onMouseLeave={() => setHover(null)}>
        {zeroLine && min < 0 && <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} className="stroke-danger" strokeDasharray="4 4" />}
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + plotH} className="stroke-line" />
        <text x={PAD.l - 6} y={y(max) + 4} textAnchor="end" className="fill-ink-soft text-[10px]">{fmt(max)}</text>
        <text x={PAD.l - 6} y={y(min) + 4} textAnchor="end" className="fill-ink-soft text-[10px]">{fmt(min)}</text>
        <path d={path} fill="none" className="stroke-brand-600" strokeWidth={2} />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 3} className={p.value < 0 ? 'fill-danger' : 'fill-brand-600'}
              onMouseEnter={() => setHover(i)} />
            {(i % Math.ceil(points.length / 7) === 0 || i === points.length - 1) && (
              <text x={x(i)} y={H - 8} textAnchor="middle" className="fill-ink-soft text-[10px]">{p.label}</text>
            )}
          </g>
        ))}
      </svg>
      {hover !== null && points[hover] && (
        <figcaption className="pointer-events-none absolute right-2 top-2 rounded-md border border-line bg-white px-2 py-1 text-xs shadow-card">
          <span className="font-semibold">{points[hover].label}</span> : {fmt(points[hover].value)}
        </figcaption>
      )}
    </figure>
  )
}

export function HBars({ items, label, unit = '' }: { items: { label: string; value: number; tone?: 'brand' | 'danger' | 'warn' }[]; label: string; unit?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  if (items.length === 0) return <p className="text-sm text-ink-soft">Aucune donnée.</p>
  return (
    <ul aria-label={label} className="space-y-2">
      {items.map((i) => (
        <li key={i.label} className="text-sm">
          <div className="flex justify-between gap-3"><span className="truncate">{i.label}</span><span className="tabular-nums font-semibold">{fmt(i.value)} {unit}</span></div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-canvas">
            <div className={`h-full rounded-full ${i.tone === 'danger' ? 'bg-danger' : i.tone === 'warn' ? 'bg-warn' : 'bg-brand-500'}`} style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function Gauge({ value, label, suffix = '%' }: { value: number | null; label: string; suffix?: string }) {
  const v = value === null ? 0 : Math.max(0, Math.min(100, value))
  const r = 44
  const c = 2 * Math.PI * r
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 120 120" className="h-28 w-28" role="img" aria-label={label}>
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="12" className="stroke-canvas" />
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="12" className="stroke-brand-600" strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 60 60)" />
        <text x="60" y="66" textAnchor="middle" className="fill-ink text-[18px] font-semibold">{value === null ? '—' : `${fmt(value)}${suffix}`}</text>
      </svg>
      <p className="text-xs text-ink-soft">{label}</p>
    </div>
  )
}

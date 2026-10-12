'use client'

import { useActionState, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { AlertTriangle, Barcode, Check, Download, Layers, PackagePlus, Plus, RotateCcw, Save, Sparkles, Trash2, X } from 'lucide-react'
import { ActionDialog } from '@/components/common/action-dialog'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { SubmitButton } from '@/components/auth/submit-button'
import type { FormState } from '@/features/auth/types'
import { formatMoney } from '@/lib/bom/options'
import { MOVE_TYPES, VIEW_MODES, formatPrice, gtinValid, stockLevel, type CatalogColor, type CatalogSize, type MatrixData, type VariantRow, type ViewMode } from '@/lib/variants/options'
import { cn } from '@/lib/utils'
import {
  assignBarcodesAction, createVariantBomAction, deleteVariantAction, generateVariantsAction, reserveStockAction, safetyStockAction, saveMatrixAction, stockMoveAction, syncFromSpecAction,
} from '../actions'
import { Ean13 } from './ean13'

interface Edit { price?: string; barcode?: string; active?: boolean; bom_id?: string | null }
const LEVEL = {
  ok: 'border-success/40 bg-success/10 text-ink', low: 'border-warn/60 bg-warn/15 text-ink', out: 'border-danger/50 bg-danger/10 text-ink', off: 'border-line bg-canvas text-ink-faint',
} as const

function Message({ state }: { state: FormState }) {
  if (!state?.message) return null
  return <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>
}

/** Matrice taille × couleur : stock, prix, codes-barres et nomenclature par variante, avec édition en ligne et enregistrement groupé. */
export function VariantMatrix({ data, colors, sizes, bomOptions, costs, canWrite, canStock, canBomWrite }: {
  data: MatrixData
  colors: CatalogColor[]
  sizes: CatalogSize[]
  bomOptions: { id: string; code: string; name: string }[]
  costs: Record<string, number>
  canWrite: boolean
  canStock: boolean
  canBomWrite: boolean
}) {
  const archived = data.product.status === 'archived'
  const editable = canWrite && !archived
  const [mode, setMode] = useState<ViewMode>('stock')
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [sel, setSel] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState<FormState>(null)
  const [saving, startSave] = useTransition()
  const [base, setBase] = useState('')
  const [surcharge, setSurcharge] = useState<Record<string, string>>({})
  const [gen, genAction] = useActionState(generateVariantsAction, null)
  const [sync, syncAction] = useActionState(syncFromSpecAction, null)
  const [bars, barsAction] = useActionState(assignBarcodesAction, null)

  const colorById = useMemo(() => new Map(colors.map((c) => [c.id, c])), [colors])
  const sizeById = useMemo(() => new Map(sizes.map((s) => [s.id, s])), [sizes])
  const usedColors = useMemo(() => [...new Set(data.variants.map((v) => v.color_id))].map((id) => colorById.get(id)).filter(Boolean).sort((a, b) => a!.name.localeCompare(b!.name)) as CatalogColor[], [data.variants, colorById])
  const usedSizes = useMemo(() => [...new Set(data.variants.map((v) => v.size_id))].map((id) => sizeById.get(id)).filter(Boolean).sort((a, b) => a!.sort_order - b!.sort_order || a!.code.localeCompare(b!.code)) as CatalogSize[], [data.variants, sizeById])
  const cell = useMemo(() => new Map(data.variants.map((v) => [`${v.color_id}|${v.size_id}`, v])), [data.variants])
  const byId = useMemo(() => new Map(data.variants.map((v) => [v.id, v])), [data.variants])
  const whName = new Map(data.warehouses.map((w) => [w.id, w.name]))

  const eff = (v: VariantRow) => {
    const e = edits[v.id] ?? {}
    return {
      price: e.price !== undefined ? e.price : v.price === null ? '' : String(v.price),
      barcode: e.barcode !== undefined ? e.barcode : v.barcode ?? '',
      active: e.active !== undefined ? e.active : v.active,
      bom_id: e.bom_id !== undefined ? e.bom_id : v.bom_id,
    }
  }
  const patch = (id: string, p: Edit) => setEdits((s) => ({ ...s, [id]: { ...s[id], ...p } }))
  const total = data.variants.reduce((a, v) => a + v.on_hand, 0)
  const reserved = data.variants.reduce((a, v) => a + v.reserved, 0)
  const activeN = data.variants.filter((v) => v.active).length
  const noBarcode = data.variants.filter((v) => v.active && !v.barcode).length
  const noPrice = data.variants.filter((v) => v.active && v.price === null).length
  const lowN = data.variants.filter((v) => v.active && v.low).length
  const outN = data.variants.filter((v) => v.active && v.on_hand === 0).length

  const applyPrices = () => {
    const b = Number(base.replace(',', '.'))
    if (!Number.isFinite(b) || b < 0) return
    const next: Record<string, Edit> = { ...edits }
    for (const v of data.variants) {
      if (!v.active) continue
      const sc = Number((surcharge[v.size_id] ?? '0').replace(',', '.'))
      next[v.id] = { ...next[v.id], price: String(Math.round((b + (Number.isFinite(sc) ? sc : 0)) * 100) / 100) }
    }
    setEdits(next)
  }
  const buildChanges = () => Object.entries(edits).flatMap(([id, e]) => {
    const v = byId.get(id)
    if (!v) return []
    const c: { id: string; price?: number | null; barcode?: string | null; active?: boolean; bom_id?: string | null } = { id }
    if (e.price !== undefined) { const p = e.price.trim() === '' ? null : Number(e.price.replace(',', '.')); if (p !== v.price) c.price = p }
    if (e.barcode !== undefined) { const b = e.barcode.trim() === '' ? null : e.barcode.trim(); if (b !== v.barcode) c.barcode = b }
    if (e.active !== undefined && e.active !== v.active) c.active = e.active
    if (e.bom_id !== undefined && e.bom_id !== v.bom_id) c.bom_id = e.bom_id
    return Object.keys(c).length > 1 ? [c] : []
  })
  const dirty = buildChanges().length
  const save = () => {
    const changes = buildChanges()
    if (changes.length === 0) { setEdits({}); setSaveMsg({ ok: true, message: 'Aucune modification à enregistrer.' }); return }
    if (changes.some((c) => c.price !== undefined && c.price !== null && !Number.isFinite(c.price))) { setSaveMsg({ ok: false, message: 'Un prix n’est pas un nombre valide.' }); return }
    startSave(async () => {
      const r = await saveMatrixAction(data.product.id, changes)
      setSaveMsg(r)
      if (r?.ok) setEdits({})
    })
  }

  const selected = sel ? byId.get(sel) ?? null : null

  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label="Indicateurs des variantes">
        {[
          { l: 'Variantes actives', v: `${activeN} / ${data.variants.length}`, t: '' },
          { l: 'Stock total', v: total, t: '' },
          { l: 'Disponible', v: total - reserved, t: '' },
          { l: 'En rupture', v: outN, t: outN ? 'text-danger-text' : '' },
          { l: 'Stock bas', v: lowN, t: lowN ? 'text-warn-text' : '' },
          { l: 'Sans code-barres / prix', v: `${noBarcode} / ${noPrice}`, t: noBarcode || noPrice ? 'text-warn-text' : '' },
        ].map((k) => <li key={k.l} className="rounded-md border border-line bg-white p-3 shadow-card"><p className="text-xs text-ink-soft">{k.l}</p><p className={cn('mt-1 text-xl font-semibold tabular-nums', k.t)}>{k.v}</p></li>)}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Affichage de la matrice" className="inline-flex rounded-md border border-line bg-white p-0.5 shadow-card">
          {VIEW_MODES.map((m) => (
            <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}
              className={cn('rounded-sm px-3 py-1.5 text-sm', mode === m.id ? 'bg-brand-500 font-semibold text-white' : 'text-ink-soft hover:bg-canvas')}>{m.label}</button>
          ))}
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <ActionDialog trigger={<><Layers className="h-4 w-4" /> Générer des variantes</>} triggerVariant="primary" title="Générer la matrice couleurs × tailles" action={generateVariantsAction} hidden={{ product_id: data.product.id }} submit="Générer" wide
              description="Seules les combinaisons manquantes sont créées ; les variantes existantes ne sont pas touchées.">
              {() => (
                <div className="grid gap-4 sm:grid-cols-2">
                  <fieldset><legend className="mb-1 text-sm font-semibold">Couleurs</legend>
                    <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-line p-2">
                      {colors.filter((c) => c.active).map((c) => <li key={c.id}><label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-canvas"><Checkbox name="color" value={c.id} defaultChecked={usedColors.some((u) => u.id === c.id)} /><span className="h-3.5 w-3.5 rounded-full border border-line-strong" style={{ background: c.hex ?? '#e1dfdd' }} aria-hidden />{c.name}</label></li>)}
                    </ul></fieldset>
                  <fieldset><legend className="mb-1 text-sm font-semibold">Tailles</legend>
                    <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-line p-2">
                      {sizes.filter((s) => s.active).map((s) => <li key={s.id}><label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-canvas"><Checkbox name="size" value={s.id} defaultChecked={usedSizes.some((u) => u.id === s.id)} />{s.code}{s.label !== s.code && <span className="text-xs text-ink-soft">{s.label}</span>}</label></li>)}
                    </ul></fieldset>
                </div>
              )}
            </ActionDialog>
            <form action={syncAction}><input type="hidden" name="product_id" value={data.product.id} /><SubmitButton variant="secondary" size="sm" pendingText="Import…"><Download className="h-4 w-4" /> Importer la fiche technique</SubmitButton></form>
          </div>
        )}
      </div>

      <Message state={gen} /><Message state={sync} /><Message state={bars} /><Message state={saveMsg} />
      {archived && <Alert tone="warning">Produit archivé : la matrice est en lecture seule (le stock reste gérable).</Alert>}

      {mode === 'price' && editable && usedSizes.length > 0 && (
        <section className="space-y-2 rounded-md border border-line bg-white p-3 shadow-card" aria-label="Outil de tarification">
          <p className="text-sm font-semibold">Tarification rapide <span className="font-normal text-ink-soft">— prix de base + supplément par taille, appliqués aux variantes actives (à enregistrer ensuite)</span></p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Prix de base HT<Input aria-label="Prix de base" className="mt-1 w-28" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} placeholder="59,00" /></label>
            {usedSizes.map((s) => <label key={s.id} className="text-sm">+ {s.code}<Input aria-label={`Supplément ${s.code}`} className="mt-1 w-20" inputMode="decimal" value={surcharge[s.id] ?? ''} onChange={(e) => setSurcharge((x) => ({ ...x, [s.id]: e.target.value }))} placeholder="0" /></label>)}
            <Button type="button" variant="secondary" onClick={applyPrices} disabled={!base.trim()}><Sparkles className="h-4 w-4" /> Appliquer</Button>
          </div>
        </section>
      )}
      {mode === 'barcode' && editable && (
        <form action={barsAction} className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-white p-3 shadow-card">
          <input type="hidden" name="product_id" value={data.product.id} />
          <p className="text-sm text-ink-soft">{noBarcode} variante(s) active(s) sans code-barres. Les codes générés sont des EAN-13 internes (préfixe 29, usage restreint) avec somme de contrôle ; vous pouvez aussi saisir vos codes GS1.</p>
          <SubmitButton variant="secondary" size="sm" pendingText="Génération…" disabled={noBarcode === 0 || dirty > 0}><Barcode className="h-4 w-4" /> Générer les codes manquants</SubmitButton>
          {dirty > 0 && <span className="text-xs text-warn-text">Enregistrez d’abord vos modifications.</span>}
        </form>
      )}

      {data.variants.length === 0 ? (
        <div className="rounded-md border border-dashed border-line-strong bg-white p-10 text-center">
          <PackagePlus className="mx-auto h-8 w-8 text-ink-faint" aria-hidden />
          <p className="mt-2 text-sm font-semibold">Aucune variante</p>
          <p className="text-sm text-ink-soft">{editable ? 'Générez la matrice couleurs × tailles, ou importez les couleurs et tailles de la fiche technique du produit.' : 'Aucune variante n’a été créée pour ce produit.'}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-white shadow-card">
          <table className="w-full border-separate border-spacing-0 text-sm" aria-label={`Matrice taille × couleur — ${data.product.name}`}>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 border-b border-r border-line bg-canvas px-3 py-2 text-left text-xs font-semibold text-ink-soft">Couleur ↓ / Taille →</th>
                {usedSizes.map((s) => <th key={s.id} scope="col" className="min-w-[7.5rem] border-b border-line bg-canvas px-2 py-2 text-center text-sm font-semibold">{s.code}</th>)}
                {mode === 'stock' && <th scope="col" className="border-b border-l border-line bg-canvas px-3 py-2 text-right text-xs font-semibold text-ink-soft">Total</th>}
              </tr>
            </thead>
            <tbody>
              {usedColors.map((c) => {
                const rowTotal = usedSizes.reduce((a, s) => a + (cell.get(`${c.id}|${s.id}`)?.on_hand ?? 0), 0)
                return (
                  <tr key={c.id}>
                    <th scope="row" className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-line bg-white px-3 py-2 text-left font-medium">
                      <span className="mr-2 inline-block h-4 w-4 rounded-full border border-line-strong align-middle" style={{ background: c.hex ?? '#e1dfdd' }} aria-hidden />{c.name}
                    </th>
                    {usedSizes.map((s) => {
                      const v = cell.get(`${c.id}|${s.id}`)
                      if (!v) return <td key={s.id} className="border-b border-line p-1.5 text-center text-ink-faint">—</td>
                      const e = eff(v)
                      return (
                        <td key={s.id} className="border-b border-line p-1.5 align-top">
                          {mode === 'stock' && (
                            <button type="button" onClick={() => setSel(v.id)} aria-label={`${v.sku} : ${v.on_hand} en stock, ${v.on_hand - v.reserved} disponible(s)`}
                              className={cn('flex w-full flex-col items-center rounded-md border px-2 py-1.5 transition-colors hover:ring-2 hover:ring-brand-300', LEVEL[stockLevel(v)])}>
                              <span className="text-lg font-semibold tabular-nums">{v.on_hand - v.reserved}</span>
                              <span className="text-[11px] text-ink-soft">{v.reserved > 0 ? `${v.on_hand} en stock · ${v.reserved} rés.` : `${v.on_hand} en stock`}</span>
                              {!v.active && <span className="text-[10px] uppercase">inactive</span>}{v.active && v.low && <AlertTriangle className="mt-0.5 h-3 w-3 text-warn-text" aria-label="Stock bas" />}
                            </button>
                          )}
                          {mode === 'price' && (
                            <div className="space-y-1"><Input aria-label={`Prix ${v.sku}`} className={cn('h-9 text-right tabular-nums', edits[v.id]?.price !== undefined && 'border-brand-500 bg-brand-50', !e.active && 'opacity-50')} inputMode="decimal" disabled={!editable}
                              value={e.price} onChange={(ev) => patch(v.id, { price: ev.target.value })} placeholder="—" />
                              <label className="flex items-center justify-center gap-1 text-[11px] text-ink-soft"><input type="checkbox" checked={e.active} disabled={!editable} onChange={(ev) => patch(v.id, { active: ev.target.checked })} className="h-3 w-3 accent-brand-500" aria-label={`Active ${v.sku}`} /> active</label></div>
                          )}
                          {mode === 'barcode' && (
                            <div className="space-y-1">
                              <Input aria-label={`Code-barres ${v.sku}`} className={cn('h-9 font-mono text-xs', edits[v.id]?.barcode !== undefined && 'border-brand-500 bg-brand-50', e.barcode && !gtinValid(e.barcode) && 'border-danger bg-danger/10')} inputMode="numeric" maxLength={14} disabled={!editable}
                                value={e.barcode} onChange={(ev) => patch(v.id, { barcode: ev.target.value.replace(/\D/g, '') })} placeholder="EAN-13" />
                              <button type="button" onClick={() => setSel(v.id)} className="flex w-full items-center justify-center gap-1 text-[11px] text-ink-soft hover:text-ink">
                                {e.barcode ? (gtinValid(e.barcode) ? <><Check className="h-3 w-3 text-success-text" aria-hidden />valide</> : <><X className="h-3 w-3 text-danger-text" aria-hidden />invalide</>) : 'à renseigner'}</button>
                            </div>
                          )}
                          {mode === 'bom' && (
                            <div className="space-y-1">
                              <Select aria-label={`Nomenclature ${v.sku}`} className={cn('h-9 text-xs', edits[v.id]?.bom_id !== undefined && 'border-brand-500 bg-brand-50')} disabled={!editable} value={e.bom_id ?? ''} onChange={(ev) => patch(v.id, { bom_id: ev.target.value || null })}>
                                <option value="">{data.product_bom ? `= produit (${data.product_bom.code})` : '— aucune —'}</option>{bomOptions.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
                              </Select>
                              <button type="button" onClick={() => setSel(v.id)} className="block w-full text-center text-[11px] text-ink-soft hover:text-ink">{(() => { const id = e.bom_id ?? data.product_bom?.id; return id && costs[id] !== undefined ? `coût ${formatMoney(costs[id])}` : id ? 'détail' : 'sans nomenclature' })()}</button>
                            </div>
                          )}
                        </td>
                      )
                    })}
                    {mode === 'stock' && <td className="border-b border-l border-line px-3 py-2 text-right font-semibold tabular-nums">{rowTotal}</td>}
                  </tr>
                )
              })}
            </tbody>
            {mode === 'stock' && (
              <tfoot>
                <tr>
                  <th scope="row" className="sticky left-0 border-r border-line bg-canvas px-3 py-2 text-left text-xs font-semibold text-ink-soft">Total</th>
                  {usedSizes.map((s) => <td key={s.id} className="bg-canvas px-2 py-2 text-center font-semibold tabular-nums">{usedColors.reduce((a, c) => a + (cell.get(`${c.id}|${s.id}`)?.on_hand ?? 0), 0)}</td>)}
                  <td className="border-l border-line bg-canvas px-3 py-2 text-right font-bold tabular-nums">{total}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {mode === 'stock' && data.variants.length > 0 && (
        <p className="flex flex-wrap items-center gap-3 text-xs text-ink-soft">Légende :
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-success/40 bg-success/10" />disponible</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-warn/60 bg-warn/15" />stock bas (≤ sécurité)</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-danger/50 bg-danger/10" />rupture</span>
          <span>Le nombre affiché est le disponible (stock − réservé). Cliquez une case pour gérer son stock.</span></p>
      )}

      {dirty > 0 && (
        <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-md border border-brand-300 bg-white p-3 shadow-pop" role="status">
          <p className="text-sm"><strong>{dirty}</strong> variante(s) modifiée(s), non enregistrée(s).</p>
          <div className="flex gap-2"><Button type="button" variant="secondary" onClick={() => { setEdits({}); setSaveMsg(null) }} disabled={saving}><RotateCcw className="h-4 w-4" /> Annuler</Button><Button type="button" onClick={save} disabled={saving}><Save className="h-4 w-4" /> {saving ? 'Enregistrement…' : 'Enregistrer'}</Button></div>
        </div>
      )}

      <Dialog open={Boolean(selected)} onClose={() => setSel(null)} title={selected ? `${selected.sku}` : ''} className="max-w-2xl">
        {selected && <VariantDetail key={selected.id} v={selected} data={data} color={colorById.get(selected.color_id)} size={sizeById.get(selected.size_id)} whName={whName} canWrite={editable} canStock={canStock} canBomWrite={canBomWrite} cost={(selected.bom_id ?? data.product_bom?.id) ? costs[(selected.bom_id ?? data.product_bom?.id) as string] : undefined} onClose={() => setSel(null)} />}
      </Dialog>
    </div>
  )
}

function VariantDetail({ v, data, color, size, whName, canWrite, canStock, canBomWrite, cost, onClose }: {
  v: VariantRow; data: MatrixData; color?: CatalogColor; size?: CatalogSize; whName: Map<string, string>; canWrite: boolean; canStock: boolean; canBomWrite: boolean; cost?: number; onClose: () => void
}) {
  const [move, moveAction] = useActionState(stockMoveAction, null)
  const [res, resAction] = useActionState(reserveStockAction, null)
  const [saf, safAction] = useActionState(safetyStockAction, null)
  const [del, delAction] = useActionState(async (p: FormState, fd: FormData) => { const r = await deleteVariantAction(p, fd); if (r?.ok) onClose(); return r }, null)
  const [bomState, bomAction] = useActionState(createVariantBomAction, null)
  const [type, setType] = useState<(typeof MOVE_TYPES)[number]['value']>('receipt')
  const [whSel, setWhSel] = useState(data.warehouses[0]?.id ?? '')
  const hint = MOVE_TYPES.find((m) => m.value === type)?.hint
  const stockOf = (id: string) => v.stock.find((s) => s.warehouse_id === id)
  const bomId = v.bom_id ?? data.product_bom?.id ?? null
  return (
    <div className="space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 text-sm">
          <p className="flex items-center gap-2 font-semibold"><span className="h-4 w-4 rounded-full border border-line-strong" style={{ background: color?.hex ?? '#e1dfdd' }} aria-hidden />{color?.name} · taille {size?.code}{!v.active && <Badge tone="neutral">Inactive</Badge>}</p>
          <p className="text-ink-soft">Produit <Link href={`/products/${data.product.id}`} className="font-mono text-brand-700 hover:underline">{data.product.code}</Link> · prix {v.price === null ? 'non défini' : <strong className="text-ink">{formatPrice(v.price, v.currency)}</strong>}</p>
          <p className="text-ink-soft">Nomenclature : {bomId ? <Link href={`/bom/${bomId}`} className="font-mono text-brand-700 hover:underline">{v.bom_code ?? data.product_bom?.code}</Link> : 'aucune'}{v.bom_id ? ' (propre à la variante)' : data.product_bom ? ' (celle du produit)' : ''}{cost !== undefined && <> · coût de revient <strong className="tabular-nums text-ink">{formatMoney(cost)}</strong></>}</p>
        </div>
        <div className="rounded-md border border-line bg-white p-2 text-center">{v.barcode ? <Ean13 code={v.barcode} /> : <p className="px-4 py-3 text-xs text-ink-soft">Pas de code-barres</p>}</div>
      </div>

      <section aria-label="Stock par entrepôt" className="space-y-2">
        <h3 className="text-sm font-semibold">Stock par entrepôt</h3>
        {data.warehouses.length === 0 ? <p className="text-sm text-ink-soft">Aucun entrepôt : créez-en un dans le module Stock.</p> : (
          <div className="overflow-x-auto rounded-md border border-line"><table className="w-full min-w-[30rem] text-sm">
            <thead className="bg-canvas text-left text-xs text-ink-soft"><tr><th className="px-3 py-1.5 font-semibold">Entrepôt</th><th className="px-2 py-1.5 text-right font-semibold">Stock</th><th className="px-2 py-1.5 text-right font-semibold">Réservé</th><th className="px-2 py-1.5 text-right font-semibold">Disponible</th><th className="px-2 py-1.5 text-right font-semibold">Sécurité</th></tr></thead>
            <tbody className="divide-y divide-line">{data.warehouses.map((w) => { const s = stockOf(w.id); const avail = (s?.on_hand ?? 0) - (s?.reserved ?? 0); return (
              <tr key={w.id}><td className="px-3 py-1.5">{w.name}</td><td className="px-2 py-1.5 text-right tabular-nums">{s?.on_hand ?? 0}</td><td className="px-2 py-1.5 text-right tabular-nums">{s?.reserved ?? 0}</td>
                <td className={cn('px-2 py-1.5 text-right font-semibold tabular-nums', s && s.safety > 0 && avail <= s.safety && 'text-warn-text')}>{avail}</td><td className="px-2 py-1.5 text-right tabular-nums text-ink-soft">{s?.safety ?? 0}</td></tr>) })}</tbody></table></div>
        )}
      </section>

      {canStock && data.warehouses.length > 0 && (
        <section aria-label="Mouvement de stock" className="space-y-3 rounded-md border border-line bg-canvas/40 p-3">
          <h3 className="text-sm font-semibold">Mouvement de stock</h3>
          <Message state={move} />
          <form action={moveAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="variant_id" value={v.id} /><input type="hidden" name="product_id" value={data.product.id} />
            <label className="text-sm">Type<Select name="type" className="mt-1" value={type} onChange={(e) => setType(e.target.value as typeof type)}>{MOVE_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select></label>
            <label className="text-sm">{type === 'transfer' ? 'Entrepôt d’origine' : 'Entrepôt'}<Select name="warehouse_id" className="mt-1" value={whSel} onChange={(e) => setWhSel(e.target.value)}>{data.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></label>
            {type === 'transfer' && <label className="text-sm">Entrepôt de destination<Select name="to_warehouse_id" className="mt-1" defaultValue="">{data.warehouses.filter((w) => w.id !== whSel).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></label>}
            <label className="text-sm">{type === 'inventory' ? 'Quantité comptée' : type === 'adjustment' ? 'Écart (± pièces)' : 'Quantité'}<Input name="qty" className="mt-1" inputMode="numeric" placeholder={type === 'adjustment' ? '-3' : '10'} /></label>
            <label className="text-sm">Référence<Input name="reference" className="mt-1" maxLength={80} placeholder="OF-2026-014, CMD-0001…" /></label>
            <label className="text-sm sm:col-span-2">Motif {type === 'adjustment' ? '*' : '(facultatif)'}<Textarea name="reason" className="mt-1" rows={2} maxLength={200} /></label>
            <p className="text-xs text-ink-soft sm:col-span-2">{hint}</p>
            <div className="sm:col-span-2"><SubmitButton pendingText="Enregistrement…">Enregistrer le mouvement</SubmitButton></div>
          </form>
          <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
            <form action={resAction} className="space-y-1.5"><input type="hidden" name="variant_id" value={v.id} /><input type="hidden" name="product_id" value={data.product.id} /><input type="hidden" name="warehouse_id" value={whSel} />
              <p className="text-sm font-medium">Réserver / libérer (entrepôt sélectionné)</p><div className="flex gap-2"><Input name="delta" aria-label="Pièces à réserver (négatif pour libérer)" inputMode="numeric" placeholder="+10 ou -5" /><SubmitButton variant="secondary" pendingText="…">Appliquer</SubmitButton></div><Message state={res} /></form>
            <form action={safAction} className="space-y-1.5"><input type="hidden" name="variant_id" value={v.id} /><input type="hidden" name="product_id" value={data.product.id} /><input type="hidden" name="warehouse_id" value={whSel} />
              <p className="text-sm font-medium">Stock de sécurité (entrepôt sélectionné)</p><div className="flex gap-2"><Input name="qty" aria-label="Stock de sécurité" inputMode="numeric" defaultValue={stockOf(whSel)?.safety ?? 0} /><SubmitButton variant="secondary" pendingText="…">Enregistrer</SubmitButton></div><Message state={saf} /></form>
          </div>
        </section>
      )}

      {canWrite && canBomWrite && data.product_bom && (
        <section aria-label="Nomenclature de la variante" className="space-y-2 rounded-md border border-line bg-canvas/40 p-3">
          <h3 className="text-sm font-semibold">Nomenclature propre à la variante</h3>
          <p className="text-xs text-ink-soft">Copie la nomenclature du produit ({data.product_bom.code}) pour l’adapter (tissu, fil, zip de la couleur ; métrage de la taille) puis l’affecte à la variante, à toute sa couleur ou à toutes les variantes.</p>
          <Message state={bomState} />
          <form action={bomAction} className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <input type="hidden" name="product_id" value={data.product.id} /><input type="hidden" name="variant_id" value={v.id} /><input type="hidden" name="source_bom" value={data.product_bom.id} />
            <label className="text-sm">Nom<Input name="name" className="mt-1" maxLength={160} defaultValue={`${data.product.name} — ${color?.name ?? ''}`} /></label>
            <label className="text-sm">Affecter à<Select name="scope" className="mt-1" defaultValue="color"><option value="variant">cette variante</option><option value="color">toute la couleur {color?.name}</option><option value="all">toutes les variantes</option></Select></label>
            <SubmitButton variant="secondary" pendingText="Copie…"><Plus className="h-4 w-4" /> Créer</SubmitButton>
          </form>
        </section>
      )}

      {canWrite && (
        <form action={delAction} className="flex flex-wrap items-center gap-3 border-t border-line pt-3" onSubmit={(e) => { if (!window.confirm(`Supprimer la variante ${v.sku} ?`)) e.preventDefault() }}>
          <input type="hidden" name="id" value={v.id} /><input type="hidden" name="product_id" value={data.product.id} />
          <SubmitButton variant="ghost" size="sm" className="text-danger-text" pendingText="Suppression…"><Trash2 className="h-4 w-4" /> Supprimer la variante</SubmitButton>
          <span className="text-xs text-ink-soft">Impossible si la variante a un historique de stock : désactivez-la dans l’onglet Prix.</span>{del && !del.ok && <span role="alert" className="text-xs text-danger-text">{del.message}</span>}
        </form>
      )}
    </div>
  )
}

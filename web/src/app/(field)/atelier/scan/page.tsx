import type { Metadata } from 'next'
import { requireAuth } from '@/features/auth/guards'
import { ScanPanel } from '@/features/field/components/panels'
import { StockCodeLookup } from '@/features/stock/components/code-lookup'

export const metadata: Metadata = { title: 'Scanner' }

export default async function ScanPage() {
  await requireAuth()
  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold tracking-tight">Scanner un code</h1>
      <p className="text-lg text-ink-soft">OF, contrôle, bon de livraison ou référence article.</p>
      <ScanPanel />
      <h2 className="text-xl font-semibold">Article, lot ou emplacement</h2>
      <StockCodeLookup />
    </div>
  )
}

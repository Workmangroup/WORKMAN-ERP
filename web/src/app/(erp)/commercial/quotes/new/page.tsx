import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { NewQuoteForm } from '@/features/commercial/components/doc-forms'
import { partyOptions } from '@/features/commercial/services/commercial.service'
import { createClient } from '@/lib/supabase/server'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouveau devis' }

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ party?: string }> }) {
  await requirePermission(P.QUOTES_WRITE)
  const sp = await searchParams
  const { clients, prospects } = await partyOptions()
  // Taux selon la règle de la base (0029) : 0 % pour un client exonéré ou hors du pays de la société, 19 % sinon
  const supabase = await createClient()
  const [co, rows] = await Promise.all([supabase.from('companies').select('country').limit(1).maybeSingle(), supabase.from('clients').select('id,country,vat_exempt').is('archived_at', null)])
  const home = (co.data?.country as string | undefined) ?? 'TN'
  const vatByParty = Object.fromEntries(((rows.data ?? []) as { id: string; country: string; vat_exempt: boolean }[]).map((c) => [`c:${c.id}`, c.vat_exempt || c.country !== home ? 0 : 19]))
  return (
    <>
      <PageHeader title="Nouveau devis" actions={<Link href="/commercial/quotes" className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Devis</Link>} />
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><NewQuoteForm clients={clients} prospects={prospects} defaultParty={sp.party} vatByParty={vatByParty} /></div>
    </>
  )
}

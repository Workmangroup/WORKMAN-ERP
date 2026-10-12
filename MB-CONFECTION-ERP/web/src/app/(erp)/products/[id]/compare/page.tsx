import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, GitCompare } from 'lucide-react'
import { z } from 'zod'
import { Alert } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { CompareView } from '@/features/products/components/compare-view'
import { compareVersions, getProduct, listVersions } from '@/features/products/services/products.service'
import { VERSION_STATUS } from '@/lib/products/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Comparaison de versions' }

export default async function ComparePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ a?: string; b?: string }> }) {
  await requirePermission(P.PRODUCTS_READ)
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const sp = await searchParams
  const product = await getProduct(id)
  if (!product) notFound()
  const versions = (await listVersions(id)).sort((x, y) => x.version_no - y.version_no)
  const ids = new Set(versions.map((v) => v.id))
  const a = sp.a && ids.has(sp.a) ? sp.a : versions.length > 1 ? versions[versions.length - 2].id : undefined
  const b = sp.b && ids.has(sp.b) ? sp.b : versions[versions.length - 1]?.id
  const cmp = a && b && a !== b ? await compareVersions(a, b) : null

  return (
    <>
      <PageHeader title={`${product.code} — comparaison de versions`} description={product.name}
        actions={<Link href={`/products/${id}?tab=versions`} className={buttonVariants({ variant: 'command', size: 'sm' })}><ArrowLeft className="h-4 w-4" /> Versions</Link>} />
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <form className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-white p-4 shadow-card">
          <div><label htmlFor="a" className="mb-1 block text-sm font-semibold">Version de départ</label>
            <Select id="a" name="a" defaultValue={a} className="w-52">{versions.map((v) => <option key={v.id} value={v.id}>Version {v.version_no} ({VERSION_STATUS[v.status].label.toLowerCase()})</option>)}</Select></div>
          <div><label htmlFor="b" className="mb-1 block text-sm font-semibold">Version comparée</label>
            <Select id="b" name="b" defaultValue={b} className="w-52">{versions.map((v) => <option key={v.id} value={v.id}>Version {v.version_no} ({VERSION_STATUS[v.status].label.toLowerCase()})</option>)}</Select></div>
          <Button type="submit"><GitCompare className="h-4 w-4" /> Comparer</Button>
        </form>
        {versions.length < 2 ? <Alert tone="info">Il faut au moins deux versions pour comparer. Créez une nouvelle version depuis l’onglet Versions.</Alert>
          : a === b ? <Alert tone="info">Choisissez deux versions différentes.</Alert>
          : !cmp ? <Alert tone="error">Comparaison impossible (droits insuffisants ou versions introuvables).</Alert>
          : <CompareView cmp={cmp} />}
      </div>
    </>
  )
}

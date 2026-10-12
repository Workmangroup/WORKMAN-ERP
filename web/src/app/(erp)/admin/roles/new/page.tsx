import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { RoleCreateForm } from '@/features/rbac/components/role-forms'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Nouveau rôle' }

export default async function NewRolePage() {
  await requirePermission(P.ROLES_WRITE)
  return (
    <>
      <PageHeader
        title="Nouveau rôle"
        description="Le rôle est créé sans permission ; vous les définirez à l’étape suivante."
        actions={
          <Link href="/admin/roles" className={buttonVariants({ variant: 'command', size: 'sm' })}>
            <ArrowLeft className="h-4 w-4" /> Retour
          </Link>
        }
      />
      <div className="p-6">
        <div className="rounded-md border border-line bg-white p-6 shadow-card">
          <RoleCreateForm />
        </div>
      </div>
    </>
  )
}

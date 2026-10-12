import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/page-header'
import { requirePermission } from '@/features/auth/guards'
import { listClientsLite } from '@/features/articles/services/articles.service'
import { KanbanBoard } from '@/features/development/components/kanban-board'
import { listProjects } from '@/features/development/services/development.service'
import { PRIORITY } from '@/lib/development/options'
import { P } from '@/lib/rbac/permissions'

export const metadata: Metadata = { title: 'Kanban — Développement produit' }

export default async function BoardPage({ searchParams }: { searchParams: Promise<{ client?: string; priority?: string }> }) {
  const ctx = await requirePermission(P.DEVELOPMENT_READ)
  const sp = await searchParams
  const [{ rows }, clients] = await Promise.all([listProjects({ client: sp.client, priority: sp.priority }, { all: true }), listClientsLite()])
  const canWrite = ctx.permissions.includes(P.DEVELOPMENT_WRITE)
  return (
    <>
      <PageHeader title="Kanban" description="Glissez un projet vers la colonne suivante (une étape à la fois, sous conditions) ou utilisez les flèches de la carte. Un retour en arrière demande un motif."
        actions={canWrite && <Link href="/development/projects/new" className={buttonVariants({ variant: 'command', size: 'sm' })}><Plus className="h-4 w-4" /> Nouveau projet</Link>} />
      <div className="space-y-4 p-4 sm:p-6">
        <form action="/development/board" className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-white p-3 shadow-card">
          <div><Label htmlFor="client">Client</Label><Select id="client" name="client" defaultValue={sp.client ?? ''} className="w-48"><option value="">Tous</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
          <div><Label htmlFor="priority">Priorité</Label><Select id="priority" name="priority" defaultValue={sp.priority ?? ''} className="w-40"><option value="">Toutes</option>{Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</Select></div>
          <Button type="submit" variant="secondary">Filtrer</Button>
          <span className="ml-auto text-sm text-ink-soft">{rows.length} projet(s) en cours</span>
        </form>
        <KanbanBoard projects={rows} canWrite={canWrite} />
      </div>
    </>
  )
}

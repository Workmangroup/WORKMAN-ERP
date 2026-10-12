import type { Metadata } from 'next'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { ROUTES } from '@/lib/auth/constants'

export const metadata: Metadata = { title: 'Accès refusé' }

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md rounded-md border border-line bg-white p-8 text-center shadow-card">
        <ShieldAlert className="mx-auto h-10 w-10 text-danger-text" aria-hidden />
        <h1 className="mt-4 text-xl font-semibold">Accès refusé</h1>
        <p className="mt-2 text-sm text-ink-soft">
          Vous n’avez pas les droits nécessaires pour consulter cette page. Contactez votre administrateur si vous pensez qu’il s’agit d’une erreur.
        </p>
        <Link href={ROUTES.home} className={buttonVariants({ className: 'mt-6' })}>Retour à l’accueil</Link>
      </div>
    </div>
  )
}

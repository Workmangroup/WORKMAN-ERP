import Link from 'next/link'
import { Grip } from 'lucide-react'
import { ROUTES } from '@/lib/auth/constants'
import { Breadcrumbs } from './breadcrumbs'
import { UserMenu } from './user-menu'
import { MobileNav, SideNav } from './side-nav'
import { QuickSearch } from './quick-search'

/** Coquille applicative façon Dynamics 365 : barre d'application bleu nuit + navigation latérale, société active affichée. */
export function AppShell({ children, companyName }: { children: React.ReactNode; companyName?: string | null }) {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#contenu" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-white focus:px-3 focus:py-2 focus:text-ink focus:shadow-card">
        Aller au contenu
      </a>
      <header className="sticky top-0 z-30 flex min-h-12 flex-wrap items-center gap-2 bg-shell px-3 py-1 text-white sm:flex-nowrap sm:gap-3">
        <MobileNav />
        <span className="hidden h-8 w-8 items-center justify-center rounded-sm text-white/90 md:flex" aria-hidden>
          <Grip className="h-5 w-5" />
        </span>
        <Link href={ROUTES.home} className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
          WORKMAN <span className="font-normal text-white/70">ERP 360</span>
        </Link>
        {companyName && (
          <span className="hidden max-w-[12rem] truncate rounded-sm border border-white/25 px-2 py-0.5 text-xs text-white/90 lg:inline" title={`Société active : ${companyName}`}>
            Société : {companyName}
          </span>
        )}

        <QuickSearch />

        <div className="ml-auto">
          <UserMenu />
        </div>
      </header>

      <div className="flex flex-1">
        <SideNav />
        <main id="contenu" tabIndex={-1} className="min-w-0 flex-1 outline-none">
          <Breadcrumbs />
          {children}
        </main>
      </div>
    </div>
  )
}

import Link from 'next/link'
import { Grip } from 'lucide-react'
import { ROUTES } from '@/lib/auth/constants'
import { UserMenu } from './user-menu'
import { MobileNav, SideNav } from './side-nav'
import { QuickSearch } from './quick-search'

/** Coquille applicative façon Dynamics 365 : barre d'application bleu nuit + navigation latérale. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-3 bg-shell px-3 text-white">
        <MobileNav />
        <span className="hidden h-8 w-8 items-center justify-center rounded-sm text-white/90 md:flex" aria-hidden>
          <Grip className="h-5 w-5" />
        </span>
        <Link href={ROUTES.home} className="text-[15px] font-semibold tracking-tight">
          WORKMAN <span className="font-normal text-white/70">ERP 360</span>
        </Link>

        <QuickSearch />

        <div className="ml-auto md:ml-0">
          <UserMenu />
        </div>
      </header>

      <div className="flex flex-1">
        <SideNav />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}

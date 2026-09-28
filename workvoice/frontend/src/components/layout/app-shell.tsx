"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Building2,
  CalendarDays,
  Clock,
  ClipboardCheck,
  ClipboardList,
  DoorOpen,
  FilePlus2,
  FileSignature,
  History,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Menu,
  MessageSquareWarning,
  ShieldCheck,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { ROLE_HOME, ROLE_LABELS } from "@/lib/constants";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import { FullPageLoader } from "@/components/common/states";
import { NotificationBell } from "@/components/layout/notification-bell";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Role } from "@/types";

type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV: Record<Role, { section?: string; items: NavItem[] }[]> = {
  EMPLOYE: [
    { items: [{ href: "/employe/", label: "Tableau de bord", icon: LayoutDashboard }] },
    {
      section: "Nouveau",
      items: [
        { href: "/employe/nouvelle-demande/", label: "Nouvelle demande RH", icon: FilePlus2 },
        { href: "/employe/attestations/", label: "Demander une attestation", icon: FileSignature },
        { href: "/employe/nouvelle-reclamation/", label: "Nouvelle réclamation", icon: MessageSquareWarning },
        { href: "/employe/suggestion/", label: "Faire une suggestion", icon: Lightbulb },
        { href: "/employe/questionnaire/", label: "Questionnaire satisfaction", icon: ClipboardCheck },
      ],
    },
    {
      section: "Absences",
      items: [
        { href: "/employe/conges/", label: "Mes congés", icon: CalendarDays },
        { href: "/employe/sorties/", label: "Autorisations de sortie", icon: DoorOpen },
        { href: "/employe/retards/", label: "Mes retards", icon: Clock },
      ],
    },
    {
      section: "Suivi",
      items: [
        { href: "/employe/historique/", label: "Historique", icon: History },
        { href: "/profil/", label: "Mon profil", icon: UserRound },
      ],
    },
  ],
  RH: [
    { items: [{ href: "/rh/", label: "Tableau de bord", icon: LayoutDashboard }] },
    {
      section: "Traitement",
      items: [
        { href: "/rh/demandes/", label: "Demandes RH", icon: ClipboardList },
        { href: "/rh/attestations/", label: "Attestations", icon: FileSignature },
        { href: "/rh/reclamations/", label: "Réclamations", icon: MessageSquareWarning },
        { href: "/rh/suggestions/", label: "Suggestions", icon: Lightbulb },
        { href: "/rh/questionnaire/", label: "Satisfaction", icon: ClipboardCheck },
      ],
    },
    {
      section: "Absences",
      items: [
        { href: "/rh/conges/", label: "Congés", icon: CalendarDays },
        { href: "/rh/sorties/", label: "Autorisations de sortie", icon: DoorOpen },
        { href: "/rh/retards/", label: "Retards", icon: Clock },
      ],
    },
    {
      section: "Administration",
      items: [
        { href: "/rh/collaborateurs/", label: "Collaborateurs & accès", icon: Users },
        { href: "/profil/", label: "Mon profil", icon: UserRound },
      ],
    },
  ],
  DIRECTION: [
    {
      items: [
        { href: "/direction/", label: "Tableau exécutif", icon: BarChart3 },
        { href: "/direction/reclamations/", label: "Réclamations", icon: MessageSquareWarning },
        { href: "/direction/questionnaire/", label: "Satisfaction", icon: ClipboardCheck },
      ],
    },
    { section: "Compte", items: [{ href: "/profil/", label: "Mon profil", icon: UserRound }] },
  ],
  SYSTEM_ADMIN: [
    {
      section: "Administration",
      items: [
        { href: "/admin/societes/", label: "Sociétés", icon: Building2 },
        { href: "/rh/collaborateurs/", label: "Collaborateurs & accès", icon: Users },
        { href: "/rh/attestations/", label: "Attestations", icon: FileSignature },
        { href: "/profil/", label: "Mon profil", icon: UserRound },
      ],
    },
  ],
};

// Un même espace peut être accessible à plusieurs rôles (ex. /rh est aussi ouvert au
// SYSTEM_ADMIN, qui y gère les collaborateurs de n'importe quelle société).
const SPACE_ROLES: [string, Role[]][] = [
  ["/admin", ["SYSTEM_ADMIN"]],
  ["/employe", ["EMPLOYE"]],
  ["/rh", ["RH", "SYSTEM_ADMIN"]],
  ["/direction", ["DIRECTION"]],
];

function SidebarNav({ role, pathname, onNavigate }: { role: Role; pathname: string; onNavigate?: () => void }) {
  const home = ROLE_HOME[role];
  return (
    <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
      {NAV[role].map((group, i) => (
        <div key={i}>
          {group.section && (
            <p className="mb-2 px-3 text-[11px] font-semibold tracking-wider text-blue-200/60 uppercase">{group.section}</p>
          )}
          <ul className="space-y-0.5">
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = pathname === href || (href !== home && pathname.startsWith(href));
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    className={cn(
                      "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                      active
                        ? "bg-wm-yellow text-wm-blue-dark shadow-sm"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-white",
                    )}
                  >
                    <Icon className={cn("size-4.5", active ? "text-wm-blue-dark" : "text-blue-200/70 group-hover:text-white")} />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SidebarFooter() {
  return (
    <div className="border-t border-sidebar-border px-5 py-4 text-[11px] text-blue-200/60">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-3.5" /> Données confidentielles protégées
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  const requiredRoles = SPACE_ROLES.find(([prefix]) => pathname.startsWith(prefix))?.[1];
  const allowed = user && (!requiredRoles || requiredRoles.includes(user.role));

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace(`/login/?next=${encodeURIComponent(pathname)}`);
    else if (user.mdp_temporaire && pathname !== "/profil/") router.replace("/profil/?changer=1");
    else if (!allowed) router.replace(ROLE_HOME[user.role]);
  }, [loading, user, allowed, pathname, router]);

  if (loading || !user || !allowed || (user.mdp_temporaire && pathname !== "/profil/")) return <FullPageLoader />;

  return (
    <div className="min-h-screen">
      {/* Sidebar desktop */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-sidebar lg:flex">
        <div className="flex h-16 items-center border-b border-sidebar-border px-5">
          <Link href={ROLE_HOME[user.role]}>
            <Logo inverted />
          </Link>
        </div>
        <SidebarNav role={user.role} pathname={pathname} />
        <SidebarFooter />
      </aside>

      {/* Sidebar mobile */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="flex w-72 flex-col gap-0 border-none bg-sidebar p-0 text-sidebar-foreground">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <div className="flex h-16 items-center border-b border-sidebar-border px-5">
            <Logo inverted />
          </div>
          <SidebarNav role={user.role} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
          <SidebarFooter />
        </SheetContent>
      </Sheet>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b bg-white/90 px-4 backdrop-blur sm:px-6">
          <button
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Ouvrir le menu"
          >
            <Menu className="size-5" />
          </button>
          <div className="lg:hidden">
            <Logo className="[&>div:last-child>div:last-child]:hidden" />
          </div>
          <div className="hidden text-sm text-muted-foreground lg:block">
            Espace <span className="font-semibold text-wm-blue">{ROLE_LABELS[user.role]}</span>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <NotificationBell />
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-lg py-1 pr-2 pl-1 transition hover:bg-slate-100">
                <span className="flex size-8 items-center justify-center rounded-full bg-wm-blue text-xs font-bold text-white">
                  {initials(user.prenom, user.nom)}
                </span>
                <span className="hidden text-left leading-tight sm:block">
                  <span className="block text-sm font-semibold text-slate-800">
                    {user.prenom} {user.nom}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{user.matricule}</span>
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    <div className="text-sm font-semibold">{user.prenom} {user.nom}</div>
                    <div className="text-xs font-normal text-muted-foreground">{ROLE_LABELS[user.role]} · {user.site}</div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push("/profil/")}>
                  <UserRound className="size-4" /> Mon profil
                </DropdownMenuItem>
                <DropdownMenuItem onClick={logout} className="text-red-600">
                  <LogOut className="size-4" /> Se déconnecter
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

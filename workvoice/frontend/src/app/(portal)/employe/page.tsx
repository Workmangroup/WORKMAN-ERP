"use client";

import Link from "next/link";
import { ArrowRight, Bell, CalendarDays, CheckCircle2, ClipboardCheck, Clock, FilePlus2, Hourglass, Lightbulb, MessageSquareReply, MessageSquareWarning } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { KINDS, typeLabel } from "@/lib/constants";
import { formatDate, timeAgo } from "@/lib/format";
import { StatusBadge } from "@/components/common/badges";
import { PageHeader } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { ticketHref } from "@/components/tickets/ticket-page";
import type { Campagne, Kind, TicketSummary } from "@/types";

interface Dashboard {
  compteurs: { total: number; en_cours: number; cloturees: number; en_attente: number; notifications_non_lues: number };
  dernieres_reponses: { id: number; message: string; date_creation: string; kind: Kind; ticket_id: number; numero: string; objet: string }[];
  recents: TicketSummary[];
}

const ACTIONS = [
  { href: "/employe/nouvelle-demande/", title: "Nouvelle demande RH", text: "Attestation, congé, avance, formation…", icon: FilePlus2 },
  { href: "/employe/nouvelle-reclamation/", title: "Nouvelle réclamation", text: "Signaler un problème, en toute confidentialité", icon: MessageSquareWarning },
  { href: "/employe/suggestion/", title: "Faire une suggestion", text: "Proposer une idée d'amélioration", icon: Lightbulb },
];

export default function EmployeDashboard() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<{ data: Dashboard }>("/me/dashboard");
  const d = data?.data;
  const { data: qsp } = useApi<{ data: { campagne: Campagne | null; deja_repondu: boolean } }>("/questionnaire/actif");
  const questionnaire = qsp?.data.campagne && !qsp.data.deja_repondu ? qsp.data.campagne : null;
  const { data: solde } = useApi<{ data: { solde_initial: number; solde_actuel: number } }>("/me/solde-conges");

  return (
    <>
      <PageHeader title={`Bonjour, ${user?.prenom}`} description="Suivez vos demandes et échangez avec le service RH." />

      {questionnaire && (
        <Link
          href="/employe/questionnaire/"
          className="group mb-6 flex flex-col gap-4 rounded-xl bg-gradient-to-r from-wm-blue to-wm-blue-dark p-5 text-white shadow-md transition hover:shadow-lg sm:flex-row sm:items-center"
        >
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-wm-yellow text-wm-blue-dark">
            <ClipboardCheck className="size-6" />
          </div>
          <div className="flex-1">
            <p className="font-semibold">Questionnaire de satisfaction du personnel · <span lang="ar" dir="rtl" className="font-arabic">إستطلاع رضا الموظف</span></p>
            <p className="text-sm text-blue-100">{questionnaire.titre} · 11 questions · 2 minutes · réponses anonymes</p>
          </div>
          <span className="inline-flex items-center gap-1.5 self-start rounded-lg bg-wm-yellow px-4 py-2 text-sm font-semibold text-wm-blue-dark sm:self-auto">
            Répondre <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
          </span>
        </Link>
      )}

      {error && <ErrorState message={error.message} onRetry={reload} />}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Link href="/employe/conges/" className="rounded-xl transition hover:-translate-y-0.5">
          <KpiCard
            label="Solde de congé"
            value={solde ? `${solde.data.solde_actuel} j` : "–"}
            icon={CalendarDays}
            tone="blue"
            hint={solde && `Sur ${solde.data.solde_initial} j attribués`}
          />
        </Link>
        <KpiCard label="En cours" value={d?.compteurs.en_cours ?? "–"} icon={Clock} tone="blue" />
        <KpiCard label="Clôturées" value={d?.compteurs.cloturees ?? "–"} icon={CheckCircle2} tone="green" />
        <KpiCard label="En attente de votre retour" value={d?.compteurs.en_attente ?? "–"} icon={Hourglass} tone="yellow" />
        <KpiCard label="Notifications non lues" value={d?.compteurs.notifications_non_lues ?? "–"} icon={Bell} tone="slate" />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {ACTIONS.map(({ href, title, text, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-center gap-4 rounded-xl border bg-card p-5 shadow-xs transition hover:-translate-y-0.5 hover:border-wm-blue/40 hover:shadow-md"
          >
            <div className="rounded-xl bg-wm-blue p-3 text-wm-yellow transition group-hover:scale-105">
              <Icon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-slate-900">{title}</p>
              <p className="text-sm text-muted-foreground">{text}</p>
            </div>
            <ArrowRight className="size-4 text-slate-400 transition group-hover:translate-x-1 group-hover:text-wm-blue" />
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border bg-card shadow-xs">
          <header className="flex items-center gap-2 border-b px-5 py-4">
            <MessageSquareReply className="size-4 text-wm-blue" />
            <h2 className="font-semibold">Dernières réponses RH</h2>
          </header>
          <div className="p-3">
            {loading && !d ? (
              <LoadingBlock rows={3} />
            ) : d?.dernieres_reponses.length ? (
              <ul>
                {d.dernieres_reponses.map((r) => (
                  <li key={r.id}>
                    <Link href={ticketHref("employe", r.kind, r.ticket_id)} className="block rounded-lg p-3 transition hover:bg-slate-50">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono font-semibold text-wm-blue">{r.numero}</span>
                        <span className="text-muted-foreground">{timeAgo(r.date_creation)}</span>
                      </div>
                      <p className="mt-1 truncate text-sm font-medium">{r.objet}</p>
                      <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">« {r.message} »</p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Aucune réponse pour le moment" description="Les réponses du service RH apparaîtront ici." />
            )}
          </div>
        </section>

        <section className="rounded-xl border bg-card shadow-xs">
          <header className="flex items-center justify-between border-b px-5 py-4">
            <h2 className="font-semibold">Mes derniers dossiers</h2>
            <Link href="/employe/historique/" className="text-sm font-medium text-wm-blue hover:underline">
              Tout voir
            </Link>
          </header>
          <div className="p-3">
            {loading && !d ? (
              <LoadingBlock rows={3} />
            ) : d?.recents.length ? (
              <ul>
                {d.recents.map((t) => (
                  <li key={`${t.kind}-${t.id}`}>
                    <Link href={ticketHref("employe", t.kind, t.id)} className="flex items-center gap-3 rounded-lg p-3 transition hover:bg-slate-50">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-mono font-semibold text-wm-blue">{t.numero}</span>·<span>{KINDS[t.kind].label}</span>·
                          <span>{formatDate(t.date_creation)}</span>
                        </div>
                        <p className="mt-0.5 truncate text-sm font-medium">{t.objet}</p>
                        <p className="text-xs text-muted-foreground">{typeLabel(t.kind, t.type)}</p>
                      </div>
                      <StatusBadge statut={t.statut} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Aucun dossier" description="Créez votre première demande en un clic." />
            )}
          </div>
        </section>
      </div>
    </>
  );
}

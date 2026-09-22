"use client";

import Link from "next/link";
import { AlertOctagon, ClipboardList, Inbox, Lightbulb, MessageSquareWarning, Timer } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { KINDS, STATUT_LABELS, TYPES_DEMANDE, typeLabel } from "@/lib/constants";
import { formatJours, timeAgo } from "@/lib/format";
import { StatusBadge, UrgencyBadge } from "@/components/common/badges";
import { PageHeader } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import { ChartCard, GroupedBarChart, HBarChart, WM } from "@/components/charts/charts";
import { ticketHref } from "@/components/tickets/ticket-page";
import type { Statut, TicketSummary } from "@/types";

interface RhDashboard {
  kpi: {
    demandes_ouvertes: number;
    reclamations_ouvertes: number;
    suggestions_ouvertes: number;
    critiques_ouvertes: number;
    a_prendre_en_charge: number;
    delai_moyen_jours: number | null;
  };
  delais_moyens_jours: { demandes: number | null; reclamations: number | null; global: number | null };
  par_statut: { statut: Statut; demandes: number; reclamations: number }[];
  demandes_ouvertes_par_type: { type: string; total: number }[];
  derniers_tickets: TicketSummary[];
}

export default function RhDashboardPage() {
  const { data, error, loading, reload } = useApi<{ data: RhDashboard }>("/rh/dashboard");
  const d = data?.data;

  if (error) return <ErrorState message={error.message} onRetry={reload} />;

  return (
    <>
      <PageHeader
        title="Tableau de bord RH"
        description={d ? `${d.kpi.a_prendre_en_charge} dossier(s) nouveau(x) à prendre en charge` : "Vue d'ensemble des dossiers"}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Demandes ouvertes" value={d?.kpi.demandes_ouvertes ?? "–"} icon={ClipboardList} tone="blue" />
        <KpiCard label="Réclamations ouvertes" value={d?.kpi.reclamations_ouvertes ?? "–"} icon={MessageSquareWarning} tone="yellow" />
        <KpiCard
          label="Délai moyen de traitement"
          value={formatJours(d?.kpi.delai_moyen_jours)}
          icon={Timer}
          tone="green"
          hint={d && `Demandes ${formatJours(d.delais_moyens_jours.demandes)} · Réclamations ${formatJours(d.delais_moyens_jours.reclamations)}`}
        />
        <KpiCard
          label="Réclamations critiques"
          value={d?.kpi.critiques_ouvertes ?? "–"}
          icon={AlertOctagon}
          tone="red"
          highlight={Boolean(d?.kpi.critiques_ouvertes)}
          hint={
            d?.kpi.critiques_ouvertes ? (
              <Link href="/rh/reclamations/?urgence=CRITIQUE&ouverts=true" className="font-medium text-red-600 hover:underline">
                Traiter en priorité →
              </Link>
            ) : "Aucune en attente"
          }
        />
      </div>

      {loading && !d ? (
        <div className="mt-6"><LoadingBlock rows={6} /></div>
      ) : d && (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <ChartCard title="Dossiers par statut" subtitle="Demandes et réclamations, toutes périodes">
              <GroupedBarChart
                data={d.par_statut.map((s) => ({ ...s, label: STATUT_LABELS[s.statut] }))}
                xKey="label"
                stacked
                series={[
                  { key: "demandes", label: "Demandes", color: WM.blue },
                  { key: "reclamations", label: "Réclamations", color: WM.yellow },
                ]}
              />
            </ChartCard>
            <ChartCard title="Demandes ouvertes par type">
              <HBarChart data={d.demandes_ouvertes_par_type.map((t) => ({ ...t, label: TYPES_DEMANDE[t.type] ?? t.type }))} labelKey="label" />
            </ChartCard>
          </div>

          <section className="mt-6 rounded-xl border bg-card shadow-xs">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
              <h2 className="flex items-center gap-2 font-semibold"><Inbox className="size-4 text-wm-blue" /> Derniers dossiers reçus</h2>
              <div className="flex gap-3 text-sm">
                <Link href="/rh/demandes/" className="font-medium text-wm-blue hover:underline">Demandes</Link>
                <Link href="/rh/reclamations/" className="font-medium text-wm-blue hover:underline">Réclamations</Link>
                <Link href="/rh/suggestions/" className="inline-flex items-center gap-1 font-medium text-wm-blue hover:underline">
                  <Lightbulb className="size-3.5" /> Suggestions ({d.kpi.suggestions_ouvertes})
                </Link>
              </div>
            </header>
            <ul className="divide-y">
              {d.derniers_tickets.map((t) => (
                <li key={`${t.kind}-${t.id}`}>
                  <Link href={ticketHref("rh", t.kind, t.id)} className="flex flex-col gap-1 px-5 py-3.5 transition hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-4">
                    <div className="flex items-center gap-2 sm:w-44">
                      <span className="font-mono text-xs font-semibold text-wm-blue">{t.numero}</span>
                      {t.niveau_urgence && <UrgencyBadge urgence={t.niveau_urgence} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.objet}</p>
                      <p className="text-xs text-muted-foreground">
                        {KINDS[t.kind].label} · {typeLabel(t.kind, t.type)} · {t.prenom} {t.nom} ({t.matricule}) · {t.site}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">{timeAgo(t.date_creation)}</span>
                      <StatusBadge statut={t.statut} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

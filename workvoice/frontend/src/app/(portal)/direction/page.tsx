"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertOctagon, CalendarDays, CheckCircle2, ClipboardList, EyeOff, MessageSquareWarning, Timer, TrendingDown, TrendingUp } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { CATEGORIES, MOIS_COURTS, URGENCE_LABELS } from "@/lib/constants";
import { formatJours } from "@/lib/format";
import { NativeSelect, PageHeader } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import { ChartCard, DonutChart, GroupedBarChart, HBarChart, TrendChart, WM } from "@/components/charts/charts";
import type { Urgence } from "@/types";

interface DirDashboard {
  kpi: {
    total_reclamations: number;
    total_demandes: number;
    temps_moyen_traitement_jours: number | null;
    reclamations_ce_mois: number;
    reclamations_mois_precedent: number;
    reclamations_ouvertes: number;
    critiques_ouvertes: number;
    taux_resolution: number;
  };
  temps_moyen_jours: { reclamations: number | null; demandes: number | null };
}

interface DirStats {
  reclamations_par_service: { service: string; total: number }[];
  reclamations_par_categorie: { categorie: string; total: number }[];
  reclamations_par_site: { site: string; total: number }[];
  reclamations_par_departement: { departement: string; total: number }[];
  reclamations_par_urgence: { niveau_urgence: Urgence; total: number }[];
  evolution_mensuelle: { mois: number; reclamations: number | null; demandes: number | null }[];
  temps_moyen_mensuel: { mois: number; reclamations: number | null; demandes: number | null }[];
}

const CURRENT_YEAR = new Date().getFullYear();

export default function DirectionDashboard() {
  const [annee, setAnnee] = useState(CURRENT_YEAR);
  const dash = useApi<{ data: DirDashboard }>("/direction/dashboard");
  const stats = useApi<{ data: DirStats }>(`/direction/stats?annee=${annee}`);
  const k = dash.data?.data.kpi;
  const s = stats.data?.data;

  const trend = k ? k.reclamations_ce_mois - k.reclamations_mois_precedent : 0;
  const withMonth = <T extends { mois: number }>(rows: T[]) => rows.map((r) => ({ ...r, label: MOIS_COURTS[r.mois - 1] }));

  if (dash.error) return <ErrorState message={dash.error.message} onRetry={dash.reload} />;

  return (
    <>
      <PageHeader
        title="Tableau de bord exécutif"
        description={
          <span className="inline-flex items-center gap-1.5">
            <EyeOff className="size-3.5 text-amber-600" /> Données anonymisées : aucune information permettant d&apos;identifier un collaborateur.
          </span>
        }
        actions={
          <NativeSelect value={annee} onChange={(e) => setAnnee(Number(e.target.value))} className="w-32" aria-label="Année">
            {[CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2].map((y) => <option key={y} value={y}>{y}</option>)}
          </NativeSelect>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total réclamations" value={k?.total_reclamations ?? "–"} icon={MessageSquareWarning} tone="blue" hint={k && `${k.reclamations_ouvertes} en cours de traitement`} />
        <KpiCard label="Total demandes RH" value={k?.total_demandes ?? "–"} icon={ClipboardList} tone="yellow" />
        <KpiCard
          label="Temps moyen de traitement"
          value={formatJours(k?.temps_moyen_traitement_jours)}
          icon={Timer}
          tone="green"
          hint={dash.data && `Réclamations ${formatJours(dash.data.data.temps_moyen_jours.reclamations)} · Demandes ${formatJours(dash.data.data.temps_moyen_jours.demandes)}`}
        />
        <KpiCard
          label="Réclamations ce mois"
          value={k?.reclamations_ce_mois ?? "–"}
          icon={CalendarDays}
          tone="slate"
          hint={
            k && (
              <span className={`inline-flex items-center gap-1 font-medium ${trend > 0 ? "text-red-600" : "text-emerald-600"}`}>
                {trend > 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
                {trend > 0 ? "+" : ""}{trend} vs mois précédent ({k.reclamations_mois_precedent})
              </span>
            )
          }
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Link
          href="/direction/reclamations/?urgence=CRITIQUE"
          className={`flex items-center gap-4 rounded-xl border p-4 transition hover:shadow-md ${k?.critiques_ouvertes ? "border-red-200 bg-red-50" : "bg-card"}`}
        >
          <AlertOctagon className={`size-8 ${k?.critiques_ouvertes ? "text-red-600" : "text-slate-400"}`} />
          <div>
            <p className="text-2xl font-bold">{k?.critiques_ouvertes ?? "–"}</p>
            <p className="text-sm text-muted-foreground">Réclamations critiques non résolues</p>
          </div>
        </Link>
        <div className="flex items-center gap-4 rounded-xl border bg-card p-4">
          <CheckCircle2 className="size-8 text-emerald-600" />
          <div className="flex-1">
            <p className="text-2xl font-bold">{k ? `${k.taux_resolution} %` : "–"}</p>
            <p className="text-sm text-muted-foreground">Taux de résolution des réclamations</p>
          </div>
          <div className="hidden h-2 w-32 overflow-hidden rounded-full bg-slate-100 sm:block">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${k?.taux_resolution ?? 0}%` }} />
          </div>
        </div>
      </div>

      {stats.error ? (
        <div className="mt-6"><ErrorState message={stats.error.message} onRetry={stats.reload} /></div>
      ) : !s ? (
        <div className="mt-6"><LoadingBlock rows={8} /></div>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <ChartCard title="Évolution mensuelle" subtitle={`Nombre de dossiers déposés en ${annee}`} className="lg:col-span-2">
            <TrendChart
              data={withMonth(s.evolution_mensuelle)}
              xKey="label"
              series={[
                { key: "reclamations", label: "Réclamations", color: WM.blue },
                { key: "demandes", label: "Demandes RH", color: WM.yellow },
              ]}
            />
          </ChartCard>
          <ChartCard title="Réclamations par service" subtitle="« Non communiqué » = réclamations confidentielles">
            <HBarChart data={s.reclamations_par_service} labelKey="service" />
          </ChartCard>
          <ChartCard title="Réclamations par catégorie">
            <DonutChart data={s.reclamations_par_categorie.map((c) => ({ ...c, label: CATEGORIES[c.categorie] ?? c.categorie }))} labelKey="label" />
          </ChartCard>
          <ChartCard title="Temps moyen de traitement" subtitle="En jours, par mois de dépôt" className="lg:col-span-2">
            <GroupedBarChart
              data={withMonth(s.temps_moyen_mensuel)}
              xKey="label"
              unit=" j"
              series={[
                { key: "reclamations", label: "Réclamations", color: WM.blue },
                { key: "demandes", label: "Demandes RH", color: WM.yellow },
              ]}
            />
          </ChartCard>
          <ChartCard title="Réclamations par site">
            <HBarChart data={s.reclamations_par_site} labelKey="site" color={WM.sky} height={220} />
          </ChartCard>
          <ChartCard title="Réclamations par niveau d'urgence">
            <GroupedBarChart
              data={s.reclamations_par_urgence.map((u) => ({ ...u, label: URGENCE_LABELS[u.niveau_urgence] }))}
              xKey="label"
              height={220}
              series={[{ key: "total", label: "Réclamations", color: WM.orange }]}
            />
          </ChartCard>
        </div>
      )}
    </>
  );
}

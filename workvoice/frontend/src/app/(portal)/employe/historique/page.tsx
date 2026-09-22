"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { KINDS, STATUTS, STATUT_LABELS, typeLabel } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/common/badges";
import { NativeSelect, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { ticketHref } from "@/components/tickets/ticket-page";
import { Input } from "@/components/ui/input";
import type { Kind, TicketSummary } from "@/types";

const TABS: { value: Kind | ""; label: string }[] = [
  { value: "", label: "Tous" },
  { value: "demande", label: "Demandes RH" },
  { value: "reclamation", label: "Réclamations" },
  { value: "suggestion", label: "Suggestions" },
];

export default function HistoriquePage() {
  const [kind, setKind] = useState<Kind | "">("");
  const [statut, setStatut] = useState("");
  const [q, setQ] = useState("");

  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (statut) params.set("statut", statut);
  const { data, error, loading, reload } = useApi<{ data: TicketSummary[] }>(`/me/historique?${params}`);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = data?.data ?? [];
    return needle ? all.filter((t) => `${t.numero} ${t.objet}`.toLowerCase().includes(needle)) : all;
  }, [data, q]);

  return (
    <>
      <PageHeader title="Historique de mes demandes" description="Toutes vos demandes, réclamations et suggestions." />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setKind(t.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition",
                kind === t.value ? "bg-white text-wm-blue shadow-sm" : "text-slate-600 hover:text-slate-900",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1 lg:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher…" className="h-9 bg-white pl-9" aria-label="Rechercher" />
          </div>
          <NativeSelect value={statut} onChange={(e) => setStatut(e.target.value)} className="w-40" aria-label="Filtrer par statut">
            <option value="">Tous statuts</option>
            {STATUTS.map((s) => (
              <option key={s} value={s}>{STATUT_LABELS[s]}</option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : loading && !data ? (
        <LoadingBlock rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="Aucun dossier trouvé" description="Modifiez les filtres ou créez une nouvelle demande." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="hidden bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase md:table-header-group">
              <tr>
                <th className="px-5 py-3">Référence</th>
                <th className="px-5 py-3">Objet</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Statut</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((t) => (
                <tr key={`${t.kind}-${t.id}`} className="group relative flex flex-col gap-1 px-4 py-3 transition hover:bg-slate-50 md:table-row md:p-0">
                  <td className="md:px-5 md:py-3.5">
                    <Link href={ticketHref("employe", t.kind, t.id)} className="font-mono text-xs font-semibold text-wm-blue after:absolute after:inset-0">
                      {t.numero}
                    </Link>
                    <span className="ml-2 text-xs text-muted-foreground md:hidden">{KINDS[t.kind].label}</span>
                  </td>
                  <td className="font-medium text-slate-800 md:max-w-xs md:truncate md:px-5">{t.objet}</td>
                  <td className="text-xs text-muted-foreground md:px-5 md:text-sm">
                    <span className="hidden md:inline">{KINDS[t.kind].label} · </span>
                    {typeLabel(t.kind, t.type)}
                  </td>
                  <td className="text-xs text-muted-foreground md:px-5 md:text-sm">{formatDate(t.date_creation)}</td>
                  <td className="md:px-5"><StatusBadge statut={t.statut} /></td>
                  <td className="hidden pr-4 md:table-cell"><ChevronRight className="size-4 text-slate-300 group-hover:text-wm-blue" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

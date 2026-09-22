"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Lock, MessageCircle, Search, X } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { KINDS, STATUTS, STATUT_LABELS, URGENCES, URGENCE_LABELS, typeLabel } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusBadge, UrgencyBadge } from "@/components/common/badges";
import { NativeSelect, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { ticketHref } from "@/components/tickets/ticket-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Kind, Paged, Ticket } from "@/types";

type Filters = { statut: string; type: string; urgence: string; site: string; departement: string; q: string; ouverts: string };
const EMPTY: Filters = { statut: "", type: "", urgence: "", site: "", departement: "", q: "", ouverts: "" };

function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function List({ kind }: { kind: Kind }) {
  const params = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => ({
    ...EMPTY,
    ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, params.get(k) ?? ""])),
  }));
  const [page, setPage] = useState(1);
  const q = useDebounced(filters.q);

  const { data: ref } = useApi<{ data: { sites: string[]; departements: string[] } }>("/rh/referentiels");

  const query = new URLSearchParams({ page: String(page), pageSize: "15" });
  for (const [k, v] of Object.entries({ ...filters, q })) if (v) query.set(k, v);
  const { data, error, loading, reload } = useApi<Paged<Ticket>>(`/rh/${KINDS[kind].api}?${query}`);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  const active = Object.entries(filters).some(([, v]) => v);
  const isRec = kind === "reclamation";

  return (
    <>
      <PageHeader
        title={KINDS[kind].plural}
        description={data ? `${data.total} dossier${data.total > 1 ? "s" : ""}${active ? " correspondant aux filtres" : ""}` : " "}
      />

      <div className="mb-4 grid gap-2 rounded-xl border bg-card p-3 shadow-xs sm:grid-cols-2 lg:grid-cols-[1.6fr_repeat(5,1fr)_auto]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filters.q} onChange={set("q")} placeholder="Réf., objet, nom, matricule…" className="h-9 pl-9" aria-label="Rechercher" />
        </div>
        <NativeSelect value={filters.statut} onChange={set("statut")} aria-label="Statut">
          <option value="">Tous statuts</option>
          {STATUTS.map((s) => <option key={s} value={s}>{STATUT_LABELS[s]}</option>)}
        </NativeSelect>
        <NativeSelect value={filters.type} onChange={set("type")} aria-label="Type">
          <option value="">{isRec ? "Toutes catégories" : kind === "suggestion" ? "Tous thèmes" : "Tous types"}</option>
          {Object.entries(KINDS[kind].types).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </NativeSelect>
        {isRec ? (
          <NativeSelect value={filters.urgence} onChange={set("urgence")} aria-label="Urgence">
            <option value="">Toutes urgences</option>
            {URGENCES.map((u) => <option key={u} value={u}>{URGENCE_LABELS[u]}</option>)}
          </NativeSelect>
        ) : (
          <NativeSelect value={filters.ouverts} onChange={set("ouverts")} aria-label="Ouverts">
            <option value="">Ouverts et traités</option>
            <option value="true">Ouverts uniquement</option>
          </NativeSelect>
        )}
        <NativeSelect value={filters.site} onChange={set("site")} aria-label="Site">
          <option value="">Tous sites</option>
          {ref?.data.sites.map((s) => <option key={s}>{s}</option>)}
        </NativeSelect>
        <NativeSelect value={filters.departement} onChange={set("departement")} aria-label="Département">
          <option value="">Tous départements</option>
          {ref?.data.departements.map((s) => <option key={s}>{s}</option>)}
        </NativeSelect>
        <Button variant="ghost" size="lg" disabled={!active} onClick={() => { setFilters(EMPTY); setPage(1); }}>
          <X className="size-4" /> Réinitialiser
        </Button>
      </div>

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data && loading ? (
        <LoadingBlock rows={8} />
      ) : !data?.data.length ? (
        <EmptyState title="Aucun dossier" description="Aucun dossier ne correspond à ces critères." />
      ) : (
        <div className={cn("overflow-hidden rounded-xl border bg-card shadow-xs transition", loading && "opacity-60")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Référence</th>
                  <th className="px-4 py-3">Objet</th>
                  <th className="px-4 py-3">Collaborateur</th>
                  <th className="px-4 py-3">Site</th>
                  {isRec && <th className="px-4 py-3">Urgence</th>}
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Statut</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.data.map((t) => (
                  <tr key={t.id} className={cn("group relative transition hover:bg-slate-50", t.niveau_urgence === "CRITIQUE" && !["RESOLU", "CLOTURE"].includes(t.statut) && "bg-red-50/40")}>
                    <td className="px-4 py-3">
                      <Link href={ticketHref("rh", kind, t.id)} className="font-mono text-xs font-semibold text-wm-blue after:absolute after:inset-0">
                        {t.numero}
                      </Link>
                    </td>
                    <td className="max-w-[280px] px-4 py-3">
                      <p className="flex items-center gap-1.5 truncate font-medium text-slate-800">
                        {t.confidentielle && <Lock className="size-3.5 shrink-0 text-amber-600" aria-label="Confidentielle" />}
                        {t.objet}
                      </p>
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        {typeLabel(kind, t.type)}
                        {Boolean(t.nb_commentaires) && (
                          <span className="inline-flex items-center gap-0.5"><MessageCircle className="size-3" />{t.nb_commentaires}</span>
                        )}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium whitespace-nowrap">{t.auteur?.prenom} {t.auteur?.nom}</p>
                      <p className="text-xs text-muted-foreground">{t.auteur?.matricule} · {t.auteur?.service}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{t.auteur?.site}</td>
                    {isRec && <td className="px-4 py-3">{t.niveau_urgence && <UrgencyBadge urgence={t.niveau_urgence} />}</td>}
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatDate(t.date_creation)}</td>
                    <td className="px-4 py-3"><StatusBadge statut={t.statut} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">Page {data.page} sur {data.pages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="size-4" /> Précédent
              </Button>
              <Button variant="outline" size="sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
                Suivant <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function RhTicketList({ kind }: { kind: Kind }) {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <List kind={kind} />
    </Suspense>
  );
}

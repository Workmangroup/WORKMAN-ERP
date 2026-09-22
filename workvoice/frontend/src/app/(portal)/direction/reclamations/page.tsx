"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Building2, ChevronLeft, ChevronRight, EyeOff, MapPin, Search, Users, X } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { CATEGORIES, STATUTS, STATUT_LABELS, URGENCES, URGENCE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusBadge, UrgencyBadge } from "@/components/common/badges";
import { NativeSelect, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DirectionReclamation, Paged } from "@/types";

type Filters = { categorie: string; urgence: string; statut: string; site: string; departement: string; q: string };
const EMPTY: Filters = { categorie: "", urgence: "", statut: "", site: "", departement: "", q: "" };

function List() {
  const params = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => ({ ...EMPTY, urgence: params.get("urgence") ?? "" }));
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setQ(filters.q), 350);
    return () => clearTimeout(t);
  }, [filters.q]);

  const { data: ref } = useApi<{ data: { sites: string[]; departements: string[] } }>("/direction/referentiels");
  const query = new URLSearchParams({ page: String(page), pageSize: "12" });
  for (const [k, v] of Object.entries({ ...filters, q })) if (v) query.set(k, v);
  const { data, error, loading, reload } = useApi<Paged<DirectionReclamation>>(`/direction/reclamations?${query}`);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setFilters((f) => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };
  const active = Object.values(filters).some(Boolean);

  return (
    <>
      <PageHeader
        title="Réclamations"
        description={
          <span className="inline-flex items-center gap-1.5">
            <EyeOff className="size-3.5 text-amber-600" /> Vue anonymisée{data ? ` · ${data.total} réclamation${data.total > 1 ? "s" : ""}` : ""}
          </span>
        }
      />

      <div className="mb-4 grid gap-2 rounded-xl border bg-card p-3 shadow-xs sm:grid-cols-2 lg:grid-cols-[1.5fr_repeat(5,1fr)_auto]">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filters.q} onChange={set("q")} placeholder="Référence, contenu…" className="h-9 pl-9" aria-label="Rechercher" />
        </div>
        <NativeSelect value={filters.categorie} onChange={set("categorie")} aria-label="Catégorie">
          <option value="">Toutes catégories</option>
          {Object.entries(CATEGORIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </NativeSelect>
        <NativeSelect value={filters.urgence} onChange={set("urgence")} aria-label="Urgence">
          <option value="">Toutes urgences</option>
          {URGENCES.map((u) => <option key={u} value={u}>{URGENCE_LABELS[u]}</option>)}
        </NativeSelect>
        <NativeSelect value={filters.statut} onChange={set("statut")} aria-label="Statut">
          <option value="">Tous statuts</option>
          {STATUTS.map((s) => <option key={s} value={s}>{STATUT_LABELS[s]}</option>)}
        </NativeSelect>
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
        <LoadingBlock rows={6} />
      ) : !data?.data.length ? (
        <EmptyState title="Aucune réclamation" description="Aucune réclamation ne correspond à ces critères." />
      ) : (
        <>
          <div className={cn("grid gap-4 md:grid-cols-2 xl:grid-cols-3", loading && "opacity-60")}>
            {data.data.map((r) => (
              <Link
                key={r.id}
                href={`/direction/reclamation/?id=${r.id}`}
                className={cn(
                  "group flex flex-col rounded-xl border bg-card p-5 shadow-xs transition hover:-translate-y-0.5 hover:shadow-md",
                  r.niveau_urgence === "CRITIQUE" && "border-red-200",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-wm-blue">#{r.numero}</span>
                  <UrgencyBadge urgence={r.niveau_urgence} />
                </div>
                <p className="mt-3 text-xs font-medium tracking-wide text-amber-700 uppercase">{CATEGORIES[r.categorie]}</p>
                <p className="mt-1 line-clamp-1 font-semibold text-slate-900">{r.objet}</p>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{r.description}</p>
                <div className="mt-4 space-y-1 border-t pt-3 text-xs text-slate-600">
                  <p className="flex items-center gap-1.5"><Building2 className="size-3.5 text-muted-foreground" /> {r.departement}</p>
                  <p className="flex items-center gap-1.5"><Users className="size-3.5 text-muted-foreground" /> {r.service}</p>
                  <p className="flex items-center gap-1.5"><MapPin className="size-3.5 text-muted-foreground" /> {r.site}</p>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{formatDate(r.date_creation)}</span>
                  <StatusBadge statut={r.statut} />
                </div>
              </Link>
            ))}
          </div>
          <div className="mt-5 flex items-center justify-between text-sm">
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
        </>
      )}
    </>
  );
}

export default function DirectionReclamationsPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={6} />}>
      <List />
    </Suspense>
  );
}

"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Building2, CalendarDays, CheckCircle2, EyeOff, MapPin, Users } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { CATEGORIES } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { ConfidentialBadge, StatusBadge, UrgencyBadge } from "@/components/common/badges";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import type { DirectionReclamation } from "@/types";

function Detail() {
  const id = Number(useSearchParams().get("id"));
  const { data, error, loading, reload } = useApi<{ data: DirectionReclamation }>(
    Number.isInteger(id) && id > 0 ? `/direction/reclamations/${id}` : null,
  );

  if (!Number.isInteger(id) || id <= 0) return <ErrorState message="Lien invalide : réclamation introuvable." />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (loading || !data) return <LoadingBlock rows={5} />;
  const r = data.data;

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/direction/reclamations/" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-wm-blue">
        <ArrowLeft className="size-4" /> Retour aux réclamations
      </Link>

      <article className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <header className="bg-wm-blue px-6 py-5 text-white">
          <p className="text-sm text-blue-100/80">Réclamation</p>
          <h1 className="font-mono text-2xl font-bold">#{r.numero}</h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <UrgencyBadge urgence={r.niveau_urgence} />
            <StatusBadge statut={r.statut} />
            {r.confidentielle && <ConfidentialBadge />}
          </div>
        </header>

        <div className="grid gap-px bg-border sm:grid-cols-3">
          {[
            { icon: Building2, label: "Département", value: r.departement },
            { icon: Users, label: "Service", value: r.service },
            { icon: MapPin, label: "Site", value: r.site },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="bg-white px-6 py-4">
              <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <Icon className="size-3.5" /> {label}
              </p>
              <p className="mt-1 font-semibold text-slate-900">{value}</p>
            </div>
          ))}
        </div>

        <div className="space-y-5 px-6 py-6">
          <div>
            <p className="text-xs font-medium tracking-wide text-amber-700 uppercase">{CATEGORIES[r.categorie]}</p>
            <h2 className="mt-1 text-lg font-semibold">{r.objet}</h2>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Contenu</p>
            <p className="rounded-lg bg-slate-50 p-4 leading-relaxed whitespace-pre-wrap text-slate-800">{r.description}</p>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-slate-600">
            <span className="flex items-center gap-1.5"><CalendarDays className="size-4 text-muted-foreground" /> Déposée le {formatDateTime(r.date_creation)}</span>
            {r.date_cloture && (
              <span className="flex items-center gap-1.5"><CheckCircle2 className="size-4 text-emerald-600" /> Traitée le {formatDateTime(r.date_cloture)}</span>
            )}
          </div>
        </div>

        <footer className="flex items-start gap-2 border-t bg-wm-yellow-50 px-6 py-4 text-xs text-amber-900">
          <EyeOff className="size-4 shrink-0" />
          L&apos;identité du collaborateur n&apos;est connue que du service RH.
          {r.confidentielle && " Réclamation confidentielle : le service est également masqué."}
        </footer>
      </article>
    </div>
  );
}

export default function DirectionReclamationPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={5} />}>
      <Detail />
    </Suspense>
  );
}

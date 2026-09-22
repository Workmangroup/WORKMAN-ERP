"use client";

import { useEffect, useState } from "react";
import { EyeOff } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { CampagnesTable } from "@/components/questionnaire/campagnes-table";
import { ResultatsQuestionnaire } from "@/components/questionnaire/resultats";
import type { Campagne } from "@/types";

export default function DirectionQuestionnairePage() {
  const { data, error, loading, reload } = useApi<{ data: Campagne[] }>("/questionnaire/campagnes");
  const [selected, setSelected] = useState<number | null>(null);
  const campagnes = data?.data ?? [];

  useEffect(() => {
    if (selected === null && campagnes.length) setSelected(campagnes[0].id);
  }, [campagnes, selected]);

  const current = campagnes.find((c) => c.id === selected);

  return (
    <>
      <PageHeader
        title="Satisfaction du personnel"
        description={
          <span className="inline-flex items-center gap-1.5">
            <EyeOff className="size-3.5 text-amber-600" /> Résultats agrégés et anonymes · questionnaire GRH-IFD-23
          </span>
        }
      />
      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : loading && !data ? (
        <LoadingBlock rows={4} />
      ) : !campagnes.length ? (
        <EmptyState title="Aucune campagne" description="Le service RH n'a pas encore lancé de questionnaire." />
      ) : (
        <>
          <CampagnesTable campagnes={campagnes} selectedId={selected} onSelect={setSelected} />
          {current && (
            <div className="mt-8">
              <h2 className="mb-4 text-lg font-semibold">Résultats — {current.titre}</h2>
              <ResultatsQuestionnaire key={current.id} campagneId={current.id} />
            </div>
          )}
        </>
      )}
    </>
  );
}

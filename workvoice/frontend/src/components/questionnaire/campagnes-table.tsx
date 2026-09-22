"use client";

import { Lock, Play } from "lucide-react";
import { CAMPAGNE_STATUT } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { indiceTone } from "@/components/questionnaire/resultats";
import { Button } from "@/components/ui/button";
import type { Campagne } from "@/types";

export function CampagneStatutBadge({ statut }: { statut?: string }) {
  const s = CAMPAGNE_STATUT[statut ?? "BROUILLON"];
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", s.style)}>{s.label}</span>;
}

/** Tableau des campagnes. `onStatut` absent = lecture seule (Direction). */
export function CampagnesTable({
  campagnes,
  selectedId,
  onSelect,
  onStatut,
}: {
  campagnes: Campagne[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onStatut?: (c: Campagne, statut: "OUVERTE" | "CLOTUREE") => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-4 py-3">Campagne</th>
              <th className="px-4 py-3">Période</th>
              <th className="px-4 py-3">Statut</th>
              <th className="px-4 py-3 text-right">Réponses</th>
              <th className="px-4 py-3 text-right">Indice</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {campagnes.map((c) => (
              <tr
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={cn("cursor-pointer transition hover:bg-slate-50", selectedId === c.id && "bg-wm-blue-50/60 hover:bg-wm-blue-50")}
              >
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-800">{c.titre}</p>
                  <p className="text-xs text-muted-foreground">{c.reference}</p>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                  {formatDate(c.date_debut)} → {c.date_fin ? formatDate(c.date_fin) : "…"}
                </td>
                <td className="px-4 py-3"><CampagneStatutBadge statut={c.statut} /></td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <span className="font-semibold">{c.nb_reponses}</span>
                  <span className="text-muted-foreground"> / {c.effectif} · {c.taux_participation} %</span>
                </td>
                <td className={cn("px-4 py-3 text-right text-base font-bold tabular-nums", indiceTone(c.indice_satisfaction))}>
                  {c.indice_satisfaction ?? "–"}
                </td>
                <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {onStatut && c.statut !== "OUVERTE" && (
                    <Button size="sm" variant="outline" onClick={() => onStatut(c, "OUVERTE")}>
                      <Play className="size-3.5" /> {c.statut === "CLOTUREE" ? "Rouvrir" : "Ouvrir"}
                    </Button>
                  )}
                  {onStatut && c.statut === "OUVERTE" && (
                    <Button size="sm" variant="outline" onClick={() => onStatut(c, "CLOTUREE")}>
                      <Lock className="size-3.5" /> Clôturer
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

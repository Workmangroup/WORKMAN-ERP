import { AlertTriangle, Sparkles } from "lucide-react";
import { AlerteBadge } from "@/components/common/badges";
import type { Alerte } from "@/types";

/** Liste d'alertes issues de l'analyse IA (règles statistiques) d'un module RH. */
export function AlertesPanel({ alertes, title = "Analyse & alertes" }: { alertes: Alerte[]; title?: string }) {
  return (
    <section className="rounded-xl border bg-card shadow-xs">
      <header className="flex items-center gap-2 border-b px-5 py-4">
        <Sparkles className="size-4 text-wm-blue" />
        <h2 className="font-semibold">{title}</h2>
      </header>
      <ul className="divide-y">
        {alertes.length === 0 && (
          <li className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
            <AlertTriangle className="size-4" /> Aucune alerte détectée pour le moment.
          </li>
        )}
        {alertes.map((a, i) => (
          <li key={i} className="flex items-start gap-3 px-5 py-3">
            <AlerteBadge niveau={a.niveau} className="mt-0.5 shrink-0" />
            <p className="text-sm text-slate-700">{a.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

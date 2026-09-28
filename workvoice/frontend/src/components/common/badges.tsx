import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { ABSENCE_STATUT_LABELS, ABSENCE_STATUT_STYLES, ALERTE_NIVEAU_STYLES, ATTESTATION_STATUT_LABELS, ATTESTATION_STATUT_STYLES, STATUT_LABELS, STATUT_STYLES, URGENCE_LABELS, URGENCE_STYLES } from "@/lib/constants";
import type { AbsenceStatut, AttestationStatut, Statut, Urgence } from "@/types";

const base = "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";

export function StatusBadge({ statut, className }: { statut: Statut; className?: string }) {
  return <span className={cn(base, STATUT_STYLES[statut], className)}>{STATUT_LABELS[statut]}</span>;
}

export function UrgencyBadge({ urgence, className }: { urgence: Urgence; className?: string }) {
  return (
    <span className={cn(base, URGENCE_STYLES[urgence], className)}>
      {urgence === "CRITIQUE" && <span className="size-1.5 animate-pulse rounded-full bg-white" />}
      {URGENCE_LABELS[urgence]}
    </span>
  );
}

export function ConfidentialBadge({ className }: { className?: string }) {
  return (
    <span className={cn(base, "bg-wm-yellow-50 text-amber-900 ring-amber-500/30", className)}>
      <Lock className="size-3" /> Confidentielle
    </span>
  );
}

/** Statut des modules Congés / Sorties / Retards (Brouillon, En attente, Validé, Refusé, Annulé). */
export function AbsenceStatusBadge({ statut, className }: { statut: AbsenceStatut; className?: string }) {
  return <span className={cn(base, ABSENCE_STATUT_STYLES[statut], className)}>{ABSENCE_STATUT_LABELS[statut]}</span>;
}

export function AttestationStatusBadge({ statut, className }: { statut: AttestationStatut; className?: string }) {
  return <span className={cn(base, ATTESTATION_STATUT_STYLES[statut], className)}>{ATTESTATION_STATUT_LABELS[statut]}</span>;
}

export function AlerteBadge({ niveau, className }: { niveau: string; className?: string }) {
  return <span className={cn(base, ALERTE_NIVEAU_STYLES[niveau] ?? ALERTE_NIVEAU_STYLES.INFO, className)}>{niveau}</span>;
}

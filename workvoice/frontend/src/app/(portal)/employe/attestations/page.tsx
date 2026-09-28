"use client";

import { useState } from "react";
import { CheckCircle2, FilePlus2, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { ATTESTATION_TYPE_LABELS } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { AttestationStatusBadge } from "@/components/common/badges";
import { Field, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AttestationRequest, AttestationType } from "@/types";

const TYPES: { value: AttestationType; label: string }[] = [
  { value: "ATTESTATION_TRAVAIL", label: "Attestation de travail" },
  { value: "ATTESTATION_SALAIRE", label: "Attestation de salaire" },
];

export default function MesAttestationsPage() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<{ data: AttestationRequest[] }>("/me/attestations");
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<AttestationType | "">("");
  const [commentaire, setCommentaire] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!type) {
      setErrors({ type: "Choisissez un type d'attestation" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<{ data: { numero: string } }>("/me/attestations", { method: "POST", body: { type, commentaire: commentaire.trim() || undefined } });
      toast.success(`Demande ${res.data.numero} envoyée`);
      setShowForm(false);
      setType(""); setCommentaire(""); setErrors({});
      reload();
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.fieldErrors()); toast.error(err.message); }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Mes demandes RH"
        description="Demandez une attestation officielle, générée et remise par le service RH."
        actions={!showForm && <Button onClick={() => setShowForm(true)}><FilePlus2 className="size-4" /> Demander une attestation</Button>}
      />

      {/* Données RH affichées en lecture seule : le collaborateur ne peut pas les modifier. */}
      {showForm && (
        <form onSubmit={submit} noValidate className="mb-6 space-y-5 rounded-xl border border-wm-blue/20 bg-card p-5 shadow-xs sm:p-7">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Demander une attestation de travail</h2>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setShowForm(false)}><X className="size-4" /></Button>
          </div>

          <div className="grid gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
            <div><span className="text-xs text-muted-foreground uppercase">Nom</span><p className="font-medium">{user?.prenom} {user?.nom}</p></div>
            <div><span className="text-xs text-muted-foreground uppercase">Matricule</span><p className="font-medium font-mono">{user?.matricule}</p></div>
            <div><span className="text-xs text-muted-foreground uppercase">Service</span><p className="font-medium">{user?.service}</p></div>
            <div><span className="text-xs text-muted-foreground uppercase">Site</span><p className="font-medium">{user?.site}</p></div>
          </div>
          <p className="text-xs text-muted-foreground">Ces informations proviennent de votre dossier RH et ne peuvent pas être modifiées ici.</p>

          <Field id="type" label="Type d'attestation" required error={errors.type}>
            <select id="type" value={type} onChange={(e) => setType(e.target.value as AttestationType)} className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm">
              <option value="">Sélectionner…</option>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field id="commentaire" label="Précision (motif de la demande)" hint="Facultatif">
            <Textarea id="commentaire" value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={3} maxLength={1000} />
          </Field>

          <div className="flex justify-end gap-3 border-t pt-5">
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Annuler</Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Envoyer la demande
            </Button>
          </div>
        </form>
      )}

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : loading && !data ? (
        <LoadingBlock rows={3} />
      ) : !data?.data.length ? (
        <EmptyState title="Aucune demande d'attestation" description="Créez votre première demande." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <ul className="divide-y">
            {data.data.map((a) => (
              <li key={a.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-wm-blue">{a.numero}</span>
                  <AttestationStatusBadge statut={a.statut} />
                </div>
                <p className="mt-1 text-sm font-medium">{ATTESTATION_TYPE_LABELS[a.type] ?? a.type_libelle}</p>
                <p className="text-xs text-muted-foreground">Demandée le {formatDateTime(a.date_creation)}</p>

                {/* Aucun bouton télécharger / voir / imprimer / envoyer, à dessein : le collaborateur
                    ne récupère jamais le document — il se présente physiquement au service RH. */}
                {a.statut === "READY" && (
                  <p className="mt-2 flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-2.5 text-sm font-medium text-emerald-800">
                    <CheckCircle2 className="size-4" /> Votre attestation est prête. Merci de vous présenter au service RH pour récupération.
                  </p>
                )}
                {a.statut === "REJECTED" && a.rejection_reason && (
                  <p className="mt-2 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-800">Demande refusée : {a.rejection_reason}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

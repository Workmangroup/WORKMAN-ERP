"use client";

import { useState } from "react";
import { Clock, Loader2, Plus, Send, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatDuree } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/format";
import { AbsenceStatusBadge } from "@/components/common/badges";
import { Field, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Motif, SortieDemande } from "@/types";

export default function MesSortiesPage() {
  const { data: motifs } = useApi<{ data: Motif[] }>("/sorties/motifs");
  const { data, error, loading, reload } = useApi<{ data: SortieDemande[]; cumul_mois_minutes: number; cumul_annee_minutes: number }>("/me/sorties");

  const [showForm, setShowForm] = useState(false);
  const [motifId, setMotifId] = useState("");
  const [date, setDate] = useState("");
  const [heureDebut, setHeureDebut] = useState("");
  const [heureFin, setHeureFin] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!motifId) errs.motif_id = "Choisissez un motif";
    if (!date) errs.date_sortie = "Obligatoire";
    if (!heureDebut) errs.heure_debut = "Obligatoire";
    if (!heureFin) errs.heure_fin = "Obligatoire";
    if (heureDebut && heureFin && heureFin <= heureDebut) errs.heure_fin = "Doit être postérieure à l'heure de début";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSubmitting(true);
    try {
      const res = await api<{ data: { numero: string } }>("/sorties", {
        method: "POST",
        body: { motif_id: Number(motifId), date_sortie: date, heure_debut: heureDebut, heure_fin: heureFin, commentaire: commentaire.trim() || undefined },
      });
      toast.success(`Autorisation ${res.data.numero} envoyée`);
      setShowForm(false);
      setMotifId(""); setDate(""); setHeureDebut(""); setHeureFin(""); setCommentaire("");
      reload();
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.fieldErrors()); toast.error(err.message); }
    } finally {
      setSubmitting(false);
    }
  }

  async function annuler(id: number) {
    if (!window.confirm("Annuler cette demande de sortie ?")) return;
    try {
      await api(`/sorties/${id}/annuler`, { method: "POST" });
      toast.success("Demande annulée");
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible");
    }
  }

  return (
    <>
      <PageHeader
        title="Autorisations de sortie"
        description="Demandez une autorisation de sortie pendant les heures de travail."
        actions={!showForm && <Button onClick={() => setShowForm(true)}><Plus className="size-4" /> Nouvelle demande</Button>}
      />

      {data && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <div className="flex items-center gap-4 rounded-xl border bg-card p-5 shadow-xs">
            <div className="rounded-xl bg-wm-blue-50 p-3 text-wm-blue"><Clock className="size-6" /></div>
            <div><p className="text-2xl font-bold tabular-nums">{formatDuree(data.cumul_mois_minutes)}</p><p className="text-sm text-muted-foreground">Cumulé ce mois-ci</p></div>
          </div>
          <div className="flex items-center gap-4 rounded-xl border bg-card p-5 shadow-xs">
            <div className="rounded-xl bg-slate-100 p-3 text-slate-600"><Clock className="size-6" /></div>
            <div><p className="text-2xl font-bold tabular-nums">{formatDuree(data.cumul_annee_minutes)}</p><p className="text-sm text-muted-foreground">Cumulé cette année</p></div>
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={submit} noValidate className="mb-6 space-y-5 rounded-xl border border-wm-blue/20 bg-card p-5 shadow-xs sm:p-7">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Nouvelle autorisation de sortie</h2>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setShowForm(false)}><X className="size-4" /></Button>
          </div>
          <Field id="motif_id" label="Motif" required error={errors.motif_id}>
            <select id="motif_id" value={motifId} onChange={(e) => setMotifId(e.target.value)} className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm">
              <option value="">Sélectionner…</option>
              {motifs?.data.map((m) => <option key={m.id} value={m.id}>{m.libelle}</option>)}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="date_sortie" label="Date" required error={errors.date_sortie}>
              <Input id="date_sortie" type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} className="h-10" />
            </Field>
            <Field id="heure_debut" label="Heure de début" required error={errors.heure_debut}>
              <Input id="heure_debut" type="time" value={heureDebut} onChange={(e) => setHeureDebut(e.target.value)} className="h-10" />
            </Field>
            <Field id="heure_fin" label="Heure de fin" required error={errors.heure_fin}>
              <Input id="heure_fin" type="time" value={heureFin} onChange={(e) => setHeureFin(e.target.value)} className="h-10" />
            </Field>
          </div>
          <Field id="commentaire" label="Commentaire" hint="Facultatif">
            <Textarea id="commentaire" value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={3} maxLength={2000} />
          </Field>
          <div className="flex justify-end gap-3 border-t pt-5">
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Annuler</Button>
            <Button type="submit" disabled={submitting}>{submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Envoyer</Button>
          </div>
        </form>
      )}

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : loading && !data ? (
        <LoadingBlock rows={4} />
      ) : !data?.data.length ? (
        <EmptyState title="Aucune autorisation de sortie" description="Créez votre première demande." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <ul className="divide-y">
            {data.data.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-wm-blue">{s.numero}</span>
                    <AbsenceStatusBadge statut={s.statut} />
                  </div>
                  <p className="mt-1 text-sm font-medium">{s.motif_libelle} — {s.heure_debut.slice(0, 5)} à {s.heure_fin.slice(0, 5)} ({formatDuree(s.duree_minutes)})</p>
                  <p className="text-xs text-muted-foreground">Le {formatDate(s.date_sortie)} · Déposée le {formatDateTime(s.date_creation)}</p>
                  {s.motif_refus && <p className="mt-1 text-xs text-red-700">Motif du refus : {s.motif_refus}</p>}
                </div>
                {s.statut === "EN_ATTENTE" && <Button variant="outline" size="sm" onClick={() => annuler(s.id)} className="self-start sm:self-center">Annuler</Button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

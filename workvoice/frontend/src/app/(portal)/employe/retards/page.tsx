"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, Plus, Send, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { api, apiUrl, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatDate, formatDateTime } from "@/lib/format";
import { AbsenceStatusBadge } from "@/components/common/badges";
import { Field, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Motif, RetardDeclaration } from "@/types";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.doc,.docx,.zip";
const MAX_MB = 5;

export default function MesRetardsPage() {
  const { data: motifs } = useApi<{ data: Motif[] }>("/retards/motifs");
  const { data, error, loading, reload } = useApi<{ data: RetardDeclaration[] }>("/me/retards");

  const [showForm, setShowForm] = useState(false);
  const [motifId, setMotifId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [heure, setHeure] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function pickFile(f?: File) {
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) return toast.error(`Fichier trop volumineux (max ${MAX_MB} Mo)`);
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!motifId) errs.motif_id = "Choisissez un motif";
    if (!date) errs.date_retard = "Obligatoire";
    if (!heure) errs.heure_arrivee = "Obligatoire";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSubmitting(true);
    const form = new FormData();
    form.append("motif_id", motifId);
    form.append("date_retard", date);
    form.append("heure_arrivee", heure);
    if (commentaire.trim()) form.append("commentaire", commentaire.trim());
    if (file) form.append("piece_jointe", file);
    try {
      const res = await api<{ data: { numero: string } }>("/retards", { method: "POST", body: form });
      toast.success(`Déclaration ${res.data.numero} envoyée`);
      setShowForm(false);
      setMotifId(""); setHeure(""); setCommentaire(""); setFile(null);
      reload();
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.fieldErrors()); toast.error(err.message); }
    } finally {
      setSubmitting(false);
    }
  }

  async function annuler(id: number) {
    if (!window.confirm("Annuler cette déclaration de retard ?")) return;
    try {
      await api(`/retards/${id}/annuler`, { method: "POST" });
      toast.success("Déclaration annulée");
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible");
    }
  }

  return (
    <>
      <PageHeader
        title="Mes retards"
        description="Déclarez un retard et son motif."
        actions={!showForm && <Button onClick={() => setShowForm(true)}><Plus className="size-4" /> Déclarer un retard</Button>}
      />

      {showForm && (
        <form onSubmit={submit} noValidate className="mb-6 space-y-5 rounded-xl border border-wm-blue/20 bg-card p-5 shadow-xs sm:p-7">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Nouvelle déclaration de retard</h2>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setShowForm(false)}><X className="size-4" /></Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="date_retard" label="Date" required error={errors.date_retard}>
              <Input id="date_retard" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} className="h-10" />
            </Field>
            <Field id="heure_arrivee" label="Heure d'arrivée" required error={errors.heure_arrivee}>
              <Input id="heure_arrivee" type="time" value={heure} onChange={(e) => setHeure(e.target.value)} className="h-10" />
            </Field>
          </div>
          <Field id="motif_id" label="Motif" required error={errors.motif_id}>
            <select id="motif_id" value={motifId} onChange={(e) => setMotifId(e.target.value)} className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm">
              <option value="">Sélectionner…</option>
              {motifs?.data.map((m) => <option key={m.id} value={m.id}>{m.libelle}</option>)}
            </select>
          </Field>
          <Field id="commentaire" label="Commentaire" hint="Facultatif">
            <Textarea id="commentaire" value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={3} maxLength={2000} />
          </Field>
          <Field id="piece_jointe" label="Pièce jointe" hint={`Facultatif · PDF, JPG, PNG, DOC, DOCX, ZIP · ${MAX_MB} Mo max`}>
            {file ? (
              <div className="flex items-center gap-3 rounded-lg border bg-slate-50 px-4 py-3">
                <FileText className="size-5 text-wm-blue" />
                <p className="flex-1 truncate text-sm font-medium">{file.name}</p>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setFile(null)}><X className="size-4" /></Button>
              </div>
            ) : (
              <button type="button" onClick={() => fileRef.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 px-4 py-4 text-sm hover:border-wm-blue hover:bg-slate-50">
                <Upload className="size-4 text-wm-blue" /> Choisir un fichier
              </button>
            )}
            <input ref={fileRef} id="piece_jointe" type="file" accept={ACCEPT} className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
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
        <EmptyState title="Aucun retard déclaré" description="Vos déclarations de retard apparaîtront ici." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <ul className="divide-y">
            {data.data.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-wm-blue">{r.numero}</span>
                    <AbsenceStatusBadge statut={r.statut} />
                  </div>
                  <p className="mt-1 text-sm font-medium">{r.motif_libelle} — arrivée à {r.heure_arrivee.slice(0, 5)}</p>
                  <p className="text-xs text-muted-foreground">Le {formatDate(r.date_retard)} · Déclaré le {formatDateTime(r.date_creation)}</p>
                  {r.motif_refus && <p className="mt-1 text-xs text-red-700">Motif du refus : {r.motif_refus}</p>}
                  {r.has_piece_jointe && (
                    <a href={apiUrl(`/retards/${r.id}/piece-jointe`)} className="mt-1 inline-flex items-center gap-1 text-xs text-wm-blue hover:underline">Pièce jointe</a>
                  )}
                </div>
                {r.statut === "EN_ATTENTE" && <Button variant="outline" size="sm" onClick={() => annuler(r.id)} className="self-start sm:self-center">Annuler</Button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

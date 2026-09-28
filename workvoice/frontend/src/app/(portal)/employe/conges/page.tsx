"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, FileText, Loader2, Paperclip, Plus, Send, Upload, Wallet, X } from "lucide-react";
import { toast } from "sonner";
import { api, apiUrl, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AbsenceStatusBadge } from "@/components/common/badges";
import { Field, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CongeDemande, CongeType } from "@/types";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.docx";
const MAX_MB = 5;

export default function MesCongesPage() {
  const { data: types } = useApi<{ data: CongeType[] }>("/conges/types");
  const { data: solde, reload: reloadSolde } = useApi<{ data: { solde_initial: number; solde_actuel: number } }>("/me/solde-conges");
  const { data, error, loading, reload } = useApi<{ data: CongeDemande[] }>("/me/conges");

  const [showForm, setShowForm] = useState(false);
  const [typeId, setTypeId] = useState("");
  const [dateDebut, setDateDebut] = useState("");
  const [dateFin, setDateFin] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [nbJours, setNbJours] = useState<number | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!dateDebut || !dateFin) { setNbJours(null); return; }
    const t = setTimeout(async () => {
      setCalcLoading(true);
      try {
        const res = await api<{ data: { nb_jours: number } }>("/conges/calcul-jours", { method: "POST", body: { date_debut: dateDebut, date_fin: dateFin } });
        setNbJours(res.data.nb_jours);
      } catch {
        setNbJours(null);
      } finally {
        setCalcLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [dateDebut, dateFin]);

  function pickFile(f?: File) {
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) return toast.error(`Fichier trop volumineux (max ${MAX_MB} Mo)`);
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!typeId) errs.type_id = "Choisissez un type de congé";
    if (!dateDebut) errs.date_debut = "Obligatoire";
    if (!dateFin) errs.date_fin = "Obligatoire";
    if (dateDebut && dateFin && dateFin < dateDebut) errs.date_fin = "Doit être postérieure à la date de début";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSubmitting(true);
    const form = new FormData();
    form.append("type_id", typeId);
    form.append("date_debut", dateDebut);
    form.append("date_fin", dateFin);
    if (commentaire.trim()) form.append("commentaire", commentaire.trim());
    if (file) form.append("piece_jointe", file);
    try {
      const res = await api<{ data: { numero: string } }>("/conges", { method: "POST", body: form });
      toast.success(`Demande ${res.data.numero} envoyée`);
      setShowForm(false);
      setTypeId(""); setDateDebut(""); setDateFin(""); setCommentaire(""); setFile(null); setNbJours(null);
      reload(); reloadSolde();
    } catch (err) {
      if (err instanceof ApiError) { setErrors(err.fieldErrors()); toast.error(err.message); }
    } finally {
      setSubmitting(false);
    }
  }

  async function annuler(id: number) {
    if (!window.confirm("Annuler cette demande de congé ?")) return;
    try {
      await api(`/conges/${id}/annuler`, { method: "POST" });
      toast.success("Demande annulée");
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible");
    }
  }

  const s = solde?.data;

  return (
    <>
      <PageHeader
        title="Mes congés"
        description="Consultez votre solde et déposez vos demandes de congé."
        actions={!showForm && <Button onClick={() => setShowForm(true)}><Plus className="size-4" /> Nouvelle demande</Button>}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <div className="flex items-center gap-4 rounded-xl border bg-card p-5 shadow-xs">
          <div className="rounded-xl bg-wm-blue-50 p-3 text-wm-blue"><Wallet className="size-6" /></div>
          <div>
            <p className="text-2xl font-bold tabular-nums">{s ? `${s.solde_actuel} j` : "–"}</p>
            <p className="text-sm text-muted-foreground">Solde actuel disponible</p>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-xl border bg-card p-5 shadow-xs">
          <div className="rounded-xl bg-slate-100 p-3 text-slate-600"><CalendarDays className="size-6" /></div>
          <div>
            <p className="text-2xl font-bold tabular-nums">{s ? `${s.solde_initial} j` : "–"}</p>
            <p className="text-sm text-muted-foreground">Solde initial attribué</p>
          </div>
        </div>
      </div>

      {showForm && (
        <form onSubmit={submit} noValidate className="mb-6 space-y-5 rounded-xl border border-wm-blue/20 bg-card p-5 shadow-xs sm:p-7">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Nouvelle demande de congé</h2>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setShowForm(false)}><X className="size-4" /></Button>
          </div>
          <Field id="type_id" label="Type de congé" required error={errors.type_id}>
            <select id="type_id" value={typeId} onChange={(e) => setTypeId(e.target.value)} className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm">
              <option value="">Sélectionner…</option>
              {types?.data.map((t) => <option key={t.id} value={t.id}>{t.libelle}</option>)}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="date_debut" label="Date de début" required error={errors.date_debut}>
              <Input id="date_debut" type="date" value={dateDebut} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDateDebut(e.target.value)} className="h-10" />
            </Field>
            <Field id="date_fin" label="Date de fin" required error={errors.date_fin}>
              <Input id="date_fin" type="date" value={dateFin} min={dateDebut || new Date().toISOString().slice(0, 10)} onChange={(e) => setDateFin(e.target.value)} className="h-10" />
            </Field>
          </div>
          {(calcLoading || nbJours !== null) && (
            <p className="flex items-center gap-2 rounded-lg bg-wm-blue-50 px-4 py-2.5 text-sm text-wm-blue">
              {calcLoading ? <Loader2 className="size-4 animate-spin" /> : <CalendarDays className="size-4" />}
              {calcLoading ? "Calcul en cours…" : <>Cette demande représente <b>{nbJours} jour(s) ouvré(s)</b> (hors week-ends et jours fériés).</>}
            </p>
          )}
          <Field id="commentaire" label="Commentaire" hint="Facultatif">
            <Textarea id="commentaire" value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={3} maxLength={2000} />
          </Field>
          <Field id="piece_jointe" label="Pièce jointe" hint={`Facultatif · PDF, JPG, PNG, DOCX · ${MAX_MB} Mo max`}>
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
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Envoyer
            </Button>
          </div>
        </form>
      )}

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : loading && !data ? (
        <LoadingBlock rows={4} />
      ) : !data?.data.length ? (
        <EmptyState title="Aucune demande de congé" description="Créez votre première demande." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <ul className="divide-y">
            {data.data.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-wm-blue">{d.numero}</span>
                    <AbsenceStatusBadge statut={d.statut} />
                  </div>
                  <p className="mt-1 text-sm font-medium">{d.type_libelle} — {d.nb_jours} j</p>
                  <p className="text-xs text-muted-foreground">Du {formatDate(d.date_debut)} au {formatDate(d.date_fin)} · Déposée le {formatDateTime(d.date_creation)}</p>
                  {d.motif_refus && <p className="mt-1 text-xs text-red-700">Motif du refus : {d.motif_refus}</p>}
                  {d.has_piece_jointe && (
                    <a href={apiUrl(`/conges/${d.id}/piece-jointe`)} className="mt-1 inline-flex items-center gap-1 text-xs text-wm-blue hover:underline">
                      <Paperclip className="size-3" /> {d.piece_jointe_nom ?? "Pièce jointe"}
                    </a>
                  )}
                </div>
                {["BROUILLON", "EN_ATTENTE"].includes(d.statut) && (
                  <Button variant="outline" size="sm" onClick={() => annuler(d.id)} className="self-start sm:self-center">Annuler</Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

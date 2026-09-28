"use client";

import { useState } from "react";
import { CheckCircle2, Clock, Download, Plus, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { downloadFile, toCsv } from "@/lib/csv";
import { formatDuree } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AbsenceStatusBadge } from "@/components/common/badges";
import { AlertesPanel } from "@/components/common/alertes-panel";
import { NativeSelect, PageHeader } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Alerte, Motif, Paged, SortieDemande } from "@/types";

type Tab = "demandes" | "parametrage" | "analyse";
const TABS: { value: Tab; label: string }[] = [{ value: "demandes", label: "Demandes" }, { value: "parametrage", label: "Motifs" }, { value: "analyse", label: "Tableau de bord & IA" }];

function RefusDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (motif: string) => void }) {
  const [motif, setMotif] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Motif du refus</DialogTitle></DialogHeader>
        <Textarea value={motif} onChange={(e) => setMotif(e.target.value)} rows={3} maxLength={500} placeholder="Facultatif" />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button variant="destructive" onClick={() => { onConfirm(motif); setMotif(""); }}>Refuser</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DemandesTab() {
  const [statut, setStatut] = useState("");
  const [refusing, setRefusing] = useState<number | null>(null);
  const { data, error, loading, reload } = useApi<Paged<SortieDemande>>(`/rh/sorties${statut ? `?statut=${statut}` : ""}`);

  async function changerStatut(id: number, s: string, motif_refus?: string) {
    try { await api(`/rh/sorties/${id}/statut`, { method: "PATCH", body: { statut: s, motif_refus } }); toast.success("Statut mis à jour"); reload(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Action impossible"); }
  }
  function exporter() {
    if (!data?.data.length) return;
    downloadFile("sorties.csv", toCsv([
      ["Numéro", "Matricule", "Nom", "Prénom", "Service", "Motif", "Date", "Début", "Fin", "Durée (min)", "Statut"],
      ...data.data.map((s) => [s.numero, s.matricule ?? "", s.nom ?? "", s.prenom ?? "", s.service ?? "", s.motif_libelle, s.date_sortie, s.heure_debut, s.heure_fin, s.duree_minutes, s.statut]),
    ]));
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <NativeSelect value={statut} onChange={(e) => setStatut(e.target.value)} className="w-52" aria-label="Statut">
          <option value="">Tous statuts</option>
          {["EN_ATTENTE", "VALIDE", "REFUSE", "ANNULE"].map((s) => <option key={s} value={s}>{s}</option>)}
        </NativeSelect>
        <Button variant="outline" onClick={exporter} disabled={!data?.data.length}><Download className="size-4" /> Exporter (Excel)</Button>
      </div>
      {error ? <ErrorState message={error.message} onRetry={reload} /> : loading && !data ? <LoadingBlock rows={6} /> : !data?.data.length ? (
        <EmptyState title="Aucune demande" description="Aucune autorisation de sortie sur ce filtre." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <ul className="divide-y">
            {data.data.map((s) => (
              <li key={s.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-semibold text-wm-blue">{s.numero}</span><AbsenceStatusBadge statut={s.statut} /></div>
                  <p className="mt-1 text-sm font-medium">{s.prenom} {s.nom} ({s.matricule}) — {s.motif_libelle}</p>
                  <p className="text-xs text-muted-foreground">{s.service} · Le {formatDate(s.date_sortie)}, {s.heure_debut.slice(0, 5)}–{s.heure_fin.slice(0, 5)} ({formatDuree(s.duree_minutes)})</p>
                </div>
                {s.statut === "EN_ATTENTE" && (
                  <div className="flex gap-2 self-start sm:self-center">
                    <Button size="sm" onClick={() => changerStatut(s.id, "VALIDE")}><CheckCircle2 className="size-4" /> Valider</Button>
                    <Button size="sm" variant="outline" onClick={() => setRefusing(s.id)}><XCircle className="size-4" /> Refuser</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <RefusDialog open={refusing !== null} onClose={() => setRefusing(null)} onConfirm={(m) => { if (refusing) changerStatut(refusing, "REFUSE", m); setRefusing(null); }} />
    </>
  );
}

function MotifsTab() {
  const { data, reload } = useApi<{ data: Motif[] }>("/rh/sorties/motifs");
  const [libelle, setLibelle] = useState("");
  async function toggle(m: Motif) {
    try { await api(`/rh/sorties/motifs/${m.id}`, { method: "PATCH", body: { libelle: m.libelle, actif: !m.actif } }); reload(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Action impossible"); }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!libelle.trim()) return;
    try { await api("/rh/sorties/motifs", { method: "POST", body: { libelle: libelle.trim() } }); setLibelle(""); toast.success("Motif ajouté"); reload(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Création impossible"); }
  }
  async function remove(id: number) {
    if (!window.confirm("Supprimer ce motif ?")) return;
    try { await api(`/rh/sorties/motifs/${id}`, { method: "DELETE" }); reload(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Suppression impossible"); }
  }
  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs">
      <h3 className="mb-4 font-semibold">Motifs de sortie</h3>
      <ul className="mb-4 divide-y">
        {data?.data.map((m) => (
          <li key={m.id} className="flex items-center justify-between py-2 text-sm">
            <span>{m.libelle}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => toggle(m)} className={cn("rounded-full px-2 py-0.5 text-xs", m.actif ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>{m.actif ? "Actif" : "Inactif"}</button>
              <Button variant="ghost" size="icon-sm" onClick={() => remove(m.id)}><X className="size-4" /></Button>
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={create} className="flex gap-2 border-t pt-4">
        <Input placeholder="Nouveau motif" value={libelle} onChange={(e) => setLibelle(e.target.value)} className="h-9 flex-1" />
        <Button type="submit" size="sm"><Plus className="size-4" /></Button>
      </form>
    </section>
  );
}

function AnalyseTab() {
  const { data: dashboard } = useApi<{ data: { kpi: { en_attente: number; validees: number; refusees: number; temps_total_minutes: number } } }>("/rh/sorties/dashboard");
  const { data: analyse } = useApi<{ data: { alertes: Alerte[] } }>("/rh/sorties/analyse");
  const kpi = dashboard?.data.kpi;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="En attente" value={kpi?.en_attente ?? "–"} icon={Clock} tone="yellow" />
        <KpiCard label="Validées" value={kpi?.validees ?? "–"} icon={CheckCircle2} tone="green" />
        <KpiCard label="Refusées" value={kpi?.refusees ?? "–"} icon={XCircle} tone="red" />
        <KpiCard label="Temps total" value={kpi ? formatDuree(kpi.temps_total_minutes) : "–"} icon={Clock} tone="blue" />
      </div>
      <AlertesPanel alertes={analyse?.data.alertes ?? []} />
    </div>
  );
}

export default function RhSortiesPage() {
  const [tab, setTab] = useState<Tab>("demandes");
  return (
    <>
      <PageHeader title="Autorisations de sortie" description="Traitez les demandes et paramétrez les motifs." />
      <div className="mb-5 flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
        {TABS.map((t) => <button key={t.value} onClick={() => setTab(t.value)} className={cn("rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition", tab === t.value ? "bg-white text-wm-blue shadow-sm" : "text-slate-600 hover:text-slate-900")}>{t.label}</button>)}
      </div>
      {tab === "demandes" && <DemandesTab />}
      {tab === "parametrage" && <MotifsTab />}
      {tab === "analyse" && <AnalyseTab />}
    </>
  );
}

"use client";

import { useState } from "react";
import { CheckCircle2, Clock, Download, Paperclip, Plus, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, apiUrl, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { downloadFile, toCsv } from "@/lib/csv";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AbsenceStatusBadge } from "@/components/common/badges";
import { AlertesPanel } from "@/components/common/alertes-panel";
import { GroupedBarChart, WM } from "@/components/charts/charts";
import { NativeSelect, PageHeader } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Alerte, Motif, Paged, RetardDeclaration } from "@/types";

type Tab = "demandes" | "parametrage" | "analyse";
const TABS: { value: Tab; label: string }[] = [{ value: "demandes", label: "Demandes" }, { value: "parametrage", label: "Motifs" }, { value: "analyse", label: "Tableau de bord & IA" }];
const SEUILS = [3, 5, 10];

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
  const { data, error, loading, reload } = useApi<Paged<RetardDeclaration>>(`/rh/retards${statut ? `?statut=${statut}` : ""}`);

  async function changerStatut(id: number, s: string, motif_refus?: string) {
    try { await api(`/rh/retards/${id}/statut`, { method: "PATCH", body: { statut: s, motif_refus } }); toast.success("Statut mis à jour"); reload(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Action impossible"); }
  }
  function exporter() {
    if (!data?.data.length) return;
    downloadFile("retards.csv", toCsv([
      ["Numéro", "Matricule", "Nom", "Prénom", "Service", "Date", "Heure d'arrivée", "Motif", "Statut"],
      ...data.data.map((r) => [r.numero, r.matricule ?? "", r.nom ?? "", r.prenom ?? "", r.service ?? "", r.date_retard, r.heure_arrivee, r.motif_libelle, r.statut]),
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
        <EmptyState title="Aucune déclaration" description="Aucune déclaration de retard sur ce filtre." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <ul className="divide-y">
            {data.data.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-semibold text-wm-blue">{r.numero}</span><AbsenceStatusBadge statut={r.statut} /></div>
                  <p className="mt-1 text-sm font-medium">{r.prenom} {r.nom} ({r.matricule}) — {r.motif_libelle}</p>
                  <p className="text-xs text-muted-foreground">{r.service} · Le {formatDate(r.date_retard)}, arrivée à {r.heure_arrivee.slice(0, 5)}</p>
                  {r.has_piece_jointe && <a href={apiUrl(`/retards/${r.id}/piece-jointe`)} className="mt-1 inline-flex items-center gap-1 text-xs text-wm-blue hover:underline"><Paperclip className="size-3" /> Pièce jointe</a>}
                </div>
                {r.statut === "EN_ATTENTE" && (
                  <div className="flex gap-2 self-start sm:self-center">
                    <Button size="sm" onClick={() => changerStatut(r.id, "VALIDE")}><CheckCircle2 className="size-4" /> Valider</Button>
                    <Button size="sm" variant="outline" onClick={() => setRefusing(r.id)}><XCircle className="size-4" /> Refuser</Button>
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
  const { data, reload } = useApi<{ data: Motif[] }>("/rh/retards/motifs");
  const [libelle, setLibelle] = useState("");
  async function toggle(m: Motif) {
    try { await api(`/rh/retards/motifs/${m.id}`, { method: "PATCH", body: { libelle: m.libelle, actif: !m.actif } }); reload(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Action impossible"); }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!libelle.trim()) return;
    try { await api("/rh/retards/motifs", { method: "POST", body: { libelle: libelle.trim() } }); setLibelle(""); toast.success("Motif ajouté"); reload(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Création impossible"); }
  }
  async function remove(id: number) {
    if (!window.confirm("Supprimer ce motif ?")) return;
    try { await api(`/rh/retards/motifs/${id}`, { method: "DELETE" }); reload(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Suppression impossible"); }
  }
  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs">
      <h3 className="mb-4 font-semibold">Motifs de retard</h3>
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
  const [seuil, setSeuil] = useState(3);
  const { data: dashboard } = useApi<{ data: { kpi: { en_attente: number; valides: number; refuses: number } } }>("/rh/retards/dashboard");
  const { data: analyse } = useApi<{ data: { alertes: Alerte[]; evolution_mensuelle: { mois: string; nb: number }[] } }>(`/rh/retards/analyse?seuil=${seuil}`);
  const kpi = dashboard?.data.kpi;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="En attente" value={kpi?.en_attente ?? "–"} icon={Clock} tone="yellow" />
        <KpiCard label="Validés" value={kpi?.valides ?? "–"} icon={CheckCircle2} tone="green" />
        <KpiCard label="Refusés" value={kpi?.refuses ?? "–"} icon={XCircle} tone="red" />
      </div>
      <section className="rounded-xl border bg-card p-5 shadow-xs">
        <h3 className="mb-4 font-semibold">Évolution mensuelle (retards validés)</h3>
        <GroupedBarChart data={(analyse?.data.evolution_mensuelle ?? []).map((m) => ({ ...m, label: m.mois }))} xKey="label" series={[{ key: "nb", label: "Retards", color: WM.blue }]} />
      </section>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Seuil d&apos;alerte collaborateur :</span>
        {SEUILS.map((s) => (
          <button key={s} onClick={() => setSeuil(s)} className={cn("rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset", seuil === s ? "bg-wm-blue text-white ring-wm-blue" : "bg-white text-slate-600 ring-slate-300")}>{s} retards</button>
        ))}
      </div>
      <AlertesPanel alertes={analyse?.data.alertes ?? []} />
    </div>
  );
}

export default function RhRetardsPage() {
  const [tab, setTab] = useState<Tab>("demandes");
  return (
    <>
      <PageHeader title="Déclarations de retard" description="Traitez les déclarations et suivez les tendances." />
      <div className="mb-5 flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
        {TABS.map((t) => <button key={t.value} onClick={() => setTab(t.value)} className={cn("rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition", tab === t.value ? "bg-white text-wm-blue shadow-sm" : "text-slate-600 hover:text-slate-900")}>{t.label}</button>)}
      </div>
      {tab === "demandes" && <DemandesTab />}
      {tab === "parametrage" && <MotifsTab />}
      {tab === "analyse" && <AnalyseTab />}
    </>
  );
}

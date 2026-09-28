"use client";

import { useState } from "react";
import { CalendarDays, CheckCircle2, Clock, Download, Loader2, Plus, Wallet, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { downloadFile, toCsv } from "@/lib/csv";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AbsenceStatusBadge } from "@/components/common/badges";
import { AlertesPanel } from "@/components/common/alertes-panel";
import { Field, NativeSelect, PageHeader } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Alerte, CongeDemande, CongeType, JourFerie, Paged } from "@/types";

type Tab = "demandes" | "soldes" | "parametrage" | "analyse";
const TABS: { value: Tab; label: string }[] = [
  { value: "demandes", label: "Demandes" },
  { value: "soldes", label: "Soldes" },
  { value: "parametrage", label: "Paramétrage" },
  { value: "analyse", label: "Tableau de bord & IA" },
];

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
  const query = statut ? `?statut=${statut}` : "";
  const { data, error, loading, reload } = useApi<Paged<CongeDemande>>(`/rh/conges${query}`);

  async function changerStatut(id: number, nouveauStatut: string, motif_refus?: string) {
    try {
      await api(`/rh/conges/${id}/statut`, { method: "PATCH", body: { statut: nouveauStatut, motif_refus } });
      toast.success("Statut mis à jour");
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible");
    }
  }

  function exporter() {
    if (!data?.data.length) return;
    downloadFile("conges.csv", toCsv([
      ["Numéro", "Matricule", "Nom", "Prénom", "Service", "Type", "Début", "Fin", "Jours", "Statut", "Créée le"],
      ...data.data.map((d) => [d.numero, d.matricule ?? "", d.nom ?? "", d.prenom ?? "", d.service ?? "", d.type_libelle, d.date_debut, d.date_fin, d.nb_jours, d.statut, d.date_creation]),
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
      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : loading && !data ? (
        <LoadingBlock rows={6} />
      ) : !data?.data.length ? (
        <EmptyState title="Aucune demande" description="Aucune demande de congé sur ce filtre." />
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
                  <p className="mt-1 text-sm font-medium">{d.prenom} {d.nom} ({d.matricule}) — {d.type_libelle}, {d.nb_jours} j</p>
                  <p className="text-xs text-muted-foreground">{d.service} · Du {formatDate(d.date_debut)} au {formatDate(d.date_fin)}</p>
                </div>
                {d.statut === "EN_ATTENTE" && (
                  <div className="flex gap-2 self-start sm:self-center">
                    <Button size="sm" onClick={() => changerStatut(d.id, "VALIDE")}><CheckCircle2 className="size-4" /> Valider</Button>
                    <Button size="sm" variant="outline" onClick={() => setRefusing(d.id)}><XCircle className="size-4" /> Refuser</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <RefusDialog open={refusing !== null} onClose={() => setRefusing(null)} onConfirm={(motif) => { if (refusing) changerStatut(refusing, "REFUSE", motif); setRefusing(null); }} />
    </>
  );
}

function AjustementDialog({ userId, onClose, onDone }: { userId: number | null; onClose: () => void; onDone: () => void }) {
  const [jours, setJours] = useState("");
  const [commentaire, setCommentaire] = useState("");
  const [saving, setSaving] = useState(false);
  if (!userId) return null;
  async function submit() {
    setSaving(true);
    try {
      await api(`/rh/conges/soldes/${userId}/ajustement`, { method: "POST", body: { jours: Number(jours), commentaire } });
      toast.success("Solde ajusté");
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ajustement impossible");
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Ajuster le solde de congé</DialogTitle></DialogHeader>
        <Field id="jours" label="Nombre de jours (négatif pour retirer)" required>
          <Input id="jours" type="number" step="0.5" value={jours} onChange={(e) => setJours(e.target.value)} className="h-10" />
        </Field>
        <Field id="commentaire" label="Motif de l'ajustement" required>
          <Textarea id="commentaire" value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={2} maxLength={255} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={submit} disabled={saving || !jours || !commentaire}>{saving && <Loader2 className="size-4 animate-spin" />} Enregistrer</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SoldesTab() {
  const { data, reload } = useApi<{ data: { kpi: unknown; soldes: { id: number; matricule: string; nom: string; prenom: string; service: string; solde_conge_initial: number; solde_conge_actuel: number }[] } }>("/rh/conges/dashboard");
  const [ajusting, setAjusting] = useState<number | null>(null);
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase">
          <tr><th className="px-4 py-3">Collaborateur</th><th className="px-4 py-3">Service</th><th className="px-4 py-3 text-right">Initial</th><th className="px-4 py-3 text-right">Actuel</th><th className="w-10" /></tr>
        </thead>
        <tbody className="divide-y">
          {data?.data.soldes.map((u) => (
            <tr key={u.id} className="hover:bg-slate-50">
              <td className="px-4 py-3">{u.prenom} {u.nom} <span className="text-xs text-muted-foreground">({u.matricule})</span></td>
              <td className="px-4 py-3 text-muted-foreground">{u.service}</td>
              <td className="px-4 py-3 text-right tabular-nums">{u.solde_conge_initial}</td>
              <td className={cn("px-4 py-3 text-right font-semibold tabular-nums", u.solde_conge_actuel < 3 && "text-red-600")}>{u.solde_conge_actuel}</td>
              <td className="px-4 py-3 text-right"><Button size="sm" variant="outline" onClick={() => setAjusting(u.id)}>Ajuster</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <AjustementDialog userId={ajusting} onClose={() => setAjusting(null)} onDone={reload} />
    </div>
  );
}

function ParametrageTab() {
  const { data: types, reload: reloadTypes } = useApi<{ data: CongeType[] }>("/rh/conges/types");
  const { data: feries, reload: reloadFeries } = useApi<{ data: JourFerie[] }>(`/rh/conges/jours-feries?annee=${new Date().getFullYear()}`);
  const [newType, setNewType] = useState({ code: "", libelle: "", deduit_solde: false });
  const [newFerie, setNewFerie] = useState({ date_ferie: "", libelle: "" });

  async function toggleType(t: CongeType) {
    try {
      await api(`/rh/conges/types/${t.id}`, { method: "PATCH", body: { libelle: t.libelle, actif: !t.actif, deduit_solde: t.deduit_solde } });
      reloadTypes();
    } catch (err) { toast.error(err instanceof ApiError ? err.message : "Action impossible"); }
  }
  async function createType(e: React.FormEvent) {
    e.preventDefault();
    if (!newType.code || !newType.libelle) return;
    try {
      await api("/rh/conges/types", { method: "POST", body: newType });
      setNewType({ code: "", libelle: "", deduit_solde: false });
      toast.success("Type ajouté");
      reloadTypes();
    } catch (err) { toast.error(err instanceof ApiError ? err.message : "Création impossible"); }
  }
  async function deleteType(id: number) {
    if (!window.confirm("Supprimer ce type ?")) return;
    try { await api(`/rh/conges/types/${id}`, { method: "DELETE" }); reloadTypes(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Suppression impossible"); }
  }
  async function createFerie(e: React.FormEvent) {
    e.preventDefault();
    if (!newFerie.date_ferie || !newFerie.libelle) return;
    try {
      await api("/rh/conges/jours-feries", { method: "POST", body: newFerie });
      setNewFerie({ date_ferie: "", libelle: "" });
      toast.success("Jour férié ajouté");
      reloadFeries();
    } catch (err) { toast.error(err instanceof ApiError ? err.message : "Création impossible"); }
  }
  async function deleteFerie(id: number) {
    try { await api(`/rh/conges/jours-feries/${id}`, { method: "DELETE" }); reloadFeries(); }
    catch (err) { toast.error(err instanceof ApiError ? err.message : "Suppression impossible"); }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border bg-card p-5 shadow-xs">
        <h3 className="mb-4 font-semibold">Types de congé</h3>
        <ul className="mb-4 divide-y">
          {types?.data.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2 text-sm">
              <span>{t.libelle} {t.deduit_solde && <span className="text-xs text-muted-foreground">(déduit le solde)</span>}</span>
              <div className="flex items-center gap-2">
                <button onClick={() => toggleType(t)} className={cn("rounded-full px-2 py-0.5 text-xs", t.actif ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>{t.actif ? "Actif" : "Inactif"}</button>
                {!t.is_systeme && <Button variant="ghost" size="icon-sm" onClick={() => deleteType(t.id)}><X className="size-4" /></Button>}
              </div>
            </li>
          ))}
        </ul>
        <form onSubmit={createType} className="flex flex-wrap gap-2 border-t pt-4">
          <Input placeholder="Code" value={newType.code} onChange={(e) => setNewType({ ...newType, code: e.target.value })} className="h-9 w-28" />
          <Input placeholder="Libellé" value={newType.libelle} onChange={(e) => setNewType({ ...newType, libelle: e.target.value })} className="h-9 flex-1" />
          <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={newType.deduit_solde} onChange={(e) => setNewType({ ...newType, deduit_solde: e.target.checked })} /> Déduit le solde</label>
          <Button type="submit" size="sm"><Plus className="size-4" /></Button>
        </form>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-xs">
        <h3 className="mb-4 font-semibold">Jours fériés {new Date().getFullYear()}</h3>
        <ul className="mb-4 max-h-64 divide-y overflow-y-auto">
          {feries?.data.map((f) => (
            <li key={f.id} className="flex items-center justify-between py-2 text-sm">
              <span>{formatDate(f.date_ferie)} — {f.libelle}</span>
              <Button variant="ghost" size="icon-sm" onClick={() => deleteFerie(f.id)}><X className="size-4" /></Button>
            </li>
          ))}
          {feries?.data.length === 0 && <li className="py-4 text-sm text-muted-foreground">Aucun jour férié configuré.</li>}
        </ul>
        <form onSubmit={createFerie} className="flex flex-wrap gap-2 border-t pt-4">
          <Input type="date" value={newFerie.date_ferie} onChange={(e) => setNewFerie({ ...newFerie, date_ferie: e.target.value })} className="h-9 w-40" />
          <Input placeholder="Libellé" value={newFerie.libelle} onChange={(e) => setNewFerie({ ...newFerie, libelle: e.target.value })} className="h-9 flex-1" />
          <Button type="submit" size="sm"><Plus className="size-4" /></Button>
        </form>
      </section>
    </div>
  );
}

function AnalyseTab() {
  const { data: dashboard } = useApi<{ data: { kpi: { en_attente: number; validees: number; refusees: number } } }>("/rh/conges/dashboard");
  const { data: analyse } = useApi<{ data: { alertes: Alerte[] } }>("/rh/conges/analyse");
  const kpi = dashboard?.data.kpi;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="En attente" value={kpi?.en_attente ?? "–"} icon={Clock} tone="yellow" />
        <KpiCard label="Validées" value={kpi?.validees ?? "–"} icon={CheckCircle2} tone="green" />
        <KpiCard label="Refusées" value={kpi?.refusees ?? "–"} icon={XCircle} tone="red" />
      </div>
      <AlertesPanel alertes={analyse?.data.alertes ?? []} />
    </div>
  );
}

export default function RhCongesPage() {
  const [tab, setTab] = useState<Tab>("demandes");
  return (
    <>
      <PageHeader title="Gestion des congés" description="Traitez les demandes, gérez les soldes et paramétrez le module." />
      <div className="mb-5 flex gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1">
        {TABS.map((t) => (
          <button key={t.value} onClick={() => setTab(t.value)} className={cn("rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition", tab === t.value ? "bg-white text-wm-blue shadow-sm" : "text-slate-600 hover:text-slate-900")}>{t.label}</button>
        ))}
      </div>
      {tab === "demandes" && <DemandesTab />}
      {tab === "soldes" && <SoldesTab />}
      {tab === "parametrage" && <ParametrageTab />}
      {tab === "analyse" && <AnalyseTab />}
    </>
  );
}

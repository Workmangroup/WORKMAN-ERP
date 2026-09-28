"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2, ChevronLeft, ChevronRight, Download, FileSignature, FileX2, Loader2,
  MoreHorizontal, RefreshCcw, Search, ShieldCheck, XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api, apiUrl, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { ATTESTATION_TYPE_LABELS } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AttestationStatusBadge } from "@/components/common/badges";
import { NativeSelect, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AttestationRequest, Company, Paged } from "@/types";

function MotifDialog({
  open, title, onClose, onConfirm,
}: { open: boolean; title: string; onClose: () => void; onConfirm: (motif: string) => Promise<void> }) {
  const [motif, setMotif] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setMotif(""); setError(""); } }, [open]);

  async function confirm() {
    if (motif.trim().length < 3) { setError("Merci de préciser un motif (3 caractères minimum)"); return; }
    setSaving(true);
    try {
      await onConfirm(motif.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Ce motif sera visible par le collaborateur et conservé dans l&apos;historique.</DialogDescription>
        </DialogHeader>
        <Textarea value={motif} onChange={(e) => setMotif(e.target.value)} rows={3} maxLength={500} placeholder="Motif…" aria-invalid={Boolean(error)} />
        {error && <p className="text-xs font-medium text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={confirm} disabled={saving}>{saving && <Loader2 className="size-4 animate-spin" />} Confirmer</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function RhAttestationsPage() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "SYSTEM_ADMIN";
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [statut, setStatut] = useState("");
  const [type, setType] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [motifDialog, setMotifDialog] = useState<{ open: boolean; id: number | null; action: "refuser" | "annuler" | null; titre: string }>({ open: false, id: null, action: null, titre: "" });

  useEffect(() => {
    const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const { data: societesResp } = useApi<{ data: Company[] }>(isAdmin ? "/admin/societes" : null);
  const societes = societesResp?.data;
  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: "20" });
    Object.entries({ q: search, statut, type, company_id: isAdmin ? companyId : "" }).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  }, [page, search, statut, type, companyId, isAdmin]);
  const { data, error, loading, reload } = useApi<Paged<AttestationRequest>>(`/rh/attestations?${query}`);

  async function action(id: number, path: string, successMsg: string, body?: unknown) {
    setBusyId(id);
    try {
      await api(`/rh/attestations/${id}/${path}`, { method: "POST", body });
      toast.success(successMsg);
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible");
    } finally {
      setBusyId(null);
    }
  }

  function openMotif(id: number, action: "refuser" | "annuler") {
    setMotifDialog({ open: true, id, action, titre: action === "refuser" ? "Refuser la demande" : "Annuler la demande" });
  }

  async function confirmMotif(motif: string) {
    if (!motifDialog.id || !motifDialog.action) return;
    await action(motifDialog.id, motifDialog.action, motifDialog.action === "refuser" ? "Demande refusée" : "Demande annulée", { motif });
    setMotifDialog({ open: false, id: null, action: null, titre: "" });
  }

  return (
    <>
      <PageHeader
        title="Attestations"
        description="Traitez les demandes d'attestations : génération, validation, signature et remise au collaborateur."
      />

      <div className={cn("mb-4 grid gap-2 rounded-xl border bg-card p-3 shadow-xs sm:grid-cols-2", isAdmin ? "lg:grid-cols-[1.4fr_repeat(4,1fr)]" : "lg:grid-cols-[1.6fr_repeat(3,1fr)]")}>
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Numéro, nom, matricule…" className="h-9 pl-9" aria-label="Rechercher" />
        </div>
        {isAdmin && (
          <NativeSelect value={companyId} onChange={(e) => { setCompanyId(e.target.value); setPage(1); }} aria-label="Société">
            <option value="">Toutes les sociétés</option>
            {societes?.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
          </NativeSelect>
        )}
        <NativeSelect value={statut} onChange={(e) => { setStatut(e.target.value); setPage(1); }} aria-label="Statut">
          <option value="">Tous les statuts</option>
          <option value="SUBMITTED">Soumise</option>
          <option value="IN_REVIEW">En cours de traitement</option>
          <option value="GENERATED">Document généré</option>
          <option value="APPROVED">Validée</option>
          <option value="READY">Prête</option>
          <option value="REJECTED">Refusée</option>
          <option value="CANCELLED">Annulée</option>
        </NativeSelect>
        <NativeSelect value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Type">
          <option value="">Tous les types</option>
          <option value="ATTESTATION_TRAVAIL">Attestation de travail</option>
          <option value="ATTESTATION_SALAIRE">Attestation de salaire</option>
        </NativeSelect>
      </div>

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data && loading ? (
        <LoadingBlock rows={6} />
      ) : !data?.data.length ? (
        <EmptyState title="Aucune demande d'attestation" description="Aucune demande ne correspond à ces critères." />
      ) : (
        <div className={cn("overflow-hidden rounded-xl border bg-card shadow-xs transition", loading && "opacity-60")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Numéro</th>
                  <th className="px-4 py-3">Collaborateur</th>
                  {isAdmin && <th className="px-4 py-3">Société</th>}
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-4 py-3">Déposée le</th>
                  <th className="w-12 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.data.map((a) => (
                  <tr key={a.id} className="transition hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-wm-blue">{a.numero}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">{a.prenom} {a.nom}</p>
                      <p className="text-xs text-muted-foreground">{a.matricule} · {a.service}</p>
                    </td>
                    {isAdmin && <td className="px-4 py-3">{a.company_name}</td>}
                    <td className="px-4 py-3">{ATTESTATION_TYPE_LABELS[a.type] ?? a.type_libelle}</td>
                    <td className="px-4 py-3"><AttestationStatusBadge statut={a.statut} /></td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">{formatDateTime(a.date_creation)}</td>
                    <td className="px-4 py-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger className="inline-flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label={`Actions pour ${a.numero}`} disabled={busyId === a.id}>
                          {busyId === a.id ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                          {(a.statut === "SUBMITTED" || a.statut === "IN_REVIEW") && (
                            <DropdownMenuItem onClick={() => action(a.id, "generer", "Document généré")}>
                              <FileSignature className="size-4" /> Générer le document
                            </DropdownMenuItem>
                          )}
                          {a.statut === "GENERATED" && (
                            <DropdownMenuItem onClick={() => action(a.id, "approuver", "Demande validée")}>
                              <CheckCircle2 className="size-4" /> Valider
                            </DropdownMenuItem>
                          )}
                          {a.statut === "APPROVED" && (
                            <DropdownMenuItem onClick={() => action(a.id, "signer", "Attestation prête")}>
                              <ShieldCheck className="size-4" /> Signer (marquer prête)
                            </DropdownMenuItem>
                          )}
                          {a.statut === "READY" && (
                            <>
                              <DropdownMenuItem onClick={() => window.open(apiUrl(`/rh/attestations/${a.id}/telecharger`), "_blank", "noreferrer")}>
                                <Download className="size-4" /> Télécharger / Imprimer
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => action(a.id, "reediter", "Nouvelle version générée")}>
                                <RefreshCcw className="size-4" /> Rééditer (nouvelle version)
                              </DropdownMenuItem>
                            </>
                          )}
                          {!["READY", "REJECTED", "CANCELLED"].includes(a.statut) && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => openMotif(a.id, "refuser")} className="text-red-600">
                                <XCircle className="size-4" /> Refuser
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openMotif(a.id, "annuler")} className="text-red-600">
                                <FileX2 className="size-4" /> Annuler
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">{data.total} demande(s) · page {data.page} sur {data.pages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-4" /> Précédent</Button>
              <Button variant="outline" size="sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Suivant <ChevronRight className="size-4" /></Button>
            </div>
          </div>
        </div>
      )}

      <MotifDialog
        open={motifDialog.open}
        title={motifDialog.titre}
        onClose={() => setMotifDialog({ open: false, id: null, action: null, titre: "" })}
        onConfirm={confirmMotif}
      />
    </>
  );
}

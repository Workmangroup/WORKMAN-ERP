"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileSpreadsheet,
  IdCard,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Power,
  Search,
  ShieldCheck,
  Upload,
  UserPlus,
  UserRoundCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useApi } from "@/lib/use-api";
import { downloadFile, normalizeHeader, parseCsv, toCsv } from "@/lib/csv";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Field, NativeSelect, PageHeader } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Company, Paged, Role, User } from "@/types";

type Collab = User & { actif: boolean; mdp_temporaire: boolean };
type Stats = { actifs: number; inactifs: number; employes: number; rh: number; direction: number; en_attente_activation: number };
type Secret = { titre: string; prenom: string; nom: string; matricule: string; password: string };
type Referentiels = { sites: string[]; departements: string[]; services: string[] };

const ROLES: { value: Role; label: string; desc: string; style: string }[] = [
  { value: "EMPLOYE", label: "Employé", desc: "Déposer demandes RH, réclamations, suggestions ; répondre au questionnaire.", style: "bg-slate-100 text-slate-700 ring-slate-500/20" },
  { value: "RH", label: "RH", desc: "Traiter tous les dossiers, voir l'identité des auteurs, gérer les collaborateurs et les campagnes.", style: "bg-blue-50 text-blue-700 ring-blue-600/20" },
  { value: "DIRECTION", label: "Direction", desc: "Tableaux de bord et réclamations anonymisés, résultats du questionnaire.", style: "bg-wm-yellow-50 text-amber-800 ring-amber-500/30" },
];
const roleMeta = (r: Role) => ROLES.find((x) => x.value === r)!;

const FIELDS = ["matricule", "prenom", "nom", "email", "telephone", "service", "departement", "site", "role", "company_id",
  "societe", "fonction", "manager_id", "matricule_paie", "date_naissance", "adresse", "cin", "cin_date_delivrance",
  "cnss", "date_embauche", "date_fin_contrat", "type_contrat", "salaire_base", "prime", "indemnite",
  "observations_rh", "solde_conge_initial"] as const;
type FormData = Record<(typeof FIELDS)[number], string>;
const EMPTY_FORM: FormData = {
  matricule: "", prenom: "", nom: "", email: "", telephone: "", service: "", departement: "", site: "", role: "EMPLOYE", company_id: "",
  societe: "", fonction: "", manager_id: "", matricule_paie: "", date_naissance: "", adresse: "", cin: "",
  cin_date_delivrance: "", cnss: "", date_embauche: "", date_fin_contrat: "", type_contrat: "",
  salaire_base: "", prime: "", indemnite: "", observations_rh: "", solde_conge_initial: "0",
};
const TYPES_CONTRAT = ["CDI", "CDD", "SIVP", "STAGE", "INTERIM", "AUTRE"];

function RoleBadge({ role }: { role: Role }) {
  const m = roleMeta(role);
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", m.style)}>{m.label}</span>;
}

// ---------------------------------------------------------------- Mot de passe provisoire (affiché une seule fois)

function SecretDialog({ secret, onClose }: { secret: Secret | null; onClose: () => void }) {
  if (!secret) return null;
  const url = typeof window !== "undefined" ? window.location.origin : "";
  const message = `Bonjour ${secret.prenom},\n\nVotre accès au portail WORKVOICE :\n- Adresse : ${url}\n- Matricule : ${secret.matricule}\n- Mot de passe provisoire : ${secret.password}\n\nVous devrez choisir votre propre mot de passe à la première connexion.\n\nLe service RH`;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copié`);
    } catch {
      toast.error("Copie impossible : sélectionnez le texte manuellement");
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{secret.titre}</DialogTitle>
          <DialogDescription>
            Communiquez ces identifiants à {secret.prenom} {secret.nom}. Le mot de passe provisoire <strong>ne sera plus affiché</strong> ;
            il devra être changé à la première connexion.
          </DialogDescription>
        </DialogHeader>
        <dl className="space-y-3 rounded-xl bg-slate-50 p-4">
          <div>
            <dt className="text-xs font-medium text-muted-foreground uppercase">Matricule</dt>
            <dd className="font-mono text-lg font-semibold">{secret.matricule}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground uppercase">Mot de passe provisoire</dt>
            <dd className="flex items-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-wider text-wm-blue select-all">{secret.password}</span>
              <Button variant="outline" size="icon-sm" onClick={() => copy(secret.password, "Mot de passe")} aria-label="Copier le mot de passe">
                <Copy className="size-4" />
              </Button>
            </dd>
          </div>
        </dl>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => copy(message, "Message")}>
            <Copy className="size-4" /> Copier le message à envoyer
          </Button>
          <Button onClick={onClose}>J&apos;ai noté</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Formulaire création / modification

function CollaborateurSheet({
  open,
  editing,
  referentiels,
  societes,
  currentUserId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Collab | null;
  referentiels?: Referentiels;
  societes?: Company[];
  currentUserId?: number;
  onClose: () => void;
  onSaved: (user: Collab, password?: string) => void;
}) {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "SYSTEM_ADMIN";
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(editing ? (Object.fromEntries(FIELDS.map((k) => [k, String(editing[k] ?? "")])) as FormData) : EMPTY_FORM);
  }, [open, editing]);

  const set = (k: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const isSelf = editing?.id === currentUserId;
  // Chargée seulement à l'ouverture, pour peupler le choix du manager (comptes actifs).
  const { data: managers } = useApi<Paged<Collab>>(open ? "/rh/collaborateurs?actif=true&pageSize=100" : null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const k of ["matricule", "prenom", "nom", "service", "departement", "site"] as const) {
      if (!form[k].trim()) errs[k] = "Obligatoire";
    }
    if (isAdmin && form.role !== "DIRECTION" && !form.company_id) {
      errs.company_id = "Obligatoire";
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSaving(true);
    try {
      const res = await api<{ data: Collab; mot_de_passe_temporaire?: string }>(
        editing ? `/rh/collaborateurs/${editing.id}` : "/rh/collaborateurs",
        { method: editing ? "PUT" : "POST", body: form },
      );
      toast.success(editing ? "Collaborateur mis à jour" : "Collaborateur créé");
      onSaved(res.data, res.mot_de_passe_temporaire);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        toast.error(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  const input = (k: keyof FormData, label: string, props: React.ComponentProps<"input"> = {}, required = true) => (
    <Field id={`f-${k}`} label={label} required={required} error={errors[k]}>
      <Input id={`f-${k}`} value={form[k]} onChange={set(k)} className="h-10" aria-invalid={Boolean(errors[k])} {...props} />
    </Field>
  );

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{editing ? `Modifier ${editing.prenom} ${editing.nom}` : "Ajouter un collaborateur"}</SheetTitle>
          <SheetDescription>
            {editing ? "Informations et niveau d'accès." : "Un mot de passe provisoire sera généré ; le collaborateur le changera à sa première connexion."}
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} noValidate className="space-y-5 px-6 py-5">
          {input("matricule", "Matricule", { placeholder: "Ex. WM1050", className: "h-10 uppercase", maxLength: 20 })}
          <div className="grid gap-4 sm:grid-cols-2">
            {input("prenom", "Prénom", { maxLength: 80, autoComplete: "off" })}
            {input("nom", "Nom", { maxLength: 80, autoComplete: "off" })}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {input("email", "E-mail", { type: "email", maxLength: 150 }, false)}
            {input("telephone", "Téléphone", { type: "tel", maxLength: 30 }, false)}
          </div>
          {input("service", "Service", { list: "dl-services", maxLength: 80 })}
          <div className="grid gap-4 sm:grid-cols-2">
            {input("departement", "Département", { list: "dl-departements", maxLength: 80 })}
            {input("site", "Site", { list: "dl-sites", maxLength: 80 })}
          </div>
          <datalist id="dl-services">{referentiels?.services.map((v) => <option key={v} value={v} />)}</datalist>
          <datalist id="dl-departements">{referentiels?.departements.map((v) => <option key={v} value={v} />)}</datalist>
          <datalist id="dl-sites">{referentiels?.sites.map((v) => <option key={v} value={v} />)}</datalist>

          <details className="group rounded-xl border">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-slate-700 marker:hidden">
              <span className="inline-flex items-center gap-1.5"><IdCard className="size-4 text-wm-blue" /> Fiche collaborateur (facultatif)</span>
            </summary>
            <div className="space-y-4 border-t p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {input("societe", "Société", { list: "dl-societes", maxLength: 80 }, false)}
                {input("fonction", "Fonction", { maxLength: 100 }, false)}
              </div>
              <datalist id="dl-societes">{[...new Set((managers?.data ?? []).map((m) => m.societe).filter(Boolean))].map((v) => <option key={v} value={v ?? ""} />)}</datalist>
              <Field id="f-manager_id" label="Manager" required={false}>
                <select id="f-manager_id" value={form.manager_id} onChange={set("manager_id")} className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm">
                  <option value="">Aucun</option>
                  {managers?.data.filter((m) => m.id !== editing?.id).map((m) => (
                    <option key={m.id} value={m.id}>{m.prenom} {m.nom} ({m.matricule})</option>
                  ))}
                </select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                {input("matricule_paie", "Matricule paie", { maxLength: 20 }, false)}
                <Field id="f-type_contrat" label="Type de contrat" required={false}>
                  <select id="f-type_contrat" value={form.type_contrat} onChange={set("type_contrat")} className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm">
                    <option value="">—</option>
                    {TYPES_CONTRAT.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {input("date_embauche", "Date d'embauche", { type: "date" }, false)}
                {input("date_fin_contrat", "Date de fin de contrat", { type: "date" }, false)}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {input("date_naissance", "Date de naissance", { type: "date" }, false)}
                {input("adresse", "Adresse", { maxLength: 255 }, false)}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {input("cin", "N° CIN", { maxLength: 20 }, false)}
                {input("cin_date_delivrance", "Date de délivrance du CIN", { type: "date" }, false)}
              </div>
              {input("cnss", "N° CNSS", { maxLength: 30 }, false)}

              <div className="border-t pt-4">
                <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Congés</p>
                {editing ? (
                  <p className="text-sm">Solde actuel : <span className="font-semibold">{editing.solde_conge_actuel ?? 0} j</span> <span className="text-xs text-muted-foreground">(ajustable depuis Congés → Soldes)</span></p>
                ) : (
                  input("solde_conge_initial", "Solde de congé initial (jours)", { type: "number", step: "0.5", min: "0", max: "365" }, false)
                )}
              </div>

              <div className="border-t pt-4">
                <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Paie</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  {input("salaire_base", "Salaire de base", { type: "number", step: "0.01", min: "0" }, false)}
                  {input("prime", "Prime", { type: "number", step: "0.01", min: "0" }, false)}
                  {input("indemnite", "Indemnité", { type: "number", step: "0.01", min: "0" }, false)}
                </div>
                <Field id="f-observations_rh" label="Observations RH" required={false} className="mt-4">
                  <textarea id="f-observations_rh" value={form.observations_rh} onChange={(e) => setForm((f) => ({ ...f, observations_rh: e.target.value }))} rows={2} maxLength={2000} className="w-full rounded-lg border border-input bg-white px-3 py-2 text-sm" />
                </Field>
              </div>
            </div>
          </details>

          {isAdmin && form.role !== "DIRECTION" && (
            <Field id="f-company_id" label="Société" required error={errors.company_id}>
              <select
                id="f-company_id"
                value={form.company_id}
                onChange={set("company_id")}
                className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm"
                aria-invalid={Boolean(errors.company_id)}
              >
                <option value="">Sélectionner une société…</option>
                {societes?.map((s) => <option key={s.id} value={s.id}>{s.company_name}</option>)}
              </select>
            </Field>
          )}

          <fieldset>
            <legend className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <ShieldCheck className="size-4 text-wm-blue" /> Accès à l&apos;application <span className="text-red-600">*</span>
            </legend>
            <div className="space-y-2">
              {ROLES.map((r) => {
                const disabled = isSelf && r.value !== "RH";
                return (
                  <label
                    key={r.value}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-xl border p-3 transition",
                      form.role === r.value ? "border-wm-blue bg-wm-blue-50 ring-1 ring-wm-blue" : "hover:bg-slate-50",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={r.value}
                      checked={form.role === r.value}
                      disabled={disabled}
                      onChange={() => setForm((f) => ({ ...f, role: r.value }))}
                      className="mt-1 accent-wm-blue"
                    />
                    <span>
                      <span className="block text-sm font-semibold">{r.label}</span>
                      <span className="block text-xs text-muted-foreground">{r.desc}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {isSelf && <p className="mt-2 text-xs text-muted-foreground">Vous ne pouvez pas retirer votre propre accès RH.</p>}
          </fieldset>

          <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>Annuler</Button>
            <Button type="submit" size="lg" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : editing ? <Pencil className="size-4" /> : <UserPlus className="size-4" />}
              {editing ? "Enregistrer" : "Créer le compte"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Import CSV / Excel

const HEADER_MAP: Record<string, (typeof FIELDS)[number]> = {
  matricule: "matricule", nom: "nom", prenom: "prenom", email: "email", mail: "email", adressemail: "email",
  telephone: "telephone", tel: "telephone", portable: "telephone", service: "service", departement: "departement",
  site: "site", role: "role", acces: "role", profil: "role",
};
const normalizeRole = (v: string) => {
  const r = normalizeHeader(v);
  return r.startsWith("rh") ? "RH" : r.startsWith("dir") ? "DIRECTION" : "EMPLOYE";
};

type ImportRow = Partial<FormData> & { _ligne: number };
type ImportResult = { ligne: number; matricule: string; nom: string; prenom: string; statut: "cree" | "erreur"; message?: string; mot_de_passe?: string; role?: string };

function ImportSheet({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [results, setResults] = useState<ImportResult[] | null>(null);

  useEffect(() => {
    if (open) { setRows([]); setFileName(""); setParseError(""); setProgress(null); setResults(null); }
  }, [open]);

  function template() {
    downloadFile("modele-collaborateurs-workvoice.csv", toCsv([
      ["matricule", "prenom", "nom", "email", "telephone", "service", "departement", "site", "role"],
      ["WM2001", "Nour", "Ben Salah", "nour.bensalah@workman-stid.com", "+216 20 000 000", "Confection", "Production", "Sousse", "EMPLOYE"],
      ["WM2002", "Karim", "Jaziri", "", "", "Ressources Humaines", "Administration", "Tunis", "RH"],
    ]));
  }

  async function readFile(file?: File) {
    if (!file) return;
    setParseError(""); setResults(null); setFileName(file.name);
    if (!/\.(csv|txt)$/i.test(file.name)) {
      setRows([]);
      setParseError("Enregistrez d'abord votre fichier Excel au format « CSV UTF-8 (délimité par des points-virgules) », puis importez le fichier .csv.");
      return;
    }
    const table = parseCsv(await file.text());
    if (table.length < 2) { setRows([]); setParseError("Le fichier ne contient aucune ligne de données."); return; }
    const headers = table[0].map((h) => HEADER_MAP[normalizeHeader(h)]);
    const missing = ["matricule", "nom", "prenom", "service", "departement", "site"].filter((h) => !headers.includes(h as never));
    if (missing.length) { setRows([]); setParseError(`Colonnes manquantes : ${missing.join(", ")}. Utilisez le modèle.`); return; }
    setRows(table.slice(1).map((cells, i) => {
      const row: ImportRow = { _ligne: i + 2 };
      headers.forEach((key, c) => { if (key) row[key] = (cells[c] ?? "").trim(); });
      row.role = normalizeRole(row.role ?? "");
      return row;
    }));
  }

  async function runImport() {
    const all: ImportResult[] = [];
    const batch = 100;
    setProgress(0);
    try {
      for (let i = 0; i < rows.length; i += batch) {
        const res = await api<{ data: { resultats: ImportResult[] } }>("/rh/collaborateurs/import", { method: "POST", body: { lignes: rows.slice(i, i + batch) } });
        all.push(...res.data.resultats);
        setProgress(Math.min(rows.length, i + batch));
      }
      setResults(all);
      const crees = all.filter((r) => r.statut === "cree").length;
      toast.success(`${crees} compte(s) créé(s)${all.length - crees ? `, ${all.length - crees} erreur(s)` : ""}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Import interrompu");
      if (all.length) setResults(all);
    } finally {
      setProgress(null);
    }
  }

  const crees = results?.filter((r) => r.statut === "cree") ?? [];
  const erreurs = results?.filter((r) => r.statut === "erreur") ?? [];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>Importer des collaborateurs</SheetTitle>
          <SheetDescription>Depuis un fichier Excel enregistré au format CSV. Un mot de passe provisoire est généré pour chaque compte.</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-6 py-5">
          {!results && (
            <>
              <ol className="space-y-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
                <li><strong>1.</strong> Téléchargez le modèle et remplissez-le dans Excel (une ligne par collaborateur).</li>
                <li><strong>2.</strong> Colonne <code>role</code> : EMPLOYE, RH ou DIRECTION (vide = EMPLOYE). E-mail et téléphone sont facultatifs.</li>
                <li><strong>3.</strong> Excel : <em>Fichier → Enregistrer sous → CSV UTF-8 (délimité par des points-virgules)</em>.</li>
              </ol>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={template}><Download className="size-4" /> Télécharger le modèle</Button>
                <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload className="size-4" /> Choisir le fichier CSV</Button>
                <input ref={fileRef} type="file" accept=".csv,text/csv,.txt" className="hidden" onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ""; }} />
              </div>
              {fileName && <p className="text-sm text-muted-foreground">Fichier : <span className="font-medium text-slate-800">{fileName}</span></p>}
              {parseError && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{parseError}</p>}
              {rows.length > 0 && (
                <>
                  <div className="overflow-x-auto rounded-xl border">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase">
                        <tr><th className="px-3 py-2">Ligne</th><th className="px-3 py-2">Matricule</th><th className="px-3 py-2">Nom</th><th className="px-3 py-2">Service</th><th className="px-3 py-2">Site</th><th className="px-3 py-2">Accès</th></tr>
                      </thead>
                      <tbody className="divide-y">
                        {rows.slice(0, 8).map((r) => (
                          <tr key={r._ligne}>
                            <td className="px-3 py-2 text-muted-foreground">{r._ligne}</td>
                            <td className="px-3 py-2 font-mono">{r.matricule}</td>
                            <td className="px-3 py-2">{r.prenom} {r.nom}</td>
                            <td className="px-3 py-2">{r.service}</td>
                            <td className="px-3 py-2">{r.site}</td>
                            <td className="px-3 py-2"><RoleBadge role={r.role as Role} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > 8 && <p className="border-t px-3 py-2 text-xs text-muted-foreground">… et {rows.length - 8} autre(s) ligne(s)</p>}
                  </div>
                  <Button size="lg" onClick={runImport} disabled={progress !== null} className="w-full">
                    {progress !== null ? <><Loader2 className="size-4 animate-spin" /> Import en cours… {progress}/{rows.length}</> : <><FileSpreadsheet className="size-4" /> Importer {rows.length} collaborateur(s)</>}
                  </Button>
                </>
              )}
            </>
          )}

          {results && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-emerald-50 p-4"><p className="text-2xl font-bold text-emerald-700">{crees.length}</p><p className="text-sm text-emerald-800">compte(s) créé(s)</p></div>
                <div className={cn("rounded-xl p-4", erreurs.length ? "bg-red-50" : "bg-slate-50")}><p className={cn("text-2xl font-bold", erreurs.length ? "text-red-600" : "text-slate-500")}>{erreurs.length}</p><p className="text-sm text-slate-700">ligne(s) en erreur</p></div>
              </div>
              {crees.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
                  <p className="font-semibold">Téléchargez maintenant les identifiants.</p>
                  <p className="mt-1">Les mots de passe provisoires ne seront plus affichés. Conservez ce fichier en lieu sûr et supprimez-le après distribution.</p>
                  <Button className="mt-3" onClick={() => downloadFile(`identifiants-workvoice-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([
                    ["matricule", "prenom", "nom", "acces", "mot_de_passe_provisoire", "adresse"],
                    ...crees.map((r) => [r.matricule, r.prenom, r.nom, r.role ?? "", r.mot_de_passe ?? "", window.location.origin]),
                  ]))}>
                    <Download className="size-4" /> Télécharger les identifiants ({crees.length})
                  </Button>
                </div>
              )}
              {erreurs.length > 0 && (
                <div className="overflow-hidden rounded-xl border">
                  <p className="border-b bg-slate-50 px-3 py-2 text-sm font-semibold">Lignes non importées</p>
                  <ul className="divide-y text-sm">
                    {erreurs.map((r) => (
                      <li key={r.ligne} className="px-3 py-2"><span className="font-mono text-muted-foreground">L{r.ligne}</span> · <span className="font-medium">{r.matricule || "—"} {r.prenom} {r.nom}</span> : <span className="text-red-700">{r.message}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              <Button variant="outline" onClick={onClose} className="w-full">Fermer</Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Page

export default function CollaborateursPage() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "SYSTEM_ADMIN";
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [actif, setActif] = useState("true");
  const [site, setSite] = useState("");
  const [departement, setDepartement] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [page, setPage] = useState(1);
  const [sheet, setSheet] = useState<{ open: boolean; editing: Collab | null }>({ open: false, editing: null });
  const [importOpen, setImportOpen] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(q.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const { data: ref, reload: reloadRef } = useApi<{ data: Referentiels }>("/rh/referentiels");
  const { data: societesResp } = useApi<{ data: Company[] }>(isAdmin ? "/admin/societes" : null);
  const societes = societesResp?.data;
  const societeName = (id?: number | null) => societes?.find((s) => s.id === id)?.company_name ?? "—";
  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: "25" });
    Object.entries({ q: search, role, actif, site, departement, company_id: isAdmin ? companyId : "" }).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  }, [page, search, role, actif, site, departement, companyId, isAdmin]);
  const { data, error, loading, reload } = useApi<Paged<Collab> & { stats: Stats }>(`/rh/collaborateurs?${query}`);
  const s = data?.stats;

  const refresh = () => { reload(); reloadRef(); };

  async function toggleActif(u: Collab) {
    const verb = u.actif ? "désactiver" : "réactiver";
    if (!window.confirm(`Voulez-vous ${verb} l'accès de ${u.prenom} ${u.nom} (${u.matricule}) ?${u.actif ? "\nLa personne sera déconnectée immédiatement." : ""}`)) return;
    try {
      await api(`/rh/collaborateurs/${u.id}/statut`, { method: "PATCH", body: { actif: !u.actif } });
      toast.success(u.actif ? "Accès désactivé" : "Accès réactivé");
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible");
    }
  }

  async function resetPassword(u: Collab) {
    if (!window.confirm(`Générer un nouveau mot de passe provisoire pour ${u.prenom} ${u.nom} ?\nL'ancien mot de passe ne fonctionnera plus.`)) return;
    try {
      const res = await api<{ data: Collab; mot_de_passe_temporaire: string }>(`/rh/collaborateurs/${u.id}/mot-de-passe`, { method: "POST" });
      setSecret({ titre: "Mot de passe réinitialisé", prenom: u.prenom, nom: u.nom, matricule: u.matricule, password: res.mot_de_passe_temporaire });
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible");
    }
  }

  return (
    <>
      <PageHeader
        title="Collaborateurs & accès"
        description="Créez les comptes des collaborateurs Workman et attribuez leurs accès à WORKVOICE."
        actions={
          <>
            <Button variant="outline" onClick={() => setImportOpen(true)}><FileSpreadsheet className="size-4" /> Importer (Excel/CSV)</Button>
            <Button onClick={() => setSheet({ open: true, editing: null })}><UserPlus className="size-4" /> Ajouter un collaborateur</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Comptes actifs" value={s?.actifs ?? "–"} icon={Users} tone="blue" hint={s && `${s.inactifs} désactivé(s)`} />
        <KpiCard label="Employés" value={s?.employes ?? "–"} icon={UserRoundCheck} tone="slate" />
        <KpiCard label="RH · Direction" value={s ? `${s.rh} · ${s.direction}` : "–"} icon={ShieldCheck} tone="yellow" />
        <KpiCard label="En attente de 1re connexion" value={s?.en_attente_activation ?? "–"} icon={KeyRound} tone="green" hint="Mot de passe provisoire non encore changé" />
      </div>

      <div className={cn("mt-6 mb-4 grid gap-2 rounded-xl border bg-card p-3 shadow-xs sm:grid-cols-2", isAdmin ? "lg:grid-cols-[1.4fr_repeat(5,1fr)]" : "lg:grid-cols-[1.6fr_repeat(4,1fr)]")}>
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Matricule, nom, e-mail…" className="h-9 pl-9" aria-label="Rechercher" />
        </div>
        {isAdmin && (
          <NativeSelect value={companyId} onChange={(e) => { setCompanyId(e.target.value); setPage(1); }} aria-label="Société">
            <option value="">Toutes les sociétés</option>
            {societes?.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
          </NativeSelect>
        )}
        <NativeSelect value={actif} onChange={(e) => { setActif(e.target.value); setPage(1); }} aria-label="Statut">
          <option value="true">Comptes actifs</option>
          <option value="false">Comptes désactivés</option>
          <option value="">Tous les comptes</option>
        </NativeSelect>
        <NativeSelect value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }} aria-label="Accès">
          <option value="">Tous les accès</option>
          {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </NativeSelect>
        <NativeSelect value={site} onChange={(e) => { setSite(e.target.value); setPage(1); }} aria-label="Site">
          <option value="">Tous les sites</option>
          {ref?.data.sites.map((v) => <option key={v}>{v}</option>)}
        </NativeSelect>
        <NativeSelect value={departement} onChange={(e) => { setDepartement(e.target.value); setPage(1); }} aria-label="Département">
          <option value="">Tous les départements</option>
          {ref?.data.departements.map((v) => <option key={v}>{v}</option>)}
        </NativeSelect>
      </div>

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data && loading ? (
        <LoadingBlock rows={8} />
      ) : !data?.data.length ? (
        <EmptyState title="Aucun collaborateur" description="Aucun compte ne correspond à ces critères." action={<Button onClick={() => setSheet({ open: true, editing: null })}><UserPlus className="size-4" /> Ajouter un collaborateur</Button>} />
      ) : (
        <div className={cn("overflow-hidden rounded-xl border bg-card shadow-xs transition", loading && "opacity-60")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Collaborateur</th>
                  {isAdmin && <th className="px-4 py-3">Société</th>}
                  <th className="px-4 py-3">Service · Département</th>
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Accès</th>
                  <th className="px-4 py-3">Dernière connexion</th>
                  <th className="w-12 px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.data.map((u) => (
                  <tr key={u.id} className={cn("transition hover:bg-slate-50", !u.actif && "bg-slate-50/70 text-muted-foreground")}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-800">
                        {u.prenom} {u.nom}
                        {u.id === me?.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(vous)</span>}
                      </p>
                      <p className="text-xs text-muted-foreground"><span className="font-mono">{u.matricule}</span>{u.email && ` · ${u.email}`}</p>
                    </td>
                    {isAdmin && <td className="px-4 py-3">{u.role === "DIRECTION" ? "Groupe" : societeName(u.company_id)}</td>}
                    <td className="px-4 py-3"><p>{u.service}</p><p className="text-xs text-muted-foreground">{u.departement}</p></td>
                    <td className="px-4 py-3">{u.site}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <RoleBadge role={u.role} />
                        {!u.actif && <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-red-600/20 ring-inset">Désactivé</span>}
                        {u.actif && u.mdp_temporaire && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-500/30 ring-inset">1re connexion</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">{u.derniere_connexion ? formatDateTime(u.derniere_connexion) : "Jamais"}</td>
                    <td className="px-4 py-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger className="inline-flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label={`Actions pour ${u.prenom} ${u.nom}`}>
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-60">
                          <DropdownMenuItem onClick={() => setSheet({ open: true, editing: u })}><Pencil className="size-4" /> Modifier / changer l&apos;accès</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => resetPassword(u)}><KeyRound className="size-4" /> Réinitialiser le mot de passe</DropdownMenuItem>
                          {u.id !== me?.id && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => toggleActif(u)} className={u.actif ? "text-red-600" : "text-emerald-700"}>
                                <Power className="size-4" /> {u.actif ? "Désactiver l'accès" : "Réactiver l'accès"}
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
            <span className="text-muted-foreground">{data.total} collaborateur(s) · page {data.page} sur {data.pages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-4" /> Précédent</Button>
              <Button variant="outline" size="sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Suivant <ChevronRight className="size-4" /></Button>
            </div>
          </div>
        </div>
      )}

      <CollaborateurSheet
        open={sheet.open}
        editing={sheet.editing}
        referentiels={ref?.data}
        societes={societes}
        currentUserId={me?.id}
        onClose={() => setSheet({ open: false, editing: null })}
        onSaved={(u, password) => {
          setSheet({ open: false, editing: null });
          refresh();
          if (password) setSecret({ titre: "Compte créé", prenom: u.prenom, nom: u.nom, matricule: u.matricule, password });
        }}
      />
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

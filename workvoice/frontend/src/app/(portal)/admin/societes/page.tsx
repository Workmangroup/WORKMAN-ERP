"use client";

import { useEffect, useState } from "react";
import { Building2, Loader2, Pencil, Plus, ShieldCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import { Field, PageHeader } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Company } from "@/types";

const FIELDS = ["company_code", "company_name", "legal_name", "address", "city", "phone", "email", "tax_number"] as const;
type FormData = Record<(typeof FIELDS)[number], string> & { status: "ACTIVE" | "INACTIVE" };
const EMPTY_FORM: FormData = {
  company_code: "", company_name: "", legal_name: "", address: "", city: "", phone: "", email: "", tax_number: "", status: "ACTIVE",
};

function SocieteDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Company | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setForm(
      editing
        ? { ...Object.fromEntries(FIELDS.map((k) => [k, String(editing[k as keyof Company] ?? "")])), status: editing.status } as FormData
        : EMPTY_FORM,
    );
  }, [open, editing]);

  const set = (k: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!editing && !form.company_code.trim()) errs.company_code = "Obligatoire";
    if (!form.company_name.trim()) errs.company_name = "Obligatoire";
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSaving(true);
    try {
      await api(editing ? `/admin/societes/${editing.id}` : "/admin/societes", { method: editing ? "PATCH" : "POST", body: form });
      toast.success(editing ? "Société mise à jour" : "Société créée");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        toast.error(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  const input = (k: (typeof FIELDS)[number], label: string, props: React.ComponentProps<"input"> = {}, required = false) => (
    <Field id={`s-${k}`} label={label} required={required} error={errors[k]}>
      <Input id={`s-${k}`} value={form[k]} onChange={set(k)} className="h-10" aria-invalid={Boolean(errors[k])} {...props} />
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Modifier ${editing.company_name}` : "Nouvelle société"}</DialogTitle>
          <DialogDescription>
            {editing ? "Coordonnées et statut de la société." : "Le code société est utilisé en interne, il ne peut pas être modifié ensuite."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {editing ? (
              <Field id="s-company_code" label="Code société">
                <Input id="s-company_code" value={form.company_code} disabled className="h-10 bg-slate-50 uppercase" />
              </Field>
            ) : (
              input("company_code", "Code société", { placeholder: "Ex. SOMICO", className: "h-10 uppercase", maxLength: 20 }, true)
            )}
            {input("company_name", "Nom de la société", { maxLength: 120 }, true)}
          </div>
          {input("legal_name", "Raison sociale", { maxLength: 180 })}
          <div className="grid gap-4 sm:grid-cols-2">
            {input("address", "Adresse", { maxLength: 255 })}
            {input("city", "Ville", { maxLength: 80 })}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {input("phone", "Téléphone", { type: "tel", maxLength: 30 })}
            {input("email", "E-mail", { type: "email", maxLength: 150 })}
          </div>
          {input("tax_number", "Matricule fiscal", { maxLength: 40 })}

          {editing && (
            <Field id="s-status" label="Statut">
              <select
                id="s-status"
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as "ACTIVE" | "INACTIVE" }))}
                className="h-10 w-full rounded-lg border border-input bg-white px-3 text-sm"
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive (bloque toute nouvelle opération RH)</option>
              </select>
            </Field>
          )}

          <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>Annuler</Button>
            <Button type="submit" size="lg" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : editing ? <Pencil className="size-4" /> : <Plus className="size-4" />}
              {editing ? "Enregistrer" : "Créer la société"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function SocietesPage() {
  const { data, error, loading, reload } = useApi<{ data: Company[] }>("/admin/societes");
  const [dialog, setDialog] = useState<{ open: boolean; editing: Company | null }>({ open: false, editing: null });
  const societes = data?.data ?? [];
  const totalCollaborateurs = societes.reduce((n, s) => n + s.nb_collaborateurs, 0);
  const totalRh = societes.reduce((n, s) => n + s.nb_rh, 0);

  return (
    <>
      <PageHeader
        title="Sociétés"
        description="Gérez les sociétés du groupe et leur rattachement RH."
        actions={<Button onClick={() => setDialog({ open: true, editing: null })}><Plus className="size-4" /> Nouvelle société</Button>}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Sociétés" value={societes.length || "–"} icon={Building2} tone="blue" hint={`${societes.filter((s) => s.status === "ACTIVE").length} active(s)`} />
        <KpiCard label="Collaborateurs (total)" value={totalCollaborateurs || "–"} icon={Users} tone="slate" />
        <KpiCard label="RH (total)" value={totalRh || "–"} icon={ShieldCheck} tone="yellow" />
      </div>

      <div className="mt-6">
        {error ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : !data && loading ? (
          <LoadingBlock rows={4} />
        ) : !societes.length ? (
          <EmptyState title="Aucune société" description="Créez la première société du groupe." action={<Button onClick={() => setDialog({ open: true, editing: null })}><Plus className="size-4" /> Nouvelle société</Button>} />
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
                  <tr>
                    <th className="px-4 py-3">Société</th>
                    <th className="px-4 py-3">Ville</th>
                    <th className="px-4 py-3">Collaborateurs</th>
                    <th className="px-4 py-3">RH</th>
                    <th className="px-4 py-3">Statut</th>
                    <th className="w-12 px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {societes.map((s) => (
                    <tr key={s.id} className={cn("transition hover:bg-slate-50", s.status === "INACTIVE" && "bg-slate-50/70 text-muted-foreground")}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-800">{s.company_name}</p>
                        <p className="text-xs text-muted-foreground"><span className="font-mono">{s.company_code}</span>{s.legal_name && ` · ${s.legal_name}`}</p>
                      </td>
                      <td className="px-4 py-3">{s.city ?? "—"}</td>
                      <td className="px-4 py-3">{s.nb_collaborateurs}</td>
                      <td className="px-4 py-3">{s.nb_rh}</td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                          s.status === "ACTIVE" ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-red-50 text-red-700 ring-red-600/20",
                        )}>
                          {s.status === "ACTIVE" ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="outline" size="sm" onClick={() => setDialog({ open: true, editing: s })}>
                          <Pencil className="size-4" /> Modifier
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <SocieteDialog open={dialog.open} editing={dialog.editing} onClose={() => setDialog({ open: false, editing: null })} onSaved={() => { setDialog({ open: false, editing: null }); reload(); }} />
    </>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BadgeCheck,
  Banknote,
  CalendarDays,
  CalendarRange,
  FileText,
  GraduationCap,
  Loader2,
  MoreHorizontal,
  Send,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { TYPES_DEMANDE } from "@/lib/constants";
import { Field, PageHeader } from "@/components/common/form";
import { ChoiceGrid, type Choice } from "@/components/tickets/choice-grid";
import { ticketHref } from "@/components/tickets/ticket-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const ICONS: Record<string, Choice["icon"]> = {
  ATTESTATION_TRAVAIL: BadgeCheck,
  ATTESTATION_SALAIRE: Banknote,
  SOLDE_CONGES: CalendarRange,
  CONGE: CalendarDays,
  AVANCE_SALAIRE: Wallet,
  FORMATION: GraduationCap,
  AUTRE: MoreHorizontal,
};
const CHOICES: Choice[] = Object.entries(TYPES_DEMANDE).map(([value, label]) => ({ value, label, icon: ICONS[value] }));

const MAX_MB = 5;
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.doc,.docx";

export default function NouvelleDemandePage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState("");
  const [objet, setObjet] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function pickFile(f: File | undefined) {
    if (!f) return;
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (!ACCEPT.split(",").includes(ext)) return setErrors((e) => ({ ...e, piece_jointe: "Formats acceptés : PDF, JPG, PNG, DOC, DOCX" }));
    if (f.size > MAX_MB * 1024 * 1024) return setErrors((e) => ({ ...e, piece_jointe: `Fichier trop volumineux (max ${MAX_MB} Mo)` }));
    setErrors(({ piece_jointe: _omit, ...rest }) => rest);
    setFile(f);
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!type) e.type_demande = "Choisissez un type de demande";
    if (objet.trim().length < 3) e.objet = "L'objet doit contenir au moins 3 caractères";
    if (description.trim().length < 10) e.description = "La description doit contenir au moins 10 caractères";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    const form = new FormData();
    form.append("type_demande", type);
    form.append("objet", objet.trim());
    form.append("description", description.trim());
    if (file) form.append("piece_jointe", file);
    try {
      const { data } = await api<{ data: { id: number; numero: string } }>("/demandes", { method: "POST", body: form });
      toast.success(`Demande ${data.numero} envoyée`, { description: "Le service RH a été notifié." });
      router.push(ticketHref("employe", "demande", data.id));
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        toast.error(err.message);
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Nouvelle demande RH" description="Votre demande est transmise directement au service Ressources Humaines." />
      <form onSubmit={onSubmit} noValidate className="space-y-6 rounded-xl border bg-card p-5 shadow-xs sm:p-7">
        <Field id="type" label="Type de demande" required error={errors.type_demande}>
          <ChoiceGrid name="type_demande" choices={CHOICES} value={type} onChange={setType} invalid={Boolean(errors.type_demande)} />
        </Field>

        <Field id="objet" label="Objet" required error={errors.objet}>
          <Input id="objet" value={objet} onChange={(e) => setObjet(e.target.value)} maxLength={150} placeholder="Ex. Attestation de travail pour dossier bancaire" aria-invalid={Boolean(errors.objet)} className="h-10" />
        </Field>

        <Field id="description" label="Description" required error={errors.description} hint={`${description.length}/5000 caractères`}>
          <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} maxLength={5000} placeholder="Précisez votre demande : dates, motif, informations utiles…" aria-invalid={Boolean(errors.description)} />
        </Field>

        <Field id="piece_jointe" label="Pièce jointe" error={errors.piece_jointe} hint={`Facultatif · PDF, JPG, PNG, DOC, DOCX · ${MAX_MB} Mo max`}>
          {file ? (
            <div className="flex items-center gap-3 rounded-lg border bg-slate-50 px-4 py-3">
              <FileText className="size-5 text-wm-blue" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} Ko</p>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setFile(null)} aria-label="Retirer le fichier">
                <X className="size-4" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files[0]); }}
              className={`flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-7 text-sm transition ${dragOver ? "border-wm-blue bg-wm-blue-50" : "border-slate-300 hover:border-wm-blue hover:bg-slate-50"}`}
            >
              <Upload className="size-6 text-wm-blue" />
              <span><span className="font-semibold text-wm-blue">Choisir un fichier</span> ou glissez-le ici</span>
            </button>
          )}
          <input id="piece_jointe" ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
        </Field>

        <div className="flex flex-col-reverse gap-3 border-t pt-5 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" size="lg" onClick={() => router.back()}>
            Annuler
          </Button>
          <Button type="submit" size="lg" disabled={submitting} className="px-5">
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Envoyer
          </Button>
        </div>
      </form>
    </div>
  );
}

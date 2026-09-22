"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Banknote,
  Building,
  HardHat,
  Loader2,
  Lock,
  MoreHorizontal,
  Send,
  ShieldAlert,
  ThermometerSun,
  UserX,
  Users,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { CATEGORIES, URGENCES, URGENCE_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { Field, PageHeader } from "@/components/common/form";
import { ChoiceGrid, type Choice } from "@/components/tickets/choice-grid";
import { ticketHref } from "@/components/tickets/ticket-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Urgence } from "@/types";

const ICONS: Record<string, Choice["icon"]> = {
  PAIE: Banknote,
  CONDITIONS_TRAVAIL: ThermometerSun,
  RESPONSABLE_HIERARCHIQUE: Users,
  EQUIPEMENT: Wrench,
  SECURITE: HardHat,
  HARCELEMENT: UserX,
  ORGANISATION: Building,
  AUTRE: MoreHorizontal,
};
const CHOICES: Choice[] = Object.entries(CATEGORIES).map(([value, label]) => ({ value, label, icon: ICONS[value] }));

const URGENCE_HINTS: Record<Urgence, string> = {
  FAIBLE: "Gêne mineure",
  MOYEN: "À traiter rapidement",
  ELEVE: "Impact important",
  CRITIQUE: "Danger ou situation grave",
};

const URGENCE_SELECTED: Record<Urgence, string> = {
  FAIBLE: "border-slate-500 bg-slate-50 ring-slate-500",
  MOYEN: "border-sky-600 bg-sky-50 ring-sky-600",
  ELEVE: "border-orange-500 bg-orange-50 ring-orange-500",
  CRITIQUE: "border-red-600 bg-red-50 ring-red-600",
};

export default function NouvelleReclamationPage() {
  const router = useRouter();
  const [categorie, setCategorie] = useState("");
  const [objet, setObjet] = useState("");
  const [description, setDescription] = useState("");
  const [urgence, setUrgence] = useState<Urgence>("MOYEN");
  const [confidentielle, setConfidentielle] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const forcedConfidential = categorie === "HARCELEMENT";
  const isConfidential = confidentielle || forcedConfidential;

  function validate() {
    const e: Record<string, string> = {};
    if (!categorie) e.categorie = "Choisissez une catégorie";
    if (objet.trim().length < 3) e.objet = "L'objet doit contenir au moins 3 caractères";
    if (description.trim().length < 20) e.description = "Décrivez la situation en au moins 20 caractères";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const { data } = await api<{ data: { id: number; numero: string } }>("/reclamations", {
        method: "POST",
        body: { categorie, objet: objet.trim(), description: description.trim(), niveau_urgence: urgence, confidentielle: isConfidential },
      });
      toast.success(`Réclamation ${data.numero} envoyée`, { description: "Le service RH a été notifié." });
      router.push(ticketHref("employe", "reclamation", data.id));
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
      <PageHeader title="Nouvelle réclamation" description="Signalez une situation. Votre réclamation est traitée par le service RH." />
      <form onSubmit={onSubmit} noValidate className="space-y-6 rounded-xl border bg-card p-5 shadow-xs sm:p-7">
        <Field id="categorie" label="Catégorie" required error={errors.categorie}>
          <ChoiceGrid name="categorie" choices={CHOICES} value={categorie} onChange={setCategorie} invalid={Boolean(errors.categorie)} />
        </Field>

        <Field id="objet" label="Objet" required error={errors.objet}>
          <Input id="objet" value={objet} onChange={(e) => setObjet(e.target.value)} maxLength={150} placeholder="Résumez la situation en une phrase" aria-invalid={Boolean(errors.objet)} className="h-10" />
        </Field>

        <Field id="description" label="Description détaillée" required error={errors.description} hint="Faits, lieu, date, fréquence… Évitez de citer des noms si ce n'est pas nécessaire.">
          <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={7} maxLength={5000} aria-invalid={Boolean(errors.description)} />
        </Field>

        <Field id="urgence" label="Niveau d'urgence" required>
          <div role="radiogroup" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {URGENCES.map((u) => (
              <label
                key={u}
                className={cn(
                  "cursor-pointer rounded-xl border bg-white p-3 transition focus-within:ring-3 focus-within:ring-ring/40",
                  urgence === u ? cn("ring-1", URGENCE_SELECTED[u]) : "hover:bg-slate-50",
                )}
              >
                <input type="radio" name="urgence" value={u} checked={urgence === u} onChange={() => setUrgence(u)} className="sr-only" />
                <span className={cn("block text-sm font-semibold", u === "CRITIQUE" && "text-red-700")}>{URGENCE_LABELS[u]}</span>
                <span className="block text-[11px] text-muted-foreground">{URGENCE_HINTS[u]}</span>
              </label>
            ))}
          </div>
          {urgence === "CRITIQUE" && (
            <p className="mt-2 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-800">
              <ShieldAlert className="size-4 shrink-0" />
              Une réclamation critique alerte immédiatement le service RH et la Direction (de façon anonyme). En cas de danger immédiat, prévenez aussi votre responsable sécurité.
            </p>
          )}
        </Field>

        <label
          className={cn(
            "flex cursor-pointer gap-3 rounded-xl border p-4 transition",
            isConfidential ? "border-wm-yellow bg-wm-yellow-50" : "hover:bg-slate-50",
            forcedConfidential && "cursor-default",
          )}
        >
          <input
            type="checkbox"
            checked={isConfidential}
            disabled={forcedConfidential}
            onChange={(e) => setConfidentielle(e.target.checked)}
            className="mt-0.5 size-4.5 shrink-0 accent-wm-blue"
          />
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Lock className="size-4 text-amber-700" /> Réclamation confidentielle
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-slate-600">
              <li>• Le service RH voit votre identité pour pouvoir vous répondre.</li>
              <li>• La Direction voit uniquement le contenu, votre département et votre site, sans nom ni service.</li>
              {forcedConfidential && <li className="font-medium text-amber-900">• Les signalements de harcèlement sont toujours confidentiels.</li>}
            </ul>
          </div>
        </label>

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

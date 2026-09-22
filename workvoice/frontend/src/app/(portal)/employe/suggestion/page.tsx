"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building, Heart, Laptop, Leaf, Lightbulb, Loader2, MoreHorizontal, Send, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { THEMES } from "@/lib/constants";
import { Field, PageHeader } from "@/components/common/form";
import { ChoiceGrid, type Choice } from "@/components/tickets/choice-grid";
import { ticketHref } from "@/components/tickets/ticket-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const ICONS: Record<string, Choice["icon"]> = {
  ORGANISATION: Building,
  QUALITE: Sparkles,
  SECURITE: ShieldCheck,
  BIEN_ETRE: Heart,
  ENVIRONNEMENT: Leaf,
  DIGITAL: Laptop,
  AUTRE: MoreHorizontal,
};
const CHOICES: Choice[] = Object.entries(THEMES).map(([value, label]) => ({ value, label, icon: ICONS[value] }));

export default function SuggestionPage() {
  const router = useRouter();
  const [theme, setTheme] = useState("");
  const [objet, setObjet] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (!theme) e.theme = "Choisissez un thème";
    if (objet.trim().length < 3) e.objet = "Le titre doit contenir au moins 3 caractères";
    if (description.trim().length < 10) e.description = "Décrivez votre idée en au moins 10 caractères";
    setErrors(e);
    if (Object.keys(e).length) return;

    setSubmitting(true);
    try {
      const { data } = await api<{ data: { id: number; numero: string } }>("/suggestions", {
        method: "POST",
        body: { theme, objet: objet.trim(), description: description.trim() },
      });
      toast.success("Merci pour votre suggestion !", { description: `Référence ${data.numero}` });
      router.push(ticketHref("employe", "suggestion", data.id));
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
      <PageHeader title="Faire une suggestion" description="Une idée pour améliorer le quotidien chez Workman ? Partagez-la." />
      <div className="mb-6 flex items-start gap-3 rounded-xl bg-wm-blue p-5 text-white">
        <Lightbulb className="size-6 shrink-0 text-wm-yellow" />
        <p className="text-sm text-blue-50">
          Chaque suggestion est étudiée par le service RH et, si elle est retenue, présentée à la Direction. Vous serez informé(e) de la suite donnée.
        </p>
      </div>
      <form onSubmit={onSubmit} noValidate className="space-y-6 rounded-xl border bg-card p-5 shadow-xs sm:p-7">
        <Field id="theme" label="Thème" required error={errors.theme}>
          <ChoiceGrid name="theme" choices={CHOICES} value={theme} onChange={setTheme} invalid={Boolean(errors.theme)} />
        </Field>
        <Field id="objet" label="Titre de votre idée" required error={errors.objet}>
          <Input id="objet" value={objet} onChange={(e) => setObjet(e.target.value)} maxLength={150} aria-invalid={Boolean(errors.objet)} className="h-10" />
        </Field>
        <Field id="description" label="Description" required error={errors.description} hint="Le constat, votre proposition et les bénéfices attendus.">
          <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} maxLength={5000} aria-invalid={Boolean(errors.description)} />
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

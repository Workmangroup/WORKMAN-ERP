"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock, CheckCircle2, ClipboardCheck, Loader2, Send, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { ECHELLE_QSP } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Campagne, QuestionQsp } from "@/types";

interface Actif {
  campagne: Campagne | null;
  questions: QuestionQsp[];
  deja_repondu: boolean;
}

function Merci() {
  return (
    <div className="mx-auto max-w-xl rounded-2xl border bg-card p-10 text-center shadow-xs">
      <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-emerald-50">
        <CheckCircle2 className="size-9 text-emerald-600" />
      </div>
      <h1 className="text-2xl font-bold text-slate-900">Merci pour votre participation !</h1>
      <p lang="ar" dir="rtl" className="mt-1 font-arabic text-xl text-slate-700">شكرًا على مشاركتكم</p>
      <p className="mt-4 text-sm text-muted-foreground">
        Vos réponses ont été enregistrées de manière anonyme. Les résultats globaux aideront la Direction et le service RH à
        améliorer la vie au travail.
      </p>
      <Link href="/employe/" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "mt-6")}>
        Retour au tableau de bord
      </Link>
    </div>
  );
}

export default function QuestionnairePage() {
  const { data, error, loading, reload } = useApi<{ data: Actif }>("/questionnaire/actif");
  const [notes, setNotes] = useState<Record<number, number>>({});
  const [commentaire, setCommentaire] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [showMissing, setShowMissing] = useState(false);

  const questions = useMemo(() => data?.data.questions ?? [], [data]);
  const answered = questions.filter((q) => notes[q.id]).length;
  const progress = questions.length ? Math.round((answered / questions.length) * 100) : 0;

  if (loading && !data) return <LoadingBlock rows={8} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const d = data!.data;

  if (done || d.deja_repondu) return <Merci />;
  if (!d.campagne) {
    return (
      <EmptyState
        title="Aucun questionnaire en cours"
        description="Vous serez notifié(e) dès l'ouverture du prochain questionnaire de satisfaction."
      />
    );
  }
  const campagne = d.campagne;

  async function submit() {
    const missing = questions.filter((q) => !notes[q.id]);
    if (missing.length) {
      setShowMissing(true);
      document.getElementById(`q-${missing[0].id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      toast.error(`Il reste ${missing.length} question${missing.length > 1 ? "s" : ""} sans réponse`);
      return;
    }
    setSubmitting(true);
    try {
      await api(`/questionnaire/campagnes/${campagne.id}/reponses`, {
        method: "POST",
        body: {
          reponses: questions.map((q) => ({ question_id: q.id, note: notes[q.id] })),
          commentaire: commentaire.trim() || undefined,
        },
      });
      setDone(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Envoi impossible");
      if (err instanceof ApiError && err.status === 409) reload();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* En-tête du formulaire (fidèle au document GRH-IFD-23) */}
      <header className="overflow-hidden rounded-2xl border bg-card shadow-xs">
        <div className="flex flex-col gap-4 bg-wm-blue px-6 py-6 text-white sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold tracking-wider text-wm-yellow uppercase">
              <ClipboardCheck className="size-4" /> {campagne.titre}
            </p>
            <h1 className="mt-2 text-xl font-bold sm:text-2xl">Questionnaire de satisfaction du personnel</h1>
            <p lang="ar" dir="rtl" className="mt-1 text-right font-arabic text-lg text-blue-100 sm:text-left">
              إستطلاع رضا الموظف
            </p>
          </div>
          <dl className="shrink-0 rounded-lg bg-white/10 px-4 py-2.5 text-xs leading-relaxed text-blue-100 ring-1 ring-white/15">
            <div><dt className="inline">Réf. : </dt><dd className="inline font-semibold text-white">{campagne.reference}</dd></div>
            <div><dt className="inline">Version : </dt><dd className="inline font-semibold text-white">01</dd></div>
            {campagne.date_fin && (
              <div className="flex items-center gap-1">
                <CalendarClock className="size-3.5" /> Jusqu&apos;au <span className="font-semibold text-white">{formatDate(campagne.date_fin)}</span>
              </div>
            )}
          </dl>
        </div>
        <div className="flex gap-3 bg-wm-yellow-50 px-6 py-4 text-sm text-amber-950">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-amber-700" />
          <div className="grid flex-1 gap-2 sm:grid-cols-2 sm:gap-6">
            <p>
              <strong>Vos réponses sont anonymes.</strong> Elles ne sont jamais reliées à votre nom, y compris pour le service RH.
              Les résultats ne sont publiés que pour des groupes d&apos;au moins 5 personnes.
            </p>
            <p lang="ar" dir="rtl" className="font-arabic leading-relaxed">
              <strong>إجاباتكم مجهولة الهوية.</strong> لا يتم ربطها باسمكم أبدًا، ولا تُنشر النتائج إلا لمجموعات من 5 أشخاص على الأقل.
            </p>
          </div>
        </div>
      </header>

      {/* Progression */}
      <div className="sticky top-16 z-10 -mx-4 mt-5 border-b bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:px-5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-slate-700">Progression</span>
          <span className="tabular-nums text-muted-foreground">{answered} / {questions.length}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-gradient-to-r from-wm-blue to-wm-yellow transition-all duration-300" style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* Questions */}
      <ol className="mt-5 space-y-4">
        {questions.map((q) => {
          const value = notes[q.id];
          const missing = showMissing && !value;
          return (
            <li
              key={q.id}
              id={`q-${q.id}`}
              className={cn("scroll-mt-40 rounded-xl border bg-card p-5 shadow-xs transition", missing && "border-red-300 ring-1 ring-red-200", value && "border-wm-blue/25")}
            >
              <fieldset>
                <legend className="flex w-full gap-3">
                  <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold", value ? "bg-wm-blue text-white" : "bg-slate-100 text-slate-600")}>
                    {q.ordre}
                  </span>
                  <span className="flex-1 space-y-1">
                    <span className="block font-medium text-slate-900">{q.texte_fr}</span>
                    <span lang="ar" dir="rtl" className="block text-right font-arabic text-[15px] text-slate-600">{q.texte_ar}</span>
                  </span>
                </legend>
                <div className="mt-4 grid gap-2 sm:grid-cols-5">
                  {ECHELLE_QSP.map((opt) => {
                    const selected = value === opt.note;
                    return (
                      <label
                        key={opt.note}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border bg-white px-3 py-2.5 transition focus-within:ring-3 focus-within:ring-ring/40 sm:flex-col sm:gap-1.5 sm:py-3 sm:text-center",
                          selected ? cn("ring-2", opt.ring, opt.soft, "border-transparent") : "hover:bg-slate-50",
                        )}
                      >
                        <input
                          type="radio"
                          name={`q-${q.id}`}
                          value={opt.note}
                          checked={selected}
                          onChange={() => {
                            setNotes((n) => ({ ...n, [q.id]: opt.note }));
                          }}
                          className="sr-only"
                        />
                        <span className={cn("size-3.5 shrink-0 rounded-full ring-2 ring-offset-2", opt.ring, selected ? opt.color : "bg-white")} />
                        <span className="flex-1 sm:flex-none">
                          <span className="block text-sm leading-tight font-medium">{opt.fr}</span>
                          <span lang="ar" dir="rtl" className="block font-arabic text-xs leading-snug text-muted-foreground sm:mt-0.5">
                            {opt.ar.split(" / ")[0]}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {missing && <p className="mt-2 text-xs font-medium text-red-600">Merci de choisir une réponse · يرجى اختيار إجابة</p>}
              </fieldset>
            </li>
          );
        })}
      </ol>

      <section className="mt-4 rounded-xl border bg-card p-5 shadow-xs">
        <label htmlFor="commentaire" className="font-medium text-slate-900">
          Commentaire ou suggestion <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <p lang="ar" dir="rtl" className="text-right font-arabic text-sm text-slate-600">ملاحظات أو اقتراحات (اختياري)</p>
        <Textarea
          id="commentaire"
          value={commentaire}
          onChange={(e) => setCommentaire(e.target.value)}
          rows={4}
          maxLength={2000}
          className="mt-3"
          placeholder="Pour préserver votre anonymat, évitez de citer des noms ou des détails qui permettraient de vous reconnaître."
        />
      </section>

      <div className="mt-6 flex flex-col-reverse items-center gap-3 pb-8 sm:flex-row sm:justify-end">
        <p className="text-xs text-muted-foreground">Une seule participation par campagne.</p>
        <Button size="lg" onClick={submit} disabled={submitting} className="h-11 w-full px-6 text-base sm:w-auto">
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Envoyer mes réponses · إرسال
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { Field, PageHeader } from "@/components/common/form";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { CampagnesTable } from "@/components/questionnaire/campagnes-table";
import { ResultatsQuestionnaire } from "@/components/questionnaire/resultats";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Campagne } from "@/types";

const today = () => new Date().toISOString().slice(0, 10);

function NouvelleCampagne({ onCreated, onCancel }: { onCreated: (id: number) => void; onCancel: () => void }) {
  const [titre, setTitre] = useState(`Baromètre social — ${new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(new Date())}`);
  const [debut, setDebut] = useState(today());
  const [fin, setFin] = useState("");
  const [ouvrir, setOuvrir] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const { data } = await api<{ data: { id: number } }>("/questionnaire/campagnes", {
        method: "POST",
        body: { titre, date_debut: debut, date_fin: fin, ouvrir },
      });
      toast.success(ouvrir ? "Campagne ouverte : les collaborateurs ont été notifiés" : "Campagne créée (brouillon)");
      onCreated(data.id);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        toast.error(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-6 rounded-xl border border-wm-blue/20 bg-card p-5 shadow-xs" noValidate>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Nouvelle campagne — questionnaire GRH-IFD-23</h2>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onCancel} aria-label="Fermer"><X className="size-4" /></Button>
      </div>
      <div className="grid gap-4 md:grid-cols-[2fr_1fr_1fr]">
        <Field id="titre" label="Titre" required error={errors.titre}>
          <Input id="titre" value={titre} onChange={(e) => setTitre(e.target.value)} maxLength={150} className="h-10" />
        </Field>
        <Field id="debut" label="Début" required error={errors.date_debut}>
          <Input id="debut" type="date" value={debut} onChange={(e) => setDebut(e.target.value)} className="h-10" />
        </Field>
        <Field id="fin" label="Fin" error={errors.date_fin} hint="Facultatif">
          <Input id="fin" type="date" value={fin} min={debut} onChange={(e) => setFin(e.target.value)} className="h-10" />
        </Field>
      </div>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ouvrir} onChange={(e) => setOuvrir(e.target.checked)} className="size-4 accent-wm-blue" />
          Ouvrir immédiatement et notifier les collaborateurs
        </label>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />} Créer la campagne
        </Button>
      </div>
    </form>
  );
}

export default function RhQuestionnairePage() {
  const { data, error, loading, reload } = useApi<{ data: Campagne[] }>("/questionnaire/campagnes");
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const campagnes = data?.data ?? [];

  useEffect(() => {
    if (selected === null && campagnes.length) setSelected((campagnes.find((c) => c.statut === "OUVERTE") ?? campagnes[0]).id);
  }, [campagnes, selected]);

  async function changeStatut(c: Campagne, statut: "OUVERTE" | "CLOTUREE") {
    if (statut === "CLOTUREE" && !window.confirm(`Clôturer « ${c.titre} » ? Les collaborateurs ne pourront plus répondre.`)) return;
    try {
      await api(`/questionnaire/campagnes/${c.id}/statut`, { method: "PATCH", body: { statut } });
      toast.success(statut === "OUVERTE" ? "Campagne ouverte : les collaborateurs ont été notifiés" : "Campagne clôturée");
      reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Action impossible");
    }
  }

  const current = campagnes.find((c) => c.id === selected);

  return (
    <>
      <PageHeader
        title="Satisfaction du personnel"
        description={<>Questionnaire GRH-IFD-23 · <span lang="ar" dir="rtl" className="font-arabic">إستطلاع رضا الموظف</span></>}
        actions={!creating && <Button onClick={() => setCreating(true)}><Plus className="size-4" /> Nouvelle campagne</Button>}
      />

      {creating && <NouvelleCampagne onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelected(id); reload(); }} />}

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : loading && !data ? (
        <LoadingBlock rows={4} />
      ) : !campagnes.length ? (
        <EmptyState title="Aucune campagne" description="Créez une première campagne pour recueillir l'avis des collaborateurs." />
      ) : (
        <>
          <CampagnesTable campagnes={campagnes} selectedId={selected} onSelect={setSelected} onStatut={changeStatut} />
          {current && (
            <div className="mt-8">
              <h2 className="mb-4 text-lg font-semibold">Résultats — {current.titre}</h2>
              <ResultatsQuestionnaire key={current.id} campagneId={current.id} />
            </div>
          )}
        </>
      )}
    </>
  );
}

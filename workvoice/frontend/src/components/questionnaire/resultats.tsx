"use client";

import { useState } from "react";
import { EyeOff, Gauge, MessageSquareQuote, RotateCcw, Users, UsersRound } from "lucide-react";
import { useApi } from "@/lib/use-api";
import { ECHELLE_QSP } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { NativeSelect } from "@/components/common/form";
import { KpiCard } from "@/components/common/kpi-card";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import type { ResultatsQsp } from "@/types";

/** Couleur d'un indice 0–100. */
export function indiceTone(v: number | null | undefined) {
  if (v === null || v === undefined) return "text-slate-400";
  if (v >= 70) return "text-emerald-600";
  if (v >= 50) return "text-amber-600";
  return "text-red-600";
}
const barTone = (v: number) => (v >= 70 ? "bg-emerald-500" : v >= 50 ? "bg-amber-500" : "bg-red-500");

/** Barre empilée 100 % : de « tout à fait d'accord » (gauche) à « pas du tout » (droite). */
function LikertBar({ repartition, total }: { repartition: number[]; total: number }) {
  return (
    <div className="flex h-7 w-full overflow-hidden rounded-md bg-slate-100">
      {ECHELLE_QSP.map((opt) => {
        const count = repartition[opt.note - 1];
        const pct = total ? (count / total) * 100 : 0;
        if (!pct) return null;
        return (
          <div
            key={opt.note}
            className={cn("flex items-center justify-center text-[11px] font-semibold text-white", opt.color)}
            style={{ width: `${pct}%` }}
            title={`${opt.frLong} : ${count} (${Math.round(pct)} %)`}
          >
            {pct >= 8 ? `${Math.round(pct)}%` : ""}
          </div>
        );
      })}
    </div>
  );
}

function GroupBars({ title, data }: { title: string; data?: ResultatsQsp["par_site"] }) {
  if (!data) return null;
  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs">
      <h3 className="font-semibold">{title}</h3>
      <p className="text-xs text-muted-foreground">Indice de satisfaction (0–100)</p>
      <ul className="mt-4 space-y-3">
        {data.groupes.map((g) => (
          <li key={g.groupe}>
            <div className="mb-1 flex justify-between text-sm">
              <span className="font-medium text-slate-700">{g.groupe}</span>
              <span className="tabular-nums text-muted-foreground">
                <span className={cn("font-semibold", indiceTone(g.indice))}>{g.indice}</span> · {g.n} rép.
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div className={cn("h-full rounded-full", barTone(g.indice))} style={{ width: `${g.indice}%` }} />
            </div>
          </li>
        ))}
        {data.groupes.length === 0 && <li className="text-sm text-muted-foreground">Aucun groupe n&apos;atteint le seuil de confidentialité.</li>}
      </ul>
      {data.reponses_masquees > 0 && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <EyeOff className="size-3.5" /> {data.reponses_masquees} réponse(s) de petits groupes non affichée(s) (anonymat).
        </p>
      )}
    </section>
  );
}

export function ResultatsQuestionnaire({ campagneId }: { campagneId: number }) {
  const [site, setSite] = useState("");
  const [departement, setDepartement] = useState("");
  const { data: ref } = useApi<{ data: { sites: string[]; departements: string[] } }>("/questionnaire/referentiels");
  const qs = new URLSearchParams();
  if (site) qs.set("site", site);
  if (departement) qs.set("departement", departement);
  const { data, error, loading, reload } = useApi<{ data: ResultatsQsp }>(`/questionnaire/campagnes/${campagneId}/resultats?${qs}`);
  const r = data?.data;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <NativeSelect value={site} onChange={(e) => setSite(e.target.value)} className="w-44" aria-label="Site">
          <option value="">Tous les sites</option>
          {ref?.data.sites.map((s) => <option key={s}>{s}</option>)}
        </NativeSelect>
        <NativeSelect value={departement} onChange={(e) => setDepartement(e.target.value)} className="w-52" aria-label="Département">
          <option value="">Tous les départements</option>
          {ref?.data.departements.map((s) => <option key={s}>{s}</option>)}
        </NativeSelect>
        {(site || departement) && (
          <button onClick={() => { setSite(""); setDepartement(""); }} className="inline-flex items-center gap-1 text-sm font-medium text-wm-blue hover:underline">
            <RotateCcw className="size-3.5" /> Réinitialiser
          </button>
        )}
      </div>

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !r ? (
        <LoadingBlock rows={6} />
      ) : (
        <div className={cn("space-y-6 transition", loading && "opacity-60")}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard
              label="Indice de satisfaction"
              value={<span className={indiceTone(r.indice_satisfaction)}>{r.indice_satisfaction ?? "–"}<span className="text-base text-muted-foreground"> /100</span></span>}
              icon={Gauge}
              tone="green"
            />
            <KpiCard label="Réponses" value={r.nb_reponses} icon={Users} tone="blue" hint={site || departement ? "Sur le périmètre filtré" : `Sur ${r.effectif} collaborateurs`} />
            <KpiCard label="Taux de participation" value={r.taux_participation === null ? "–" : `${r.taux_participation} %`} icon={UsersRound} tone="yellow" hint={site || departement ? "Non calculé sur un filtre" : undefined} />
            <KpiCard label="Seuil d'anonymat" value={`≥ ${r.seuil}`} icon={EyeOff} tone="slate" hint="Réponses minimum pour publier un résultat" />
          </div>

          {r.insuffisant ? (
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
              <EyeOff className="size-5 shrink-0" />
              <p>
                Moins de {r.seuil} réponses sur ce périmètre : les résultats ne sont pas affichés afin de protéger l&apos;anonymat des
                répondants. Élargissez les filtres ou attendez davantage de participations.
              </p>
            </div>
          ) : (
            <>
              <section className="rounded-xl border bg-card shadow-xs">
                <header className="flex flex-col gap-3 border-b px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h3 className="font-semibold">Résultats par question</h3>
                    <p className="text-xs text-muted-foreground">% favorable = d&apos;accord (inversé pour la question 11, formulée négativement)</p>
                  </div>
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
                    {ECHELLE_QSP.map((o) => (
                      <li key={o.note} className="flex items-center gap-1"><span className={cn("size-2.5 rounded-sm", o.color)} />{o.fr}</li>
                    ))}
                  </ul>
                </header>
                <ol className="divide-y">
                  {r.par_question?.map((q) => (
                    <li key={q.question_id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_88px] lg:items-center">
                      <div className="flex gap-3">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-wm-blue-50 text-xs font-bold text-wm-blue">{q.ordre}</span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800">
                            {q.texte_fr}
                            {q.inverse && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">inversée</span>}
                          </p>
                          <p lang="ar" dir="rtl" className="text-right font-arabic text-xs text-muted-foreground">{q.texte_ar}</p>
                        </div>
                      </div>
                      <LikertBar repartition={q.repartition} total={q.total} />
                      <div className="text-right">
                        <p className={cn("text-lg font-bold tabular-nums", indiceTone(q.taux_favorable))}>{q.taux_favorable} %</p>
                        <p className="text-[11px] text-muted-foreground">favorable</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>

              <div className="grid gap-6 lg:grid-cols-2">
                <GroupBars title="Par département" data={r.par_departement} />
                <GroupBars title="Par site" data={r.par_site} />
              </div>

              <section className="rounded-xl border bg-card p-5 shadow-xs">
                <h3 className="flex items-center gap-2 font-semibold">
                  <MessageSquareQuote className="size-4 text-wm-blue" /> Commentaires anonymes ({r.commentaires?.length ?? 0})
                </h3>
                {r.commentaires?.length ? (
                  <ul className="mt-4 grid gap-3 md:grid-cols-2">
                    {r.commentaires.map((c, i) => (
                      <li key={i} className="rounded-lg border-l-4 border-wm-yellow bg-slate-50 px-4 py-3 text-sm text-slate-700 whitespace-pre-wrap">« {c} »</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">Aucun commentaire.</p>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}

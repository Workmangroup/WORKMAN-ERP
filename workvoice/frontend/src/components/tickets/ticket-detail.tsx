"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Building2, Check, Download, EyeOff, Loader2, Mail, MapPin, Paperclip, Phone, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api, apiUrl, ApiError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { KINDS, STATUTS, STATUT_LABELS, typeLabel } from "@/lib/constants";
import { formatDateTime, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ConfidentialBadge, StatusBadge, UrgencyBadge } from "@/components/common/badges";
import { NativeSelect } from "@/components/common/form";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import { CommentThread } from "@/components/tickets/comment-thread";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Kind, Statut, Ticket } from "@/types";

const STEPS: Statut[] = ["NOUVEAU", "EN_COURS", "RESOLU", "CLOTURE"];

function StatusTimeline({ statut }: { statut: Statut }) {
  const current = statut === "EN_ATTENTE" ? 1 : STEPS.indexOf(statut);
  return (
    <ol className="space-y-4">
      {STEPS.map((s, i) => {
        const done = i < current || statut === "CLOTURE";
        const active = i === current;
        return (
          <li key={s} className="flex items-center gap-3">
            <span
              className={cn(
                "flex size-7 items-center justify-center rounded-full text-xs font-bold ring-2",
                done && "bg-wm-blue text-white ring-wm-blue",
                active && !done && "bg-wm-yellow text-wm-blue-dark ring-wm-yellow",
                !done && !active && "bg-white text-slate-400 ring-slate-200",
              )}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("text-sm", active ? "font-semibold text-slate-900" : "text-muted-foreground")}>
              {STATUT_LABELS[s]}
              {active && statut === "EN_ATTENTE" && <span className="ml-1 text-violet-700">· en attente d&apos;informations</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StatusChanger({ ticket, onChanged }: { ticket: Ticket; onChanged: () => void }) {
  const [statut, setStatut] = useState<Statut>(ticket.statut);
  const [commentaire, setCommentaire] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api(`/${KINDS[ticket.kind].api}/${ticket.id}/statut`, {
        method: "PATCH",
        body: { statut, ...(commentaire.trim() ? { commentaire: commentaire.trim() } : {}) },
      });
      toast.success(`Statut mis à jour : ${STATUT_LABELS[statut]}`);
      setCommentaire("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Mise à jour impossible");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5 shadow-xs">
      <h3 className="mb-3 text-sm font-semibold">Traitement</h3>
      <div className="space-y-3">
        <NativeSelect value={statut} onChange={(e) => setStatut(e.target.value as Statut)} aria-label="Statut">
          {STATUTS.map((s) => (
            <option key={s} value={s}>
              {STATUT_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        <Textarea
          value={commentaire}
          onChange={(e) => setCommentaire(e.target.value)}
          placeholder="Message au collaborateur (facultatif)"
          rows={3}
          maxLength={3000}
        />
        <Button className="w-full" onClick={save} disabled={saving || (statut === ticket.statut && !commentaire.trim())}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Enregistrer
        </Button>
        <p className="text-xs text-muted-foreground">Le collaborateur est notifié à chaque changement de statut.</p>
      </div>
    </div>
  );
}

function AuthorCard({ ticket }: { ticket: Ticket }) {
  const a = ticket.auteur!;
  return (
    <div className="rounded-xl border bg-card p-5 shadow-xs">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Auteur</h3>
        <span className="inline-flex items-center gap-1 rounded-full bg-wm-yellow-50 px-2 py-0.5 text-[11px] font-medium text-amber-900">
          <EyeOff className="size-3" /> Visible RH uniquement
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-full bg-wm-blue font-bold text-white">
          {initials(a.prenom, a.nom)}
        </div>
        <div>
          <p className="font-semibold">
            {a.prenom} {a.nom}
          </p>
          <p className="text-xs text-muted-foreground">Matricule {a.matricule}</p>
        </div>
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex items-center gap-2 text-slate-700">
          <Building2 className="size-4 text-muted-foreground" /> {a.service} · {a.departement}
        </div>
        <div className="flex items-center gap-2 text-slate-700">
          <MapPin className="size-4 text-muted-foreground" /> {a.site}
        </div>
        {a.email && (
          <a href={`mailto:${a.email}`} className="flex items-center gap-2 text-wm-blue hover:underline">
            <Mail className="size-4" /> {a.email}
          </a>
        )}
        {a.telephone && (
          <a href={`tel:${a.telephone.replace(/\s/g, "")}`} className="flex items-center gap-2 text-wm-blue hover:underline">
            <Phone className="size-4" /> {a.telephone}
          </a>
        )}
      </dl>
      {ticket.confidentielle && (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Réclamation confidentielle : la Direction la voit sans identité ni service.
        </p>
      )}
    </div>
  );
}

export function TicketDetail({ kind, id, mode }: { kind: Kind; id: number; mode: "employe" | "rh" }) {
  const { data, error, loading, reload } = useApi<{ data: Ticket }>(`/${KINDS[kind].api}/${id}`);
  const backHref = mode === "rh" ? `/rh/${KINDS[kind].api}/` : "/employe/historique/";

  if (loading && !data) return <LoadingBlock rows={6} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return null;
  const t = data.data;

  const employeeClosed = mode === "employe" && t.statut === "CLOTURE";

  return (
    <div>
      <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-wm-blue">
        <ArrowLeft className="size-4" /> Retour
      </Link>

      <div className="mb-6 rounded-xl border bg-card p-5 shadow-xs sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-wm-blue">{t.numero}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs font-medium text-muted-foreground">{KINDS[kind].label}</span>
          <StatusBadge statut={t.statut} />
          {t.niveau_urgence && <UrgencyBadge urgence={t.niveau_urgence} />}
          {t.confidentielle && <ConfidentialBadge />}
        </div>
        <h1 className="mt-3 text-xl font-bold text-slate-900 sm:text-2xl">{t.objet}</h1>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <div>
            <dt className="inline">{kind === "reclamation" ? "Catégorie" : kind === "suggestion" ? "Thème" : "Type"} : </dt>
            <dd className="inline font-medium text-slate-700">{typeLabel(kind, t.type)}</dd>
          </div>
          <div>
            <dt className="inline">Créée le </dt>
            <dd className="inline font-medium text-slate-700">{formatDateTime(t.date_creation)}</dd>
          </div>
          {t.date_cloture && (
            <div>
              <dt className="inline">Traitée le </dt>
              <dd className="inline font-medium text-slate-700">{formatDateTime(t.date_cloture)}</dd>
            </div>
          )}
        </dl>
        <div className="mt-5 rounded-lg bg-slate-50 p-4 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">{t.description}</div>
        {t.has_piece_jointe && (
          <a
            href={apiUrl(`/demandes/${t.id}/piece-jointe`)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium text-wm-blue transition hover:bg-wm-blue-50"
          >
            <Paperclip className="size-4" /> {t.piece_jointe_nom ?? "Pièce jointe"} <Download className="size-4" />
          </a>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <CommentThread
          kind={kind}
          ticketId={t.id}
          commentaires={t.commentaires ?? []}
          canReply={!employeeClosed}
          disabledReason="Ce dossier est clôturé. Créez une nouvelle demande si besoin."
          onPosted={reload}
          placeholder={mode === "rh" ? "Répondre au collaborateur…" : "Ajouter une précision pour le service RH…"}
        />
        <aside className="space-y-6">
          {mode === "rh" ? (
            <>
              <StatusChanger key={t.statut} ticket={t} onChanged={reload} />
              {t.auteur && <AuthorCard ticket={t} />}
            </>
          ) : (
            <div className="rounded-xl border bg-card p-5 shadow-xs">
              <h3 className="mb-4 text-sm font-semibold">Avancement</h3>
              <StatusTimeline statut={t.statut} />
              {kind === "reclamation" && t.confidentielle && (
                <p className="mt-5 flex gap-2 rounded-lg bg-wm-yellow-50 p-3 text-xs text-amber-900">
                  <ShieldAlert className="size-4 shrink-0" />
                  Confidentielle : seul le service RH connaît votre identité.
                </p>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Commentaire, Kind } from "@/types";
import { KINDS } from "@/lib/constants";

export function CommentThread({
  kind,
  ticketId,
  commentaires,
  canReply,
  disabledReason,
  onPosted,
  placeholder = "Écrire un message…",
}: {
  kind: Kind;
  ticketId: number;
  commentaires: Commentaire[];
  canReply: boolean;
  disabledReason?: string;
  onPosted: () => void;
  placeholder?: string;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setSending(true);
    try {
      await api(`/${KINDS[kind].api}/${ticketId}/commentaires`, { method: "POST", body: { message: message.trim() } });
      setMessage("");
      toast.success("Message envoyé");
      onPosted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Envoi impossible");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card shadow-xs">
      <div className="border-b px-5 py-3.5">
        <h2 className="font-semibold">Échanges</h2>
        <p className="text-xs text-muted-foreground">{commentaires.length} message{commentaires.length > 1 ? "s" : ""}</p>
      </div>

      <ol className="space-y-4 px-5 py-5">
        {commentaires.length === 0 && (
          <li className="py-6 text-center text-sm text-muted-foreground">Aucun échange pour le moment.</li>
        )}
        {commentaires.map((c) => {
          const isRh = c.auteur.role === "RH";
          return (
            <li key={c.id} className={cn("flex gap-3", c.est_moi && "flex-row-reverse")}>
              <div
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                  isRh ? "bg-wm-blue text-white" : "bg-wm-yellow text-wm-blue-dark",
                )}
              >
                {isRh ? "RH" : c.auteur.nom.split(" ").map((p) => p[0]).join("").slice(0, 2)}
              </div>
              <div className={cn("max-w-[85%] sm:max-w-[75%]", c.est_moi && "text-right")}>
                <div className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground" style={{ justifyContent: c.est_moi ? "flex-end" : "flex-start" }}>
                  <span className="font-semibold text-slate-700">{c.est_moi ? "Vous" : c.auteur.nom}</span>
                  <span>{formatDateTime(c.date_creation)}</span>
                </div>
                <div
                  className={cn(
                    "rounded-2xl px-4 py-2.5 text-left text-sm leading-relaxed whitespace-pre-wrap",
                    c.est_moi ? "rounded-tr-sm bg-wm-blue text-white" : "rounded-tl-sm bg-slate-100 text-slate-800",
                  )}
                >
                  {c.message}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="border-t bg-slate-50/60 px-5 py-4">
        {canReply ? (
          <form onSubmit={send} className="space-y-3">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={placeholder}
              rows={3}
              maxLength={3000}
              className="bg-white"
              aria-label="Votre message"
            />
            <div className="flex justify-end">
              <Button type="submit" disabled={sending || !message.trim()}>
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Envoyer
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-center text-sm text-muted-foreground">{disabledReason}</p>
        )}
      </div>
    </div>
  );
}

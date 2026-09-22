"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ErrorState, LoadingBlock } from "@/components/common/states";
import { TicketDetail } from "@/components/tickets/ticket-detail";
import type { Kind } from "@/types";

const VALID: Kind[] = ["demande", "reclamation", "suggestion"];

function Inner({ mode }: { mode: "employe" | "rh" }) {
  const params = useSearchParams();
  const kind = params.get("kind") as Kind;
  const id = Number(params.get("id"));
  if (!VALID.includes(kind) || !Number.isInteger(id) || id <= 0) {
    return <ErrorState message="Lien invalide : dossier introuvable." />;
  }
  return <TicketDetail key={`${kind}-${id}`} kind={kind} id={id} mode={mode} />;
}

/** Page détail (routes statiques : kind et id passent en paramètres de requête). */
export function TicketPage({ mode }: { mode: "employe" | "rh" }) {
  return (
    <Suspense fallback={<LoadingBlock rows={6} />}>
      <Inner mode={mode} />
    </Suspense>
  );
}

export const ticketHref = (space: "employe" | "rh", kind: Kind, id: number) => `/${space}/ticket/?kind=${kind}&id=${id}`;

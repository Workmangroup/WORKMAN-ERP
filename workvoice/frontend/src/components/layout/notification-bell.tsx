"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertOctagon, Bell, CheckCheck, MessageSquareReply, RefreshCcw, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Notification } from "@/types";

const ICONS: Record<string, typeof Bell> = {
  REPONSE_RH: MessageSquareReply,
  REPONSE_COLLABORATEUR: MessageSquareReply,
  STATUT_MAJ: RefreshCcw,
  RECLAMATION_CRITIQUE: AlertOctagon,
};

export function NotificationBell() {
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await api<{ data: Notification[]; non_lues: number }>("/notifications");
      setItems(res.data);
      setUnread(res.non_lues);
    } catch {
      /* silencieux : la cloche ne doit jamais bloquer l'interface */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function open(n: Notification) {
    if (!n.lu) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, lu: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      api(`/notifications/${n.id}/lu`, { method: "PATCH" }).catch(() => {});
    }
    if (n.lien) router.push(n.lien);
  }

  async function markAll() {
    await api("/notifications/tout-lu", { method: "PATCH" }).catch(() => {});
    setItems((prev) => prev.map((x) => ({ ...x, lu: true })));
    setUnread(0);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="relative inline-flex size-9 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100"
        aria-label={`Notifications${unread ? ` (${unread} non lues)` : ""}`}
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-wm-yellow px-1 text-[10px] font-bold text-wm-blue-dark ring-2 ring-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(92vw,380px)] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <button onClick={markAll} className="inline-flex items-center gap-1 text-xs font-medium text-wm-blue hover:underline">
              <CheckCheck className="size-3.5" /> Tout marquer comme lu
            </button>
          )}
        </div>
        <div className="max-h-[420px] overflow-y-auto p-1">
          {items.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Aucune notification</p>}
          {items.map((n) => {
            const Icon = ICONS[n.type] ?? Sparkles;
            const critical = n.type === "RECLAMATION_CRITIQUE" || n.titre.startsWith("CRITIQUE");
            return (
              <DropdownMenuItem key={n.id} onClick={() => open(n)} className="items-start gap-3 rounded-lg px-3 py-2.5">
                <div className={cn("mt-0.5 rounded-md p-1.5", critical ? "bg-red-50 text-red-600" : "bg-wm-blue-50 text-wm-blue")}>
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-sm", !n.lu && "font-semibold")}>{n.titre}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{n.message}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{timeAgo(n.date_creation)}</p>
                </div>
                {!n.lu && <span className="mt-2 size-2 shrink-0 rounded-full bg-wm-blue" />}
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

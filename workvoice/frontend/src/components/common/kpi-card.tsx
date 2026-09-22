import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const tones = {
  blue: "bg-wm-blue-50 text-wm-blue",
  yellow: "bg-wm-yellow-50 text-amber-700",
  green: "bg-emerald-50 text-emerald-700",
  red: "bg-red-50 text-red-600",
  slate: "bg-slate-100 text-slate-600",
};

export function KpiCard({
  label,
  value,
  icon: Icon,
  tone = "blue",
  hint,
  highlight = false,
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  tone?: keyof typeof tones;
  hint?: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card p-5 shadow-xs transition hover:shadow-md",
        highlight && "border-red-200 ring-1 ring-red-100",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</p>
        </div>
        <div className={cn("rounded-lg p-2.5", tones[tone])}>
          <Icon className="size-5" />
        </div>
      </div>
      {hint && <div className="mt-3 text-xs text-muted-foreground">{hint}</div>}
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-wm-blue via-wm-blue to-wm-yellow opacity-70" />
    </div>
  );
}

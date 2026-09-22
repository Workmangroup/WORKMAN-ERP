import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type Choice = { value: string; label: string; icon: LucideIcon; hint?: string };

/** Grille de choix exclusifs (boutons radio accessibles). */
export function ChoiceGrid({
  name,
  choices,
  value,
  onChange,
  invalid,
  columns = "sm:grid-cols-3 lg:grid-cols-4",
}: {
  name: string;
  choices: Choice[];
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  columns?: string;
}) {
  return (
    <div role="radiogroup" aria-invalid={invalid} className={cn("grid grid-cols-2 gap-2.5", columns)}>
      {choices.map(({ value: v, label, icon: Icon, hint }) => {
        const selected = value === v;
        return (
          <label
            key={v}
            className={cn(
              "relative flex cursor-pointer flex-col gap-2 rounded-xl border bg-white p-3.5 transition focus-within:ring-3 focus-within:ring-ring/40",
              selected ? "border-wm-blue bg-wm-blue-50 ring-1 ring-wm-blue" : "hover:border-slate-300 hover:bg-slate-50",
              invalid && !value && "border-red-300",
            )}
          >
            <input type="radio" name={name} value={v} checked={selected} onChange={() => onChange(v)} className="sr-only" />
            <Icon className={cn("size-5", selected ? "text-wm-blue" : "text-slate-500")} />
            <span className={cn("text-sm leading-tight font-medium", selected ? "text-wm-blue-dark" : "text-slate-700")}>{label}</span>
            {hint && <span className="text-[11px] leading-tight text-muted-foreground">{hint}</span>}
            {selected && <span className="absolute top-2.5 right-2.5 size-2 rounded-full bg-wm-yellow ring-2 ring-white" />}
          </label>
        );
      })}
    </div>
  );
}

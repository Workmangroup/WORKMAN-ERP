import { cn } from "@/lib/utils";

/** Logo WORKVOICE : bulle de parole aux couleurs Workman. */
export function Logo({ className, inverted = false }: { className?: string; inverted?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 40 40" className="size-9 shrink-0" aria-hidden="true">
        <rect width="40" height="40" rx="10" fill={inverted ? "#ffffff" : "#0b3d91"} />
        <path
          d="M11 13.5a3.5 3.5 0 0 1 3.5-3.5h11a3.5 3.5 0 0 1 3.5 3.5v8a3.5 3.5 0 0 1-3.5 3.5H19l-5 4.5V25h.5A3.5 3.5 0 0 1 11 21.5z"
          fill="#ffc20e"
        />
        <path d="M15.5 15.5l2 5 2.5-4 2.5 4 2-5" stroke={inverted ? "#ffffff" : "#0b3d91"} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="leading-tight">
        <div className={cn("text-[15px] font-extrabold tracking-wide", inverted ? "text-white" : "text-wm-blue")}>
          WORK<span className="text-wm-yellow">VOICE</span>
        </div>
        <div className={cn("text-[11px] font-medium", inverted ? "text-blue-100/80" : "text-muted-foreground")}>
          Portail Collaborateur Workman
        </div>
      </div>
    </div>
  );
}

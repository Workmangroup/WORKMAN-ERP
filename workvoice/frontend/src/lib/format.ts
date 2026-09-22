const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

export const formatDate = (d?: string | null) => (d ? dateFmt.format(new Date(d)) : "—");
export const formatDateTime = (d?: string | null) => (d ? dateTimeFmt.format(new Date(d)) : "—");

export function timeAgo(d: string) {
  const diff = (new Date(d).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "à l'instant";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(d);
}

export const initials = (prenom?: string, nom?: string) =>
  `${prenom?.[0] ?? ""}${nom?.[0] ?? ""}`.toUpperCase() || "?";

export const formatJours = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} j`;

// Small formatting helpers shared by the Shadow page and the Dashboard card. Null = no data, shown as "—".

export const pct = (x: number | null | undefined): string => (x === null || x === undefined ? "—" : `${Math.round(x * 1000) / 10}%`);

export function minutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  if (m < 1) return "<1 min";
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
}

/** "5h", "2d" — age of an ISO timestamp, for backlog lines. */
export function ageOf(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const h = Math.max(0, (now - Date.parse(iso)) / 3_600_000);
  if (h < 1) return "<1h";
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

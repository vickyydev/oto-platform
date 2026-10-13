import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";

interface Freshness {
  branches: Array<{ key: string; name: string; source: string | null; lastRolledUpAt: string | null }>;
  lastRolledUpAt: string | null;
}

function bangkokTime(iso: string): string {
  const d = new Date(iso);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(d);
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
  if (day === today) return time;
  return `${d.toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short" })} ${time}`;
}

/**
 * "Figures to <time>": when the platform's rollup last brought the selected
 * parks up to date (the oldest of them). Radar's figures are the OTO POS
 * rollup, so this is how stale the dashboard can be — a sale rings up on the
 * till and appears here at the next rollup.
 */
export function FreshnessChip({ branches }: { branches: string[] }) {
  const key = [...branches].sort().join(",");
  const { data, isError } = useQuery<Freshness>({
    queryKey: ["/api/figures/freshness", key],
    queryFn: async () => {
      const res = await fetch(`/api/figures/freshness?branches=${encodeURIComponent(key)}`, { credentials: "include" });
      if (!res.ok) throw new Error(`freshness ${res.status}`);
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  const label = isError
    ? "Figures unavailable"
    : !data
      ? "Figures…"
      : data.lastRolledUpAt
        ? `Figures to ${bangkokTime(data.lastRolledUpAt)}`
        : "Not rolled up yet";
  const detail = data?.branches
    .map((b) => `${b.name}: ${b.lastRolledUpAt ? bangkokTime(b.lastRolledUpAt) : "not rolled up yet"}`)
    .join("\n");

  return (
    <span
      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-border/40 bg-muted/40 text-[11px] font-medium text-muted-foreground whitespace-nowrap"
      title={detail ? `From the OTO POS rollup\n${detail}` : "From the OTO POS rollup"}
      data-testid="text-figures-freshness"
    >
      <Clock className="h-3 w-3" />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

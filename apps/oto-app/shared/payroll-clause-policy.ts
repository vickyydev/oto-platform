import type { ClausePart, ClauseReading } from "./payroll-clause-reading";

export type RevenuePark = "all" | "home" | "assigned" | `branch:${string}`;
type Park = { id: string; name: string };
type Stream = { key: string; label: string };

const clean = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const isChildcareClause = (quote: string) =>
  /\bnann(?:y|ies)\b|\bdrop[\s-]*off\b/i.test(quote);
export const isHostCount = (quote: string) => /host/i.test(quote) && /birthday part/i.test(quote);
export const isCorrectedRevenueClause = (text: string) =>
  /0,002\s*%/.test(text) && /total revenue/i.test(text) && /both parks/i.test(text) && /4[.,]5\s*(?:mln|million)/i.test(text);

export function parkFromWords(words: string, parks: Park[]): RevenuePark {
  if (/\b(?:both|all)\s+(?:the\s+)?(?:parks|branches)\b|\bcombined\b/i.test(words)) return "all";
  const clause = ` ${clean(words)} `;
  const tokens = parks.map(park => clean(park.name).split(" "));
  const named = parks.filter((park, i) => clause.includes(` ${clean(park.name)} `) || tokens[i].some(token =>
    token.length >= 3 && !["the", "park", "parks", "branch", "centre", "center", "oto", "test"].includes(token)
    && tokens.filter(other => other.includes(token)).length === 1 && clause.includes(` ${token} `)));
  if (named.length === 1) return `branch:${named[0].id}`;
  return named.length > 1 ? "all" : "assigned";
}

/** Apply the owner's decisions to the matching words only. Human corrections keep their chosen park. */
export function settleClause(text: string, reading: ClauseReading, parks: Park[], streams: Stream[], choosePark: boolean): ClauseReading {
  let childcare = false, host = false, revenue = false, corrected = false;
  const parts = reading.parts.map((part): ClausePart => {
    if (!part.quote.trim() || !clean(text).includes(clean(part.quote))) return part;
    if (part.type !== "not-a-bonus" && isChildcareClause(part.quote)) {
      childcare = true;
      const matches = streams.filter(s => /\bnann(?:y|ies)\b|drop[\s-]*off/i.test(`${s.key} ${s.label}`));
      return { ...part, type: "bonus", notBonusKind: null, needsPersonWhy: null,
        plainWords: "Each park shares 20% of its nanny and drop-off sales, less VAT and service charge, by the days each eligible person worked in childcare there.",
        bonus: { childcarePool: true, basis: "percent-of-revenue", percent: 20, bahtPerUnit: null, revenue: { described: "nanny and drop-off sales", streams: matches.map(s => s.key), branches: "all" },
          unit: null, threshold: null, cap: null, sharing: "team", team: "Childcare Team", split: "days-worked", joinPool: null } };
    }
    const b = part.bonus;
    if (part.type !== "bonus" || !b) return part;
    if (b.basis === "baht-per-unit" && b.unit && isHostCount(part.quote)) {
      host = true;
      return { ...part, plainWords: "In Run Payroll > Inputs, enter the number of birthday parties this person hosted that month.",
        bonus: { ...b, sharing: "own", team: null, split: null, joinPool: null, unit: { ...b.unit, counted: "per-person" } } };
    }
    if (!b.revenue) return part;
    revenue = true;
    const fixRate = isCorrectedRevenueClause(text) && /0,002\s*%/.test(part.quote);
    corrected ||= fixRate;
    const scope = choosePark ? parkFromWords(part.quote, parks) : b.revenue.branches;
    const region = scope === "all" ? "all payroll parks together"
      : scope === "home" ? "the person's home park"
      : scope === "assigned" ? "the assigned park, or both parks for a multi-park or company-wide assignment"
      : parks.find(p => p.id === scope.slice(7))?.name ?? "the selected park";
    const amount = fixRate ? 0.2 : b.percent;
    const sales = `${b.revenue.described || "sales"}, less VAT and service charge, at ${region}`;
    const rate = amount === null ? "A rate must be confirmed" : `${amount}% of ${sales}`;
    const threshold = b.threshold === null ? "" : ` once those sales exceed ${b.threshold.toLocaleString("en-US")} baht`;
    const cap = b.cap === null ? "" : `, capped at ${b.cap.toLocaleString("en-US")} baht per month`;
    const sharing = b.sharing === "team" ? ` The ${b.team || "eligible"} team shares the pool${b.split === "days-worked" ? " by days worked" : b.split === "equal" ? " equally" : ""}.` : "";
    const note = fixRate ? " The owner confirmed the rate on 28 November 2026. HR should correct the profile. Editing the clause will flag it for a new reading." : "";
    return { ...part, plainWords: `${rate}${threshold}${cap}.${sharing}${note}`,
      bonus: { ...b, percent: fixRate ? 0.2 : b.percent, revenue: { ...b.revenue, branches: scope } } };
  });
  const questions = reading.questions.filter(q => {
    if (revenue && /VAT|service charge|which park|both parks|own park|combined sales/i.test(q)) return false;
    if (corrected && /rate|0[.,]002|90 baht/i.test(q)) return false;
    if (childcare && /nanny|drop.?off|childcare|pool|days worked|shared|which park|working nanny/i.test(q)) return false;
    if (host && /count|host|birthday|per party|park total/i.test(q)) return false;
    return true;
  });
  return { summary: childcare || revenue || host ? parts.map(p => p.plainWords).join(" ") : reading.summary, parts, questions };
}

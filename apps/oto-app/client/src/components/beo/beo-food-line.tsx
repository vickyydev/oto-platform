import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** SCRUM-1029 (the brief's E5): the four parts of Food & Drinks, in the brief's order and words. */
export const BEO_FOOD_LINES = [
  { key: "setup", title: "Setup / Table" },
  { key: "kids", title: "Kids Menu" },
  { key: "adults", title: "Adults Menu" },
  { key: "bar", title: "Bar" },
] as const;
export type BeoFoodLineKey = (typeof BEO_FOOD_LINES)[number]["key"];

/** The Food & Drinks lines that hold the fields of an older part AI Fill's approval names (what it opens). */
export const BEO_FOOD_LINES_OF_PART: Record<string, readonly BeoFoodLineKey[]> = {
  "setup-plan": ["setup"],
  "kitchen-plan": ["kids", "adults", "bar"],
};

/** "1 dish", "2 dishes"; "1 task", "2 tasks"; "1 item", "2 items". */
export function countWords(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * SCRUM-1029 (the brief's E5): one part of Food & Drinks as one line: its name, what it holds in a
 * few words (the summary), a count, and a chevron; a press opens the part's fields under the line
 * and a second press folds them. The names sit in one column so every summary starts at one place.
 * Folded, the part's fields are not on the screen; what they hold stays in the form until Save.
 */
export function BeoFoodLine({
  line,
  icon,
  summary,
  count,
  aside,
  open,
  onToggle,
  children,
}: {
  line: BeoFoodLineKey;
  icon: React.ReactNode;
  summary: React.ReactNode;
  /** The count on the line's right ("2 dishes"); none when empty. */
  count?: string | null;
  /** What the part wears beside its name (AI Fill's "from the chat"). */
  aside?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const title = BEO_FOOD_LINES.find((l) => l.key === line)!.title;
  return (
    <section data-testid={`food-line-${line}`} data-state={open ? "open" : "closed"}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`food-line-${line}-body`}
        className="-mx-2 flex min-h-12 w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={`button-food-line-${line}`}
      >
        <span className="flex w-32 shrink-0 items-center gap-2 sm:w-36">
          {icon}
          <span className="text-sm font-semibold leading-tight">{title}</span>
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {aside}
          <span className="min-w-0 truncate text-sm text-muted-foreground" data-testid={`text-food-line-${line}`}>{summary}</span>
        </span>
        {count && (
          <Badge variant="secondary" className="shrink-0 text-xs tabular-nums" data-testid={`badge-food-line-${line}`}>
            {count}
          </Badge>
        )}
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div id={`food-line-${line}-body`} className="space-y-4 pb-4 pt-2" data-testid={`food-line-${line}-body`}>
          {children}
        </div>
      )}
    </section>
  );
}

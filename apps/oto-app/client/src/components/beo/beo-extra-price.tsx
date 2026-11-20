import { createContext, useContext } from "react";
import { EditableText } from "@/components/ui/editable-text";
import {
  beoExtraChargeOf,
  beoExtraHintOf,
  beoExtrasTotalOf,
  beoExtrasTotalWords,
  hasExtraLines,
  type BeoExtraCharge,
  type BeoExtraLine,
} from "@shared/beoExtras";
import { useTillMenuIndex } from "./till-menu-picker";

/**
 * AN EXTRA LINE'S PRICE IN THE BEO'S KITCHEN AND BAR PLAN (SCRUM-949).
 *
 * Since SCRUM-906 the till charges a BEO's EXTRA line at the price entered on
 * it for each item, or at the till's price when none is entered and the line
 * has a till code; a line with neither is not charged. The editor's kitchen
 * and bar rows had no price box, so a price a till-menu pick, the AI fill or
 * the save route wrote was invisible and staff could not type one. Now every
 * EXTRA line (never a SET line) shows one, in the style of the cake's Price
 * box, with what the till will charge for it beside it, and each plan shows
 * its extras' total as the till will charge it (shared/beoExtras.ts mirrors
 * the settlement's arithmetic).
 */

/** The party's date, for the till's weekend price the hints and the totals read. */
export const BeoPartyDateContext = createContext<string | null>(null);

/**
 * The price box beside an EXTRA line's count: staff enter, change or clear the
 * price for each item (cleared is none); beside it what the till charges.
 */
export function ExtraPriceBox({ line, area, charge, onPrice, testId, disabled = false }: {
  line: BeoExtraLine;
  area: "food" | "bar";
  /** The line's charge where its list decides it (an adults' copy of a kids' line); else the line's own. */
  charge?: BeoExtraCharge;
  onPrice: (price: number) => void;
  testId: string;
  disabled?: boolean;
}) {
  const till = useTillMenuIndex();
  const partyDate = useContext(BeoPartyDateContext);
  const hint = beoExtraHintOf(charge ?? beoExtraChargeOf(line, area, { till, partyDate }));
  return (
    <>
      <EditableText
        disabled={disabled}
        type="number"
        // SCRUM-1029 (look): "Price ฿" on one line, as every other empty box reads.
        className="w-[4.5rem] px-2 whitespace-nowrap text-xs font-mono shrink-0"
        value={String(line.price || "")}
        onChange={(v) => { if (!disabled) onPrice(Math.max(0, Number(v) || 0)); }}
        placeholder="Price ฿"
        data-testid={`input-menu-price-${testId}`}
      />
      {line.billingSync === "pending" && <span className="text-xs text-destructive" role="status">Additional bill pending - Save again to resolve</span>}
      {hint && (
        // SCRUM-1029 (look): the till's words in a column of one width, two short lines at most, so what
        // follows the price starts at one place on every line of a list.
        <span className="w-[6.5rem] text-[10px] leading-tight text-muted-foreground shrink-0" data-testid={`text-menu-price-hint-${testId}`}>
          {hint}
        </span>
      )}
    </>
  );
}

/**
 * The plan's extras total, as the till will charge them; nothing when the plan
 * holds no EXTRA line or one the till's menu could not price.
 */
export function BeoExtrasTotal({ charges, testId, className = "" }: { charges: readonly BeoExtraCharge[]; testId: string; className?: string }) {
  const total = beoExtrasTotalOf(charges);
  if (!hasExtraLines(charges) || total === null) return null;
  return (
    <p className={`text-xs text-muted-foreground ${className}`.trim()} data-testid={testId}>
      {beoExtrasTotalWords(total)}
    </p>
  );
}

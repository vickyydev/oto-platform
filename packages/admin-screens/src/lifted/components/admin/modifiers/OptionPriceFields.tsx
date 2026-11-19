import { Trash2 } from "lucide-react";
import type { WeekdayWeekendPrice } from "../../../model/types";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

/**
 * One option row shared by the modifier group dialog and the menu item form,
 * so the two editors cannot drift. The name takes the whole first line; the
 * second line holds the one price, the cost and the remove button.
 *
 * The stored shape is unchanged: an option still carries a weekday and a
 * weekend price. The one price field writes the same value to both. An option
 * that already holds two different prices is not flattened: both are shown in
 * plain words, the field stays empty, and the stored values change only when
 * a price is typed.
 */

/** True when the stored weekday and weekend prices differ. */
export const optionPricesDiffer = (price: WeekdayWeekendPrice): boolean =>
  price.weekday !== price.weekend;

/** What the one price field shows: empty while two different prices are stored. */
export const onePriceFieldValue = (price: WeekdayWeekendPrice): number | '' =>
  optionPricesDiffer(price) ? '' : price.weekday;

/** The stored prices after the person types one price (same value for both). */
export const priceFromOneField = (raw: string): WeekdayWeekendPrice => {
  const value = Number(raw) || 0;
  return { weekday: value, weekend: value };
};

/** The plain-words note for an option holding two different prices. */
export const twoPricesNote = (price: WeekdayWeekendPrice): string =>
  `weekday ฿${price.weekday}, weekend ฿${price.weekend}`;

interface OptionRowFieldsProps {
  name: string;
  price: WeekdayWeekendPrice;
  cost: string;
  error?: string;
  onName: (name: string) => void;
  onPrice: (price: WeekdayWeekendPrice) => void;
  onCost: (cost: string) => void;
  onRemove: () => void;
}

export function OptionRowFields({
  name,
  price,
  cost,
  error,
  onName,
  onPrice,
  onCost,
  onRemove,
}: OptionRowFieldsProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder="Option, e.g. Ketchup"
        aria-label="Option name"
        className="w-full min-w-0"
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <span className="text-xs text-foreground/40">+฿ price</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step="0.01"
            className="w-24"
            value={onePriceFieldValue(price)}
            onChange={(e) => onPrice(priceFromOneField(e.target.value))}
            placeholder="0"
            aria-label="Option price delta"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-foreground/40">cost ฿</span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            step="0.01"
            className="w-24"
            value={cost}
            onChange={(e) => onCost(e.target.value)}
            placeholder="—"
            aria-label="Option cost"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto shrink-0 text-destructive"
          aria-label="Remove option"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {optionPricesDiffer(price) && (
        <p className="text-xs text-foreground/50">
          {twoPricesNote(price)}. Type a price to set both.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

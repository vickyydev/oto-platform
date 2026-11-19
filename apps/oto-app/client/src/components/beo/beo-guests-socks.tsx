import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  EXPECTED_EXTRA_LABEL,
  EXPECTED_EXTRA_MAX,
  SOCKS_ARRANGEMENTS,
  SOCKS_ARRANGEMENT_LABELS,
  SOCKS_HINT,
  SOCKS_LABEL,
  SOCKS_NOTE_MAX,
  isSocksArrangement,
  type BeoGuestsSocks as Stored,
} from "@shared/beoGuestsSocks";

/** The Select's value for "none chosen" (Radix keeps "" for its placeholder). */
const NOT_SET = "__not_set__";

/** A count as typed: empty is none (null); a whole number from 0 to 999 is kept; anything else is not taken. */
function countTyped(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= EXPECTED_EXTRA_MAX ? n : undefined;
}

/**
 * SCRUM-1031: the expected extra guests and the socks arrangement, in the BEO editor's Event Info,
 * in the operations brief's words and its drawing's order (after the package): information for
 * reception, never sent to the till. Each change goes to the form's own event fields, saved with
 * the BEO; a party that stores none of them shows them empty and its Save sends none.
 */
export function BeoGuestsSocks({ value, onChange, readOnly = false }: {
  value: Stored;
  onChange: (next: Partial<Stored>) => void;
  readOnly?: boolean;
}) {
  const arrangement = isSocksArrangement(value.socksArrangement) ? value.socksArrangement : null;
  // The note belongs to "Other / Custom" and is saved only with it; the last one written is kept
  // here while another option is tried, so choosing "Other / Custom" again brings it back.
  const lastNote = useRef("");
  useEffect(() => {
    if (typeof value.socksNote === "string" && value.socksNote.trim()) lastNote.current = value.socksNote;
  }, [value.socksNote]);
  const otherNote = arrangement === "other" ? value.socksNote ?? "" : "";
  const countField = (key: "expectedExtraKids" | "expectedExtraAdults", words: string) => (
    <label className="flex items-center gap-2 text-sm" data-testid={`label-${key}`}>
      <span className="text-muted-foreground" aria-hidden="true">+</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={EXPECTED_EXTRA_MAX}
        step={1}
        value={value[key] ?? ""}
        placeholder="0"
        onChange={(e) => {
          const n = countTyped(e.target.value);
          if (n !== undefined) onChange({ [key]: n });
        }}
        disabled={readOnly}
        aria-label={`Expected extra ${words}`}
        className="h-9 w-16 bg-background text-sm tabular-nums"
        data-testid={`input-${key === "expectedExtraKids" ? "expected-extra-kids" : "expected-extra-adults"}`}
      />
      <span>{words}</span>
    </label>
  );

  return (
    <div className="space-y-4" data-testid="beo-guests-socks">
      <div className="space-y-2 rounded-md border border-amber-500/25 bg-amber-50/80 px-3 py-2.5 dark:bg-amber-500/10" data-testid="beo-expected-extra">
        <Label className="block text-xs text-amber-800 dark:text-amber-300">{EXPECTED_EXTRA_LABEL}</Label>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {countField("expectedExtraKids", "children")}
          {countField("expectedExtraAdults", "adults")}
        </div>
      </div>
      <div className="space-y-1" data-testid="beo-socks">
        <Label htmlFor="select-socks-arrangement" className="block text-xs text-muted-foreground">{SOCKS_LABEL}</Label>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Select
            value={arrangement ?? NOT_SET}
            onValueChange={(next) => {
              if (next === NOT_SET) onChange({ socksArrangement: null, socksNote: null });
              else if (isSocksArrangement(next)) onChange({ socksArrangement: next, socksNote: next === "other" && lastNote.current.trim() ? lastNote.current : null });
            }}
            disabled={readOnly}
          >
            <SelectTrigger id="select-socks-arrangement" className="h-9 w-full text-sm sm:w-64" data-testid="select-socks-arrangement">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NOT_SET} data-testid="option-socks-not-set">Not set</SelectItem>
              {SOCKS_ARRANGEMENTS.map((a) => (
                <SelectItem key={a} value={a} data-testid={`option-socks-${a}`}>{SOCKS_ARRANGEMENT_LABELS[a]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground" data-testid="text-socks-hint">{SOCKS_HINT}</p>
        </div>
        {arrangement === "other" && (
          <Input
            value={otherNote}
            maxLength={SOCKS_NOTE_MAX}
            placeholder="The arrangement, in a few words"
            onChange={(e) => onChange({ socksNote: e.target.value.trim() ? e.target.value : null })}
            disabled={readOnly}
            aria-label="The socks arrangement"
            className="mt-2 h-9 text-sm"
            data-testid="input-socks-note"
          />
        )}
      </div>
    </div>
  );
}

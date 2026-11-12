import { createContext, useContext, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  TILL_CODE_DEAD,
  TillMenuReadingSchema,
  bahtOfSatang,
  tillCodeState,
  tillMenuIndexOf,
  tillMenuSearch,
  tillMenuWordsMatch,
  type TillMenuIndex,
  type TillMenuItem,
  type TillMenuPark,
  type TillMenuStation,
} from "@shared/tillMenu";

/**
 * THE TILL'S MENU IN THE BEO (SCRUM-905): the picker and the mark.
 *
 * `useTillMenu` reads the till's live food and drink through this app's server
 * (`GET /api/beo/till-menu`, which passes the till's answer through with the
 * provisioning key and holds it a minute). `TillMenuPick` is the search beside
 * a kitchen or bar line's name: picking an item writes the till's name and
 * code onto the line (the screen decides how, `lineWithTillItem`); free typing
 * stays as it was. `TillCodeMark` says "No longer on the till" beside a line
 * whose code the till's menu no longer has — only when the menu was read, so
 * a till that does not answer never marks a line.
 */

export interface TillMenuState {
  index: TillMenuIndex;
  parks: TillMenuPark[] | null;
  loading: boolean;
  /** Why there is no menu, in the server's words; null when there is one (or none was asked). */
  message: string | null;
  /** False on a read-only BEO: no picker is offered, the marks still show. */
  editable: boolean;
}

const NO_MENU: TillMenuState = { index: tillMenuIndexOf(null), parks: null, loading: false, message: null, editable: false };

export const TillMenuContext = createContext<TillMenuState>(NO_MENU);

export const tillMenuQueryKey = (parkId: string | null | undefined) =>
  parkId ? ["/api/beo/till-menu", { parkId }] : ["/api/beo/till-menu"];

/** The server's answer, or null when it gave none this screen can read. */
async function fetchTillMenu(parkId: string | null | undefined): Promise<TillMenuPark[] | null> {
  const res = await fetch(parkId ? `/api/beo/till-menu?parkId=${encodeURIComponent(parkId)}` : "/api/beo/till-menu", {
    credentials: "include",
  });
  if (!res.ok) return null;
  const parsed = TillMenuReadingSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data.parks : null;
}

/**
 * One park's till menu (the BEO: the party's park), or every park the person
 * may open (`parkId` null: Settings > Set menu templates). Asked only while
 * `enabled`: a closed kitchen or bar section asks nothing.
 */
export function useTillMenu(parkId: string | null | undefined, opts: { enabled: boolean; editable: boolean; allParks?: boolean }): TillMenuState {
  const asked = opts.enabled && (!!parkId || !!opts.allParks);
  const { data, isLoading, isError } = useQuery<TillMenuPark[] | null>({
    queryKey: tillMenuQueryKey(opts.allParks ? null : parkId),
    queryFn: () => fetchTillMenu(opts.allParks ? null : parkId),
    enabled: asked,
    retry: false,
    staleTime: 60_000,
  });
  return useMemo(() => {
    if (!asked) return { ...NO_MENU, editable: opts.editable };
    const parks = data ?? null;
    const index = tillMenuIndexOf(parks);
    const message = index.known
      ? null
      : parks?.find((p) => p.message)?.message ?? (isLoading ? null : isError || data === null ? "The till's menu could not be read. Type the item instead." : null);
    return { index, parks, loading: isLoading, message, editable: opts.editable };
  }, [asked, data, isLoading, isError, opts.editable]);
}

const priceText = (satang: number) =>
  `฿${bahtOfSatang(satang).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

type Group = { heading: string; items: TillMenuItem[] };

/** What "Not from the till" answers to in the search. */
const NOT_FROM_THE_TILL_WORDS = ["not from the till", "remove", "clear"] as const;

/** The menu in its own order, grouped by category; the preferred station's first, the BEO-made items last. */
function groupsOf(items: readonly TillMenuItem[], prefer?: TillMenuStation): Group[] {
  const ordered = prefer ? [...items.filter((i) => i.station === prefer), ...items.filter((i) => i.station !== prefer)] : [...items];
  const groups: Group[] = [];
  const at = new Map<string, Group>();
  const partyOnly: TillMenuItem[] = [];
  for (const item of ordered) {
    if (item.beoOnly) {
      partyOnly.push(item);
      continue;
    }
    const heading = item.category ? (item.parentCategory ? `${item.parentCategory} · ${item.category}` : item.category) : "Other";
    let group = at.get(heading);
    if (!group) {
      group = { heading, items: [] };
      at.set(heading, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  if (partyOnly.length > 0) groups.push({ heading: "Made for a party (BEO only)", items: partyOnly });
  return groups;
}

/**
 * The search beside a line's name. Offers the till's menu and, on a line that
 * already carries a code, "Not from the till" (the code taken off, the name
 * kept). Nothing on a read-only BEO.
 */
export function TillMenuPick({
  code,
  onPick,
  onClear,
  prefer,
  testId,
}: {
  code?: string | null;
  onPick: (item: TillMenuItem) => void;
  onClear?: () => void;
  prefer?: TillMenuStation;
  testId: string;
}) {
  const menu = useContext(TillMenuContext);
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => groupsOf(menu.index.items, prefer), [menu.index.items, prefer]);
  // SCRUM-939: the list's own fuzzy match found letters scattered across the
  // code and the name, and it never moved a better heading up. So the search
  // is read here: with something typed, one list of the items found by what
  // was typed as it stands, the best answer first whatever its category
  // (equal answers in the menu's order); with nothing typed, the menu by
  // category as before.
  const [search, setSearch] = useState("");
  const typed = search.trim() !== "";
  const found = useMemo(
    () => (typed ? tillMenuSearch(groups.flatMap((group) => group.items), search) : []),
    [groups, search, typed],
  );
  if (!menu.editable) return null;
  const current = code?.trim() || null;
  const option = (item: TillMenuItem) => (
    <CommandItem
      key={item.code}
      value={item.code}
      title={item.category ? (item.parentCategory ? `${item.parentCategory} · ${item.category}` : item.category) : undefined}
      onSelect={() => {
        onPick(item);
        setOpen(false);
        setSearch("");
      }}
      data-testid={`${testId}-option-${item.code}`}
    >
      <Check className={`mr-2 h-3 w-3 shrink-0 ${current === item.code ? "opacity-100" : "opacity-0"}`} />
      <span className="flex-1 text-xs">{item.name}</span>
      {item.beoOnly && (
        <Badge variant="outline" className="text-[10px] px-1.5 ml-1 shrink-0">Party only</Badge>
      )}
      <span className="text-[10px] font-mono text-muted-foreground ml-2 shrink-0">{item.code}</span>
      <span className="text-[10px] text-muted-foreground ml-2 shrink-0">{priceText(item.priceSatang)}</span>
    </CommandItem>
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className="h-7 w-7 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-md hover:bg-accent"
          title="Pick from the till's menu"
          data-testid={testId}
        >
          <Search className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start" style={{ pointerEvents: "auto" }}>
        {!menu.index.known ? (
          <p className="p-3 text-xs text-muted-foreground" data-testid={`${testId}-unavailable`}>
            {menu.loading ? "Reading the till's menu…" : menu.message ?? "The till's menu is not available. Type the item instead."}
          </p>
        ) : (
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search the till's menu..."
              value={search}
              onValueChange={setSearch}
              data-testid={`${testId}-search`}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>Not on the till's menu. Type the item instead.</CommandEmpty>
              {typed
                ? found.length > 0 && <CommandGroup>{found.map(option)}</CommandGroup>
                : groups.map((group) => (
                    <CommandGroup key={group.heading} heading={group.heading}>
                      {group.items.map(option)}
                    </CommandGroup>
                  ))}
              {current && onClear && (!typed || tillMenuWordsMatch(NOT_FROM_THE_TILL_WORDS, search)) && (
                <CommandGroup>
                  <CommandItem
                    value="not-from-the-till"
                    onSelect={() => {
                      onClear();
                      setOpen(false);
                      setSearch("");
                    }}
                    data-testid={`${testId}-clear`}
                  >
                    <span className="text-xs text-muted-foreground">Not from the till (keep the name, drop the code)</span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * "No longer on the till" beside a line whose code the till's menu, once read,
 * does not have; `name` says which (a set menu option) where one mark stands
 * for several codes.
 */
export function TillCodeMark({ code, testId, name, className = "" }: { code?: string | null; testId: string; name?: string; className?: string }) {
  const menu = useContext(TillMenuContext);
  if (tillCodeState(menu.index, code) !== "dead") return null;
  return (
    <span
      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 bg-destructive/10 text-destructive border-destructive/30 ${className}`.trim()}
      title={`The till's menu no longer has ${code?.trim()}: pick the item again from the till's menu, or keep it as typed`}
      data-testid={testId}
    >
      {name ? `${name}: ${TILL_CODE_DEAD}` : TILL_CODE_DEAD}
    </span>
  );
}

/** The code chip's hover words: the till's own name for the item, when its menu was read. */
export function tillCodeTitle(index: TillMenuIndex, code: string | null | undefined): string {
  const item = code ? index.byCode.get(code.trim()) : undefined;
  if (item) return `On the till as ${item.name}${item.beoOnly ? " (made for a party)" : ""}`;
  return "The till's code for this line";
}

/** The till's menu as the nearest `TillMenuContext` holds it. */
export function useTillMenuIndex(): TillMenuIndex {
  return useContext(TillMenuContext).index;
}

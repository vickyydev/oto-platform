/**
 * A PARTY'S PACKAGE TOTAL (SCRUM-808), read once for the BEO's package module
 * and the BEO billing's Generate from BEO, so the two agree.
 *
 * Since SCRUM-803 the price sits on the package, not on its lines: the
 * included lines are 0-baht by design ("included in the package price"), so
 * adding them up said "Package Total: ฿0.00". The total is read the way the
 * till settles a party (SCRUM-804, `composePartySettlement` in
 * packages/shared/src/party-settlement.ts):
 *   - the package's own price for the party's date: weekday, or weekend on a
 *     Saturday or a Sunday. The till also prices a branch holiday as a weekend;
 *     this app does not know the park's pricing holidays (its public holidays
 *     are the leave calendar), so here the day alone decides, and a party with
 *     no date yet reads the weekday price;
 *   - children beyond the package's included count at its own extra-child
 *     price for that day, adults beyond the included count at its own
 *     extra-adult price; an extra the package prices none for is counted and
 *     said, never priced;
 *   - the add-ons bought: a line the package does not include, kept billable,
 *     quantity x its price, as `otoapp_v.event_packages` reads them.
 * A day price the package does not set falls back as the view reads it: the
 * weekday price to the base price, the weekend price to the weekday price.
 * Money is satang throughout, as the package tables store it.
 */

export type PartyRateMode = "weekday" | "weekend";

/** The package as the party's snapshot (or a template) holds it; satang. */
export interface PartyPackagePrices {
  basePrice: number;
  priceWeekday: number | null;
  priceWeekend: number | null;
  kidsIncluded: number | null;
  adultsIncluded: number | null;
  extraChildWeekday: number | null;
  extraChildWeekend: number | null;
  extraAdultWeekday: number | null;
  extraAdultWeekend: number | null;
  items: ReadonlyArray<{ label: string; included: boolean; billable: boolean; qty: number; unitPrice: number }>;
}

/** The party: its date (YYYY-MM-DD) and its expected counts. */
export interface PartyForPricing {
  eventDate: string | null | undefined;
  numChildren: number | null | undefined;
  numAdults: number | null | undefined;
}

export interface PartyPackageTotal {
  mode: PartyRateMode;
  /** The party's day ("Saturday"); null while it has no date. */
  day: string | null;
  packageSatang: number;
  extraChildren: number;
  /** Null when the package sets no extra-child price for that day. */
  extraChildUnitSatang: number | null;
  extraChildrenSatang: number;
  extraAdults: number;
  extraAdultUnitSatang: number | null;
  extraAdultsSatang: number;
  addOns: Array<{ label: string; qty: number; unitSatang: number; satang: number }>;
  addOnsSatang: number;
  totalSatang: number;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** The party's day and its rate: weekend on a Saturday or a Sunday; null when the date is not a day. */
export function partyDayOf(eventDate: string | null | undefined): { day: string; mode: PartyRateMode } | null {
  const m = typeof eventDate === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(eventDate.trim()) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  const n = at.getUTCDay();
  return { day: DAYS[n]!, mode: n === 0 || n === 6 ? "weekend" : "weekday" };
}

const count = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export function partyPackageTotal(pkg: PartyPackagePrices, party: PartyForPricing): PartyPackageTotal {
  const read = partyDayOf(party.eventDate);
  const mode: PartyRateMode = read?.mode ?? "weekday";
  const weekday = pkg.priceWeekday ?? pkg.basePrice;
  const weekend = pkg.priceWeekend ?? pkg.priceWeekday ?? pkg.basePrice;
  const packageSatang = mode === "weekend" ? weekend : weekday;
  const extraChildren = pkg.kidsIncluded == null ? 0 : Math.max(0, count(party.numChildren) - pkg.kidsIncluded);
  const extraAdults = pkg.adultsIncluded == null ? 0 : Math.max(0, count(party.numAdults) - pkg.adultsIncluded);
  const extraChildUnitSatang = mode === "weekend" ? pkg.extraChildWeekend : pkg.extraChildWeekday;
  const extraAdultUnitSatang = mode === "weekend" ? pkg.extraAdultWeekend : pkg.extraAdultWeekday;
  const extraChildrenSatang = extraChildren * (extraChildUnitSatang ?? 0);
  const extraAdultsSatang = extraAdults * (extraAdultUnitSatang ?? 0);
  const addOns = pkg.items
    .filter((i) => !i.included && i.billable && i.qty > 0)
    .map((i) => ({ label: i.label, qty: i.qty, unitSatang: i.unitPrice, satang: i.qty * i.unitPrice }));
  const addOnsSatang = addOns.reduce((sum, a) => sum + a.satang, 0);
  return {
    mode,
    day: read?.day ?? null,
    packageSatang,
    extraChildren,
    extraChildUnitSatang,
    extraChildrenSatang,
    extraAdults,
    extraAdultUnitSatang,
    extraAdultsSatang,
    addOns,
    addOnsSatang,
    totalSatang: packageSatang + extraChildrenSatang + extraAdultsSatang + addOnsSatang,
  };
}

/** One line of the total's breakdown, as the package module shows it. */
export interface PartyPackageTotalLine {
  key: "package" | "extraChildren" | "extraAdults" | "addOns";
  label: string;
  satang: number;
}

/**
 * The breakdown the package module shows above its total: the package price
 * for the party's day, the extra children, the extra adults and the add-ons
 * (each only when there are any). `money` writes satang the module's way.
 */
export function partyPackageTotalLines(t: PartyPackageTotal, money: (satang: number) => string): PartyPackageTotalLine[] {
  const lines: PartyPackageTotalLine[] = [
    {
      key: "package",
      label: t.day ? `Package price for ${t.day} (${t.mode})` : "Package price (weekday: the party has no date yet)",
      satang: t.packageSatang,
    },
  ];
  const extra = (n: number, one: string, many: string, unit: number | null, what: string) =>
    unit === null ? `${n} ${n === 1 ? one : many} (the package sets no ${what} price for a ${t.mode})` : `${n} ${n === 1 ? one : many} × ${money(unit)}`;
  if (t.extraChildren > 0) {
    lines.push({ key: "extraChildren", label: `Extra children: ${extra(t.extraChildren, "child", "children", t.extraChildUnitSatang, "extra-child")}`, satang: t.extraChildrenSatang });
  }
  if (t.extraAdults > 0) {
    lines.push({ key: "extraAdults", label: `Extra adults: ${extra(t.extraAdults, "adult", "adults", t.extraAdultUnitSatang, "extra-adult")}`, satang: t.extraAdultsSatang });
  }
  if (t.addOns.length > 0) lines.push({ key: "addOns", label: "Add-ons", satang: t.addOnsSatang });
  return lines;
}

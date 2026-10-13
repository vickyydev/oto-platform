import { pool } from "./db";
import {
  buildSourceBreakdown,
  mergeSourceBreakdowns,
  type SourceBreakdownEntry,
} from "./sourceRegistry";

const PAPAYA_API_URL = "https://api.papaya.co.th/api/v1";
const PAPAYA_RECEPTION_TOKEN = process.env.PAPAYA_RECEPTION_TOKEN || "";
const PAPAYA_RESTAURANT_TOKEN = process.env.PAPAYA_RESTAURANT_TOKEN || "";

if (!PAPAYA_RECEPTION_TOKEN) {
  console.warn("[Papaya] WARNING: PAPAYA_RECEPTION_TOKEN is not set — park/reception data will use cache only!");
}
if (!PAPAYA_RESTAURANT_TOKEN) {
  console.warn("[Papaya] WARNING: PAPAYA_RESTAURANT_TOKEN is not set — cafe/restaurant data will use cache only!");
}

const CATEGORY_MAP: Record<string, string> = {
  "01JKR48K5B9M2CQPJP2SG5P5D0": "Tickets & Packages",
  "01JKR48X2R3NHA1P3V284303EV": "Tickets & Packages",
  "01JX9CVK3NFGPF1KJRDMBJM4M7": "Tickets & Packages",
  "01JKR554RYDGTK7HCHC5XEKGQ6": "Socks",
};

function getCategoryForItem(item: any): string {
  const name = (item.name || "").toLowerCase();
  // Name-based birthday/party detection wins over the explicit
  // menuItemCategoryId map: e.g. "Demons hunters party kids" lives in
  // Papaya's generic "Tickets" menu category but is an event line.
  if (name.includes("birthday") || name.includes("bday") || name.includes("party") || name.includes("deposit")) return "Events / Birthdays";
  // Camp is its own top-level category (was buried in Extras). Checked early
  // so names like "Extra Kid Camp" or "Camp 5 days" don't get grabbed by the
  // kid/pass/hour ticket keywords below. Word-boundary match so unrelated
  // products (e.g. "Campari") don't leak in.
  if (/\bcamp\b/.test(name)) return "Camp";
  if (CATEGORY_MAP[item.menuItemCategoryId]) {
    return CATEGORY_MAP[item.menuItemCategoryId];
  }
  if (name.includes("membership")) return "Memberships";
  if (name.includes("kid") || name.includes("child") || name.includes("adult") || name.includes("entry") || name.includes("hour") || name.includes("pass") || name.includes("voucher")) return "Tickets & Packages";
  if (name.includes("upgrade")) return "Tickets & Packages";
  if (name.includes("sock")) return "Socks";
  if (name.includes("toy") || name.includes("rabbit") || name.includes("spider")) return "Merchandise";
  if (name.includes("credit") || name.includes("parent")) return "Tickets & Packages";
  if (name.includes("nanny")) return "Nanny & Drop-off";
  if (name.includes("work shop") || name.includes("workshop")) return "Workshop";
  if (name.includes("zombie") || name.includes("photo") || name.includes("face paint") || name.includes("pinata") || name.includes("pinyata") || name.includes("easter") || name.includes("game") || name.includes("special price") || name.includes("special for") || name.includes("winter ball")) return "Extras";
  return "Extras";
}

function normalizePapayaPaymentMethod(payment: any): string {
  const method = (payment.offlineMethod || payment.method || "other").toLowerCase();
  if (method.includes("cash")) return "Cash";
  if (method.includes("promptpay") || method.includes("qr")) return "PromptPay/QR";
  if (method.includes("card") || method.includes("credit") || method.includes("debit")) return "Card";
  return "Other";
}

// task-111: bdayRevenue marks the portion of an item's revenue that came
// from birthday-channel orders so the UI can render a "bday" badge.
export interface PapayaCategoryItem {
  name: string;
  category: string;
  quantity: number;
  revenue: number;
  bdayRevenue?: number;
}

// task-111/task-114: Papaya formula version. Bumped when calc/aggregation
// changes (Birthdays source bucket, per-item bdayRevenue tagging, BD
// allocation toggle, birthdayChannelSplit metadata). Cached summaries on a
// different version are rebuilt from raw on next read.
// v13: always builds categoryBreakdown in "bday" form and emits
// `birthdayChannelSplit` metadata so the client can flip allocation views
// instantly without a server roundtrip / refetch.
// v19: "Camp" promoted from an Extras item to its own top-level category
// (park terminal + restaurant terminal camp meals) so camp revenue is
// visible against total revenue.
// v21: hourly activity now includes parsed ticket counts and Camp-channel
// subtotals so historical cached days rebuild for the Chalong heatmap.
export const PAPAYA_FORMULA_VERSION = "v21";

// task-114: categories a birthday-channel line item is allowed to flow out
// to when the user views allocation as "split". Anything else stays in
// "Events / Birthdays" (kept under birthdayChannelSplit["Events / Birthdays"]).
const PAPAYA_BIRTHDAY_SPLIT_CATEGORIES = new Set([
  "Tickets & Packages",
  "F&B",
  "Socks",
  "Memberships",
  "Merchandise",
  "Camp",
]);

export type PapayaBirthdayAllocation = "bday" | "split";

export interface PapayaDailySummary {
  date: string;
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  paymentBreakdown: Record<string, number>;
  topProducts: Array<PapayaCategoryItem>;
  categoryBreakdown: Record<string, { revenue: number; quantity: number; items: PapayaCategoryItem[]; subCategories?: Record<string, { revenue: number; quantity: number; items: PapayaCategoryItem[] }> }>;
  hourlyBreakdown: Array<{
    hour: number;
    label?: string;
    revenue: number;
    orders: number;
    ticketsSold: number;
    summerCamp?: { revenue: number; orders: number; ticketsSold: number };
  }>;
  guestBreakdown: { kids: number; adults: number; totalGuests: number } | null;
  discountTotal: number;
  channelBreakdown: Record<string, number>;
  discountBreakdown: Array<{ name: string; count: number; total: number }>;
  sourceBreakdown?: SourceBreakdownEntry[];
  formulaVersion?: string;
  // task-103: manual override of daily BD totals (Chalong). When present,
  // categoryBreakdown["Events / Birthdays"].revenue has been REPLACED with
  // partyTotal + fnbTotal so consumers see the corrected BD number, but
  // the split is preserved here for UIs that need it.
  birthdayOverride?: { partyTotal: number; fnbTotal: number } | null;
  // task-114 v13: per-natural-category breakdown of revenue that came from
  // birthday-channel orders. categoryBreakdown is always in "bday" form
  // (everything in Events / Birthdays); the client uses this metadata to
  // re-bucket on the fly when the user flips the allocation toggle. Keys
  // are only natural categories from PAPAYA_BIRTHDAY_SPLIT_CATEGORIES;
  // ambiguous line items aren't included (they stay in Events / Birthdays
  // under either view).
  birthdayChannelSplit?: Record<
    string,
    {
      revenue: number;
      quantity: number;
      items: Array<{ name: string; category: string; revenue: number; quantity: number }>;
      subCategories?: Record<string, { revenue: number; quantity: number; items: Array<{ name: string; category: string; revenue: number; quantity: number }> }>;
    }
  >;
  // Deprecated (v2): used to record the toggle state baked into the cached
  // summary. v3+ always builds in "bday" form, so this is no longer set on
  // new builds, but the field is preserved on the type so existing v2 cache
  // rows still parse without losing data before they get rebuilt.
  birthdayAllocation?: PapayaBirthdayAllocation;
}

async function fetchPapayaOrdersSlice(
  token: string,
  from: string,
  to: string,
  seenIds: Set<string>
): Promise<any[]> {
  const url = `${PAPAYA_API_URL}/orders?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const TIMEOUT_MS = 45000;
  const MAX_RETRIES = 2;

  for (let tryNum = 1; tryNum <= MAX_RETRIES; tryNum++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`Papaya API HTTP ${resp.status}`);
      const json = await resp.json();
      const rawOrders = json.orders || [];
      const orders: any[] = [];
      for (const order of rawOrders) {
        const id = order.id || order.orderId;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        orders.push(order);
      }
      return orders;
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        console.error(`[Papaya] Request timed out after ${TIMEOUT_MS}ms (attempt ${tryNum}/${MAX_RETRIES}): ${url}`);
        if (tryNum < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        return [];
      }
      throw e;
    }
  }
  return [];
}

function toBangkokISO(utcMs: number): string {
  const bkk = new Date(utcMs + 7 * 3600 * 1000);
  const y = bkk.getUTCFullYear();
  const m = String(bkk.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bkk.getUTCDate()).padStart(2, "0");
  const hh = String(bkk.getUTCHours()).padStart(2, "0");
  const mm = String(bkk.getUTCMinutes()).padStart(2, "0");
  const ss = String(bkk.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${dd}T${hh}:${mm}:${ss}+07:00`;
}

async function fetchPapayaOrders(
  token: string,
  from: string,
  to: string,
  _maxPages: number = 20
): Promise<any[]> {
  const seenIds = new Set<string>();
  const allOrders: any[] = [];

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const totalMs = toMs - fromMs;

  if (totalMs <= 2 * 3600 * 1000) {
    return fetchPapayaOrdersSlice(token, from, to, seenIds);
  }

  const SLICE_MS = 2 * 3600 * 1000;
  let cursor = fromMs;

  while (cursor < toMs) {
    const sliceEnd = Math.min(cursor + SLICE_MS, toMs);
    const sliceFrom = toBangkokISO(cursor);
    const sliceTo = toBangkokISO(sliceEnd);

    const orders = await fetchPapayaOrdersSlice(token, sliceFrom, sliceTo, seenIds);
    allOrders.push(...orders);
    cursor = sliceEnd;
    if (cursor < toMs) await new Promise((r) => setTimeout(r, 220));
  }

  return allOrders;
}

function getCafeCategory(item: any): string {
  const name = (item.name || "").toLowerCase();
  // Camp meals ("Camp Breakfast", "Camp Lunch") sold on the restaurant
  // terminal belong to Camp, not F&B, so the Camp row shows the full
  // camp-program revenue. Word-boundary match keeps e.g. "Campari" in F&B.
  if (/\bcamp\b/.test(name)) return "Camp";
  if (name.includes("kid") && (name.includes("hour") || name.includes("entry") || name.includes("pass") || name.includes("membership"))) return "Tickets & Packages";
  if (name.includes("adult") && (name.includes("hour") || name.includes("entry") || name.includes("pass") || name.includes("ticket"))) return "Tickets & Packages";
  if (name.includes("membership") && name.includes("entry")) return "Tickets & Packages";
  if (name.includes("sock")) return "Merchandise";
  return "F&B";
}

// task-119 follow-up: Food / Drinks sub-category classifier for Papaya
// (Chalong) F&B items so the Revenue by Category drill-down has the same
// sub-grouping as Floresta. Heuristic is name-based (Papaya items don't
// carry a category title we can rely on); defaults to Food.
export function classifyPapayaFnbSubCategory(rawName: string): "Food" | "Drinks" {
  const n = (rawName || "").toLowerCase();
  const drinkKeywords = [
    "espresso", "americano", "cappuccino", "latte", "mocha", "macchiato",
    "hot chocolate", "iced chocolate", "coffee",
    " tea", "earl grey", "english breakfast", "peppermint", "green tea", "camomile",
    "smoothie", "juice", "lemonade", "soda", " mors", "milk",
    "water", "pellegrino", "acqua panna", "sparkling",
    "beer", "singha", "wine", "prosecco", "bubbles",
    "(glass)", "(bottle)", " jug", "jug of", "jug ",
    "coke", "coke zero",
  ];
  if (drinkKeywords.some((k) => n.includes(k))) return "Drinks";
  return "Food";
}

function attachFnbSubCategories<T extends { revenue: number; quantity: number; items: Array<{ name: string; revenue: number; quantity: number }> }>(entry: T): T & { subCategories?: Record<string, { revenue: number; quantity: number; items: any[] }> } {
  const subs: Record<string, { revenue: number; quantity: number; items: any[] }> = {
    Food: { revenue: 0, quantity: 0, items: [] },
    Drinks: { revenue: 0, quantity: 0, items: [] },
  };
  for (const it of entry.items) {
    const sub = classifyPapayaFnbSubCategory(it.name);
    subs[sub].revenue += it.revenue || 0;
    subs[sub].quantity += it.quantity || 0;
    subs[sub].items.push(it);
  }
  for (const k of Object.keys(subs)) {
    subs[k].items.sort((a: any, b: any) => (b.revenue || 0) - (a.revenue || 0));
  }
  return Object.assign(entry, { subCategories: subs });
}

interface PapayaTicketInfo {
  kids: number;
  adults: number;
  stayHours: number;
  stayLabel: string;
  kidRevenue: number;
  adultRevenue: number;
  isUpgrade: boolean;
  isMembership: boolean;
  orderTime: Date | null;
}

export function parsePapayaTicketItem(itemName: string, qty: number, revenue: number): PapayaTicketInfo {
  const name = itemName.toLowerCase().trim();
  const result: PapayaTicketInfo = {
    kids: 0, adults: 0, stayHours: 0, stayLabel: "",
    kidRevenue: 0, adultRevenue: 0, isUpgrade: false, isMembership: false, orderTime: null,
  };

  if (name.includes("upgrade") || name.includes("extra 1 hour") || name.includes("extra hour")) {
    result.isUpgrade = true;
    return result;
  }

  if (name.includes("membership") && name.includes("purchase")) {
    result.isMembership = true;
    return result;
  }

  if (name.includes("socks") || name.includes("diaper") || name.includes("spider") ||
      name.includes("zombie") || name.includes("face paint") || name.includes("photo")) {
    return result;
  }

  let numKids = 0;
  const multiKidMatch = name.match(/(\d+)\s*kids?\s*[-–]/i) || name.match(/for\s+(\d+)\s+kids?/i);
  if (multiKidMatch) {
    numKids = parseInt(multiKidMatch[1]) * qty;
  } else if (name.includes("kid") || name.includes("child")) {
    numKids = qty;
  }

  if (name.includes("membership") && name.includes("entry")) {
    numKids = qty;
    result.kids = numKids;
    result.kidRevenue = revenue;
    result.stayHours = 2;
    result.stayLabel = "2 Hours";
    return result;
  }

  if (name.includes("birthday") && numKids > 0) {
    result.kids = numKids;
    result.kidRevenue = revenue;
    result.stayHours = 3;
    result.stayLabel = "3 Hours";
    return result;
  }

  if (numKids > 0) {
    result.kids = numKids;
    result.kidRevenue = revenue;

    if (name.includes("all day") || name.includes("full day")) {
      result.stayHours = 8;
      result.stayLabel = "Full Day";
    } else if (name.includes("2h") || name.includes("2 hour")) {
      result.stayHours = 2;
      result.stayLabel = "2 Hours";
    } else if (name.includes("1 hour") || name.includes("1h")) {
      result.stayHours = 1;
      result.stayLabel = "1 Hour";
    } else if (name.includes("3h") || name.includes("3 hour")) {
      result.stayHours = 3;
      result.stayLabel = "3 Hours";
    } else if (name.includes("4h") || name.includes("4 hour")) {
      result.stayHours = 4;
      result.stayLabel = "4 Hours";
    } else {
      result.stayHours = 2;
      result.stayLabel = "2 Hours";
    }
    return result;
  }

  if (name.includes("adult") || name.includes("parent")) {
    if (name.includes("credit") || name.includes("restaurant")) {
      result.adults = qty;
      result.adultRevenue = revenue;
    } else {
      result.adults = qty;
      result.adultRevenue = revenue;
    }
    return result;
  }

  if (name.includes("easter") && !name.includes("adult")) {
    result.kids = qty;
    result.kidRevenue = revenue;
    result.stayHours = 2;
    result.stayLabel = "2 Hours";
    return result;
  }

  if (/\bcamp\b/i.test(name)) {
    result.kids = qty;
    result.kidRevenue = revenue;
    result.stayHours = 8;
    result.stayLabel = "Full Day";
    return result;
  }

  return result;
}

export function isPapayaSummerCampOrder(order: { channelName?: string | null }): boolean {
  return /\bcamp\b/i.test(order.channelName || "");
}

export function buildPapayaSummary(
  date: string,
  orders: any[],
  terminal: string = "reception",
  _birthdayAllocation: PapayaBirthdayAllocation = "bday",
): PapayaDailySummary {
  const isCafe = terminal === "restaurant";
  const completed = orders.filter((o) => o.status === "complete");
  // task-114 v3: track per-natural-category revenue/quantity/items that came
  // from birthday-channel orders. categoryBreakdown is always built in
  // "bday" form (everything Events / Birthdays); this side map lets the
  // client re-bucket instantly when the allocation toggle is flipped.
  const birthdayChannelSplitMap: Record<
    string,
    { revenue: number; quantity: number; items: Map<string, { name: string; category: string; revenue: number; quantity: number; bdayRevenue?: number }> }
  > = {};

  let totalRevenue = 0;
  let discountTotal = 0;
  const paymentBreakdown: Record<string, number> = {};
  const productMap = new Map<string, PapayaCategoryItem>();
  const categoryMap: Record<string, { revenue: number; quantity: number; items: Map<string, PapayaCategoryItem> }> = {};
  const hourlyMap = new Map<number, {
    revenue: number;
    orders: number;
    ticketsSold: number;
    summerCamp: { revenue: number; orders: number; ticketsSold: number };
  }>();
  const channelBreakdown: Record<string, number> = {};
  const discountMap = new Map<string, { name: string; count: number; total: number }>();
  let kids = 0;
  let adults = 0;
  let kidRevenue = 0;
  let adultRevenue = 0;
  const stayDistMap = new Map<string, { label: string; hours: number; count: number }>();
  const ticketDetails = new Map<string, { name: string; type: string; quantity: number; revenue: number }>();
  const guestEntries: Array<{ kids: number; adults: number; stayHours: number; orderTime: Date }> = [];

  for (const order of completed) {
    const orderBill = order.billTotal || 0;
    const orderDiscount = order.discountTotal || 0;

    const orderRevenue = order.total != null ? (order.total as number) : orderBill;

    totalRevenue += orderRevenue;
    discountTotal += orderDiscount;

    const discountRatio = orderBill > 0 ? orderRevenue / orderBill : 1;

    for (const disc of order.appliedDiscounts || []) {
      const dName = disc.name || "Unknown Discount";
      const dTotal = disc.total || 0;
      const existing = discountMap.get(dName);
      if (existing) {
        existing.count += 1;
        existing.total += dTotal;
      } else {
        discountMap.set(dName, { name: dName, count: 1, total: dTotal });
      }
    }

    for (const p of order.payments || []) {
      if (p.status === "cancelled") continue;
      const method = normalizePapayaPaymentMethod(p);
      paymentBreakdown[method] = (paymentBreakdown[method] || 0) + (p.amount || 0);
    }

    channelBreakdown[order.channelName || "Unknown"] =
      (channelBreakdown[order.channelName || "Unknown"] || 0) + orderRevenue;

    const channelName = (order.channelName || "").toLowerCase();
    const isBirthdayChannel = channelName.includes("birthday");

    let orderTicketsSold = 0;
    for (const item of order.items || []) {
      const name = item.name || "Unknown";
      // task-114 v3: birthday-channel line items always roll up to Events /
      // Birthdays in `categoryBreakdown`. We additionally record their
      // natural classification in `birthdayChannelSplitMap` so the client
      // can re-bucket on the fly when the user flips the allocation toggle.
      // Ambiguous items (classifier returns something outside the allow
      // list — Extras, Nanny, entertainment, unknown) aren't split and
      // stay in Events / Birthdays under either view.
      let category: string;
      let naturalSplitCategory: string | null = null;
      if (isBirthdayChannel) {
        category = "Events / Birthdays";
        const classified = isCafe ? getCafeCategory(item) : getCategoryForItem(item);
        if (PAPAYA_BIRTHDAY_SPLIT_CATEGORIES.has(classified)) {
          naturalSplitCategory = classified;
        }
      } else {
        category = isCafe ? getCafeCategory(item) : getCategoryForItem(item);
      }
      const qty = item.quantity || 1;
      const rawRev = item.itemTotal || 0;
      const rev = Math.round(rawRev * discountRatio);

      // task-119: split bday vs non-bday lines for the same product into
      // separate rows by including the birthday-channel flag in every item
      // map key. A product appearing both with and without the birthday
      // channel now produces two rows — bday row (bdayRevenue == revenue)
      // and non-bday row (bdayRevenue unset).
      const bdayKey = isBirthdayChannel ? "1" : "0";
      const itemKey = `${name}::${bdayKey}`;

      if (naturalSplitCategory) {
        if (!birthdayChannelSplitMap[naturalSplitCategory]) {
          birthdayChannelSplitMap[naturalSplitCategory] = {
            revenue: 0,
            quantity: 0,
            items: new Map(),
          };
        }
        const bucket = birthdayChannelSplitMap[naturalSplitCategory];
        bucket.revenue += rev;
        bucket.quantity += qty;
        const existingSplitItem = bucket.items.get(itemKey);
        if (existingSplitItem) {
          existingSplitItem.quantity += qty;
          existingSplitItem.revenue += rev;
          existingSplitItem.bdayRevenue = (existingSplitItem.bdayRevenue || 0) + rev;
        } else {
          bucket.items.set(itemKey, { name, category: naturalSplitCategory, quantity: qty, revenue: rev, bdayRevenue: rev });
        }
      }

      const existing = productMap.get(itemKey);
      if (existing) {
        existing.quantity += qty;
        existing.revenue += rev;
        if (isBirthdayChannel) existing.bdayRevenue = (existing.bdayRevenue || 0) + rev;
      } else {
        const entry: PapayaCategoryItem = { name, category, quantity: qty, revenue: rev };
        if (isBirthdayChannel) entry.bdayRevenue = rev;
        productMap.set(itemKey, entry);
      }

      if (!categoryMap[category]) {
        categoryMap[category] = { revenue: 0, quantity: 0, items: new Map() };
      }
      categoryMap[category].revenue += rev;
      categoryMap[category].quantity += qty;
      const catItem = categoryMap[category].items.get(itemKey);
      if (catItem) {
        catItem.quantity += qty;
        catItem.revenue += rev;
        if (isBirthdayChannel) catItem.bdayRevenue = (catItem.bdayRevenue || 0) + rev;
      } else {
        const ci: PapayaCategoryItem = { name, category, quantity: qty, revenue: rev };
        if (isBirthdayChannel) ci.bdayRevenue = rev;
        categoryMap[category].items.set(itemKey, ci);
      }

      if (!isCafe) {
        const ticketInfo = parsePapayaTicketItem(name, qty, rev);
        orderTicketsSold += ticketInfo.kids + ticketInfo.adults;
        if (ticketInfo.kids > 0 || ticketInfo.adults > 0) {
          kids += ticketInfo.kids;
          adults += ticketInfo.adults;
          kidRevenue += ticketInfo.kidRevenue;
          adultRevenue += ticketInfo.adultRevenue;

          if (ticketInfo.stayLabel && ticketInfo.kids > 0) {
            const existing = stayDistMap.get(ticketInfo.stayLabel);
            if (existing) {
              existing.count += ticketInfo.kids;
            } else {
              stayDistMap.set(ticketInfo.stayLabel, {
                label: ticketInfo.stayLabel,
                hours: ticketInfo.stayHours,
                count: ticketInfo.kids,
              });
            }

            const orderTime = new Date(order.orderDate);
            for (let i = 0; i < ticketInfo.kids; i++) {
              guestEntries.push({
                kids: 1,
                adults: 0,
                stayHours: ticketInfo.stayHours,
                orderTime,
              });
            }
          }

          const detailKey = name;
          const detailType = ticketInfo.kids > 0 ? "kid" : "adult";
          const existing = ticketDetails.get(detailKey);
          if (existing) {
            existing.quantity += qty;
            existing.revenue += rev;
          } else {
            ticketDetails.set(detailKey, { name, type: detailType, quantity: qty, revenue: rev });
          }
        }
      }
    }

    const orderDate = new Date(order.orderDate);
    const bangkokHour = (orderDate.getUTCHours() + 7) % 24;
    let h = hourlyMap.get(bangkokHour);
    if (!h) {
      h = {
        revenue: 0,
        orders: 0,
        ticketsSold: 0,
        summerCamp: { revenue: 0, orders: 0, ticketsSold: 0 },
      };
      hourlyMap.set(bangkokHour, h);
    }
    h.revenue += orderRevenue;
    h.orders += 1;
    h.ticketsSold += orderTicketsSold;
    if (isPapayaSummerCampOrder(order)) {
      h.summerCamp.revenue += orderRevenue;
      h.summerCamp.orders += 1;
      h.summerCamp.ticketsSold += orderTicketsSold;
    }
  }

  // task-111: Birthdays bucket on Revenue by Source (Chalong). Channel
  // "Birthday Party" / similar is detected per-order; bday-channel orders
  // are removed from regular channel attribution and surfaced as their
  // own Birthdays row. Manual papaya_birthday_overrides later REPLACE this
  // row's revenue in applyPapayaBirthdayOverride.
  let papayaBirthdayRev = 0;
  let papayaBirthdayOrders = 0;
  const nonBdayCompleted: any[] = [];
  for (const o of completed) {
    const cn = (o.channelName || "").toLowerCase();
    const orderRev = o.total != null ? (o.total as number) : (o.billTotal || 0);
    if (cn.includes("birthday")) {
      papayaBirthdayRev += orderRev;
      papayaBirthdayOrders += 1;
    } else {
      nonBdayCompleted.push(o);
    }
  }
  const sourceBreakdown = buildSourceBreakdown(
    nonBdayCompleted.map((order) => ({
      revenue: order.total != null ? (order.total as number) : (order.billTotal || 0),
      discounts: (order.appliedDiscounts || []).map((d: any) => ({
        name: d.name || "",
        total: d.total || 0,
      })),
    })),
    Math.max(0, totalRevenue - papayaBirthdayRev),
  );
  if (papayaBirthdayRev > 0 || papayaBirthdayOrders > 0) {
    const walkInIdx = sourceBreakdown.findIndex((e) => e.source === "Walk-in" || e.source === "Unattributed");
    const entry = {
      source: "Birthdays",
      orders: papayaBirthdayOrders,
      revenue: Math.round(papayaBirthdayRev * 100) / 100,
      discount: 0,
      variants: [],
    };
    if (walkInIdx >= 0) sourceBreakdown.splice(walkInIdx, 0, entry);
    else sourceBreakdown.push(entry);
  }

  // task-119: productMap is keyed by `${name}::${bdayFlag}` so per-category
  // breakdown can split bday vs non-bday rows. topProducts is intentionally
  // out of scope for the split — collapse back to one row per product name.
  const topProductsByName = new Map<string, PapayaCategoryItem>();
  for (const entry of productMap.values()) {
    const ex = topProductsByName.get(entry.name);
    if (ex) {
      ex.quantity += entry.quantity;
      ex.revenue += entry.revenue;
      if (entry.bdayRevenue) ex.bdayRevenue = (ex.bdayRevenue || 0) + entry.bdayRevenue;
    } else {
      topProductsByName.set(entry.name, { ...entry });
    }
  }
  const topProducts = Array.from(topProductsByName.values())
    .filter((p) => p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const categoryBreakdown: Record<string, { revenue: number; quantity: number; items: Array<{ name: string; category: string; revenue: number; quantity: number }>; subCategories?: Record<string, { revenue: number; quantity: number; items: any[] }> }> = {};
  for (const [cat, data] of Object.entries(categoryMap)) {
    const entry: any = {
      revenue: data.revenue,
      quantity: data.quantity,
      items: Array.from(data.items.values()).sort((a, b) => b.revenue - a.revenue),
    };
    // task-119 follow-up: split F&B into Food / Drinks sub-categories to
    // mirror Floresta's drill-down behaviour.
    if (cat === "F&B") attachFnbSubCategories(entry);
    categoryBreakdown[cat] = entry;
  }

  // task-114 v3: serialize the per-natural-category birthday-channel split
  // for the client. Empty object when there are no birthday-channel orders.
  const birthdayChannelSplit: Record<
    string,
    { revenue: number; quantity: number; items: Array<{ name: string; category: string; revenue: number; quantity: number }>; subCategories?: Record<string, { revenue: number; quantity: number; items: any[] }> }
  > = {};
  for (const [cat, data] of Object.entries(birthdayChannelSplitMap)) {
    const entry: any = {
      revenue: data.revenue,
      quantity: data.quantity,
      items: Array.from(data.items.values()).sort((a, b) => b.revenue - a.revenue),
    };
    if (cat === "F&B") attachFnbSubCategories(entry);
    birthdayChannelSplit[cat] = entry;
  }

  const hourlyBreakdown = Array.from(hourlyMap.entries())
    .map(([hour, data]) => ({
      hour,
      label: `${hour.toString().padStart(2, "0")}:00`,
      categories: {},
      customerTypes: {},
      ...data,
    }))
    .sort((a, b) => a.hour - b.hour);

  return {
    date,
    totalRevenue,
    totalOrders: completed.length,
    avgOrderValue: completed.length > 0 ? totalRevenue / completed.length : 0,
    paymentBreakdown,
    topProducts,
    categoryBreakdown,
    hourlyBreakdown,
    guestBreakdown: kids > 0 || adults > 0 ? (() => {
      const stayDistribution = Array.from(stayDistMap.values()).sort((a, b) => a.hours - b.hours);
      const totalStayWeighted = stayDistribution.reduce((sum, s) => sum + s.hours * s.count, 0);
      const totalKidsWithStay = stayDistribution.reduce((sum, s) => sum + s.count, 0);
      const avgStayHours = totalKidsWithStay > 0 ? totalStayWeighted / totalKidsWithStay : 0;
      const details = Array.from(ticketDetails.values()).sort((a, b) => b.revenue - a.revenue);

      const nowBangkok = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
      const isToday = date === nowBangkok.toISOString().split("T")[0];
      let ongoingKids = 0;
      let ongoingAdults = 0;
      if (isToday) {
        const nowMs = nowBangkok.getTime();
        const GRACE_MS = 45 * 60 * 1000;
        for (const entry of guestEntries) {
          const endMs = entry.orderTime.getTime() + (entry.stayHours * 60 * 60 * 1000) + GRACE_MS;
          if (nowMs < endMs) {
            ongoingKids += entry.kids;
          }
        }
        if (ongoingKids > 0 && adults > 0) {
          const ratio = kids > 0 ? adults / kids : 1;
          ongoingAdults = Math.round(ongoingKids * ratio);
        }
      }

      return {
        kids, adults, totalGuests: kids + adults,
        kidTickets: kids,
        adultTickets: adults,
        estimatedTotalAdults: adults,
        totalInPark: kids + adults,
        adultRevenue,
        kidRevenue,
        avgStayHours: Math.round(avgStayHours * 10) / 10,
        stayDistribution,
        details,
        ongoingKids,
        ongoingAdults,
        ongoingTotal: ongoingKids + ongoingAdults,
        completedKids: kids - ongoingKids,
        completedAdults: adults - ongoingAdults,
        completedTotal: (kids + adults) - (ongoingKids + ongoingAdults),
      };
    })() : null,
    discountTotal,
    channelBreakdown,
    discountBreakdown: Array.from(discountMap.values()).sort((a, b) => b.total - a.total),
    sourceBreakdown,
    birthdayChannelSplit,
    formulaVersion: PAPAYA_FORMULA_VERSION,
  };
}

async function ensurePapayaCache() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS papaya_daily_cache (
      date TEXT PRIMARY KEY,
      terminal TEXT NOT NULL DEFAULT 'reception',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      summary_json JSONB NOT NULL
    )
  `);
}

async function ensurePapayaRawTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS papaya_orders (
      id TEXT NOT NULL,
      terminal TEXT NOT NULL DEFAULT 'reception',
      status TEXT,
      order_date TIMESTAMPTZ,
      total NUMERIC,
      bill_total NUMERIC,
      discount_total NUMERIC,
      channel_name TEXT,
      order_number TEXT,
      receipt_number TEXT,
      payments JSONB,
      applied_discounts JSONB,
      raw_json JSONB,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, terminal)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS papaya_order_items (
      id SERIAL PRIMARY KEY,
      papaya_order_id TEXT NOT NULL,
      terminal TEXT NOT NULL DEFAULT 'reception',
      name TEXT,
      quantity INTEGER DEFAULT 1,
      item_total NUMERIC DEFAULT 0,
      menu_item_category_id TEXT,
      status TEXT,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_papaya_orders_date ON papaya_orders (order_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_papaya_orders_terminal ON papaya_orders (terminal)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_papaya_order_items_order ON papaya_order_items (papaya_order_id, terminal)`);

  // task-103: manual override of daily BD totals for Chalong. When a row
  // exists for (order_date, terminal) the summary's
  // categoryBreakdown["Events / Birthdays"].revenue is REPLACED with
  // party_total + fnb_total (channel-detected BD revenue is discarded).
  // Note: terminal-key mapping — the user-facing "Chalong / Robinson"
  // branch is stored as terminal='reception' (matches papaya_orders
  // and papaya_daily_cache keying used elsewhere in this file).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS papaya_birthday_overrides (
      order_date DATE NOT NULL,
      terminal TEXT NOT NULL,
      party_total NUMERIC NOT NULL DEFAULT 0,
      fnb_total NUMERIC NOT NULL DEFAULT 0,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (order_date, terminal)
    )
  `);
  // Backward compat: in case an earlier deploy created the column as TEXT,
  // promote it to DATE so it matches shared/schema.ts.
  try {
    await pool.query(
      `ALTER TABLE papaya_birthday_overrides ALTER COLUMN order_date TYPE DATE USING order_date::DATE`,
    );
  } catch (_) {}
  await seedPapayaBirthdayOverrides();
  // task-103 Step 6: one-shot ingestion-gap report (runs every restart;
  // table ops above are idempotent so the same is fine for logs).
  await reportPapayaBirthdayIngestionGaps();
}

// Idempotent: only inserts rows that don't already exist (ON CONFLICT DO NOTHING).
async function seedPapayaBirthdayOverrides(): Promise<void> {
  const seed: Array<[string, number, number]> = [
    ["2026-03-01", 16700, 0],
    ["2026-03-07", 16700, 0],
    ["2026-03-08", 9000, 0],
    ["2026-03-09", 12000, 0],
    ["2026-03-12", 12000, 0],
    ["2026-03-13", 17000, 0],
    ["2026-03-14", 19500, 0],
    ["2026-03-15", 5000, 10800],
    ["2026-03-16", 5500, 0],
    ["2026-03-21", 18500, 0],
    ["2026-03-22", 12000, 0],
    ["2026-03-27", 12000, 5400],
    ["2026-03-28", 12000, 0],
    ["2026-03-29", 12000, 5400],
    ["2026-03-30", 3000, 0],
    ["2026-03-31", 12000, 0],
  ];
  for (const [date, party, fnb] of seed) {
    await pool.query(
      `INSERT INTO papaya_birthday_overrides (order_date, terminal, party_total, fnb_total, note)
       VALUES ($1, 'reception', $2, $3, 'task-103 backfill: Chalong March 2026')
       ON CONFLICT (order_date, terminal) DO NOTHING`,
      [date, party, fnb],
    );
  }
}

async function loadPapayaBirthdayOverride(
  date: string,
  terminal: string,
): Promise<{ partyTotal: number; fnbTotal: number } | null> {
  try {
    const res = await pool.query(
      `SELECT party_total, fnb_total FROM papaya_birthday_overrides WHERE order_date = $1 AND terminal = $2`,
      [date, terminal],
    );
    if (res.rows.length === 0) return null;
    return {
      partyTotal: parseFloat(res.rows[0].party_total) || 0,
      fnbTotal: parseFloat(res.rows[0].fnb_total) || 0,
    };
  } catch (_) {
    return null;
  }
}

// task-103: REPLACES channel-detected BD revenue with manual override.
function applyPapayaBirthdayOverride(
  summary: PapayaDailySummary,
  override: { partyTotal: number; fnbTotal: number } | null,
): void {
  if (!override) {
    summary.birthdayOverride = null;
    return;
  }
  const overrideTotal = override.partyTotal + override.fnbTotal;
  const existing = summary.categoryBreakdown["Events / Birthdays"];
  summary.categoryBreakdown["Events / Birthdays"] = {
    revenue: overrideTotal,
    quantity: existing?.quantity ?? 0,
    items: existing?.items ?? [],
  };
  summary.birthdayOverride = { partyTotal: override.partyTotal, fnbTotal: override.fnbTotal };

  // task-111: keep the Birthdays source bucket consistent with the override.
  // The bucket carries party PACKAGE revenue only (excludes the override F&B
  // total). When no party total is configured but a row exists, remove the
  // (possibly stale) channel-derived entry so we don't double-count.
  if (summary.sourceBreakdown) {
    const idx = summary.sourceBreakdown.findIndex((e) => e.source === "Birthdays");
    if (override.partyTotal > 0) {
      const entry = {
        source: "Birthdays",
        orders: idx >= 0 ? summary.sourceBreakdown[idx].orders : 0,
        revenue: Math.round(override.partyTotal * 100) / 100,
        discount: 0,
        variants: [],
      };
      if (idx >= 0) summary.sourceBreakdown[idx] = entry;
      else {
        const walkInIdx = summary.sourceBreakdown.findIndex(
          (e) => e.source === "Walk-in" || e.source === "Unattributed",
        );
        if (walkInIdx >= 0) summary.sourceBreakdown.splice(walkInIdx, 0, entry);
        else summary.sourceBreakdown.push(entry);
      }
    } else if (idx >= 0) {
      summary.sourceBreakdown.splice(idx, 1);
    }
  }
}

// task-103 Step 6: report Chalong ingestion gaps. For each seeded override
// date, look in papaya_orders (channel = 'birthday') for raw rows whose
// total matches the override total within ฿1. Logs matches per date or
// "no matching Papaya orders" when nothing lines up.
async function reportPapayaBirthdayIngestionGaps(): Promise<void> {
  try {
    const rows = await pool.query(
      `SELECT order_date, terminal, party_total, fnb_total FROM papaya_birthday_overrides ORDER BY order_date`,
    );
    for (const r of rows.rows) {
      const date: string =
        r.order_date instanceof Date
          ? r.order_date.toISOString().slice(0, 10)
          : String(r.order_date);
      const terminal: string = r.terminal;
      const expected = (parseFloat(r.party_total) || 0) + (parseFloat(r.fnb_total) || 0);
      const from = `${date}T00:00:00+07:00`;
      const to = `${date}T23:59:59+07:00`;
      const m = await pool.query(
        `SELECT id, total, channel_name FROM papaya_orders
         WHERE terminal = $1 AND order_date >= $2 AND order_date <= $3
           AND LOWER(COALESCE(channel_name,'')) LIKE '%birthday%'`,
        [terminal, from, to],
      );
      const totalSum = m.rows.reduce(
        (acc: number, row: any) => acc + (parseFloat(row.total) || 0),
        0,
      );
      if (m.rows.length === 0) {
        console.log(
          `[Papaya][task-103] ${terminal}:${date} no matching Papaya orders, using override totals only (expected ฿${expected})`,
        );
      } else {
        const within1 = Math.abs(totalSum - expected) <= 1;
        console.log(
          `[Papaya][task-103] ${terminal}:${date} found ${m.rows.length} birthday-channel order(s) summing ฿${totalSum.toFixed(2)} (override expected ฿${expected})${within1 ? " — match" : " — mismatch"}`,
        );
      }
    }
  } catch (e) {
    console.warn(`[Papaya][task-103] reportPapayaBirthdayIngestionGaps failed`, e);
  }
  // task-103 Step 5: log current Chalong March 2026 BD total from cache,
  // plus the override split (Non-F&B vs F&B) so verification numbers can be
  // checked against the targets explicitly.
  try {
    const cache = await pool.query(
      `SELECT summary_json FROM papaya_daily_cache
       WHERE date >= 'reception:2026-03-01' AND date <= 'reception:2026-03-31'`,
    );
    let bdTotal = 0;
    for (const r of cache.rows) {
      const s: any = r.summary_json;
      bdTotal += s?.categoryBreakdown?.["Events / Birthdays"]?.revenue || 0;
    }
    const splitRes = await pool.query(
      `SELECT COALESCE(SUM(party_total),0) AS p, COALESCE(SUM(fnb_total),0) AS f
       FROM papaya_birthday_overrides
       WHERE terminal = 'reception' AND order_date >= '2026-03-01' AND order_date <= '2026-03-31'`,
    );
    const partySum = parseFloat(splitRes.rows[0]?.p) || 0;
    const fnbSum = parseFloat(splitRes.rows[0]?.f) || 0;
    console.log(
      `[Papaya][task-103] verification (cached) — Chalong March 2026 BD=฿${bdTotal.toFixed(0)} (target ≈฿216,500); override split Non-F&B=฿${partySum.toFixed(0)} (target ≈฿194,900), F&B=฿${fnbSum.toFixed(0)} (target ≈฿21,600). Regenerate Chalong March cache to pick up overrides if total is off.`,
    );
  } catch (e) {
    console.warn(`[Papaya][task-103] Chalong verification log failed`, e);
  }
}

async function ensurePapayaSyncHealthTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS papaya_sync_health (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      terminal TEXT NOT NULL DEFAULT 'reception',
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'clean',
      orders_expected INT DEFAULT 0,
      orders_received INT DEFAULT 0,
      error_message TEXT,
      warnings JSONB
    )
  `);
  try {
    await pool.query(`ALTER TABLE papaya_sync_health ADD COLUMN IF NOT EXISTS terminal TEXT NOT NULL DEFAULT 'reception'`);
  } catch (_) {}
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_papaya_sync_health_date ON papaya_sync_health(date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_papaya_sync_health_synced_at ON papaya_sync_health(synced_at)`);
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_papaya_sync_health_terminal ON papaya_sync_health(terminal)`);
  } catch (_) {}
}

export interface PapayaSyncHealthRecord {
  id: number;
  date: string;
  syncedAt: string;
  status: "clean" | "partial" | "failed" | "skipped";
  ordersExpected: number;
  ordersReceived: number;
  errorMessage: string | null;
  warnings: string[] | null;
}

export async function recordPapayaSyncHealth(params: {
  date: string;
  terminal?: string;
  status: "clean" | "partial" | "failed" | "skipped";
  ordersExpected?: number;
  ordersReceived?: number;
  errorMessage?: string;
  warnings?: string[];
}): Promise<void> {
  await initPapayaCache();
  await pool.query(
    `INSERT INTO papaya_sync_health (date, terminal, status, orders_expected, orders_received, error_message, warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.date,
      params.terminal || "combined",
      params.status,
      params.ordersExpected || 0,
      params.ordersReceived || 0,
      params.errorMessage || null,
      params.warnings ? JSON.stringify(params.warnings) : null,
    ]
  );
  try {
    await pool.query(`DELETE FROM papaya_sync_health WHERE synced_at < NOW() - INTERVAL '90 days'`);
  } catch (_) {}
}

const STATUS_PRIORITY: Record<string, number> = { failed: 3, skipped: 2, partial: 1, clean: 0 };

export async function getPapayaSyncHealth(dates: string[]): Promise<PapayaSyncHealthRecord[]> {
  await initPapayaCache();
  if (dates.length === 0) return [];
  const result = await pool.query(
    `SELECT DISTINCT ON (date, terminal) id, date, terminal, synced_at, status, orders_expected, orders_received, error_message, warnings
     FROM papaya_sync_health
     WHERE date = ANY($1)
     ORDER BY date, terminal, synced_at DESC`,
    [dates]
  );

  const dateRows = new Map<string, any[]>();
  for (const r of result.rows) {
    if (!dateRows.has(r.date)) dateRows.set(r.date, []);
    dateRows.get(r.date)!.push(r);
  }

  return dates.map(date => {
    const rows = dateRows.get(date);
    if (!rows || rows.length === 0) {
      return {
        id: 0,
        date,
        syncedAt: "",
        status: "failed" as const,
        ordersExpected: 0,
        ordersReceived: 0,
        errorMessage: "Never synced",
        warnings: null,
      };
    }

    let worstStatus: "clean" | "partial" | "failed" | "skipped" = "clean";
    let totalExpected = 0;
    let totalReceived = 0;
    let latestSyncedAt = "";
    let latestId = 0;
    const allWarnings: string[] = [];
    const errorMessages: string[] = [];

    for (const r of rows) {
      const rowStatus = r.status as "clean" | "partial" | "failed" | "skipped";
      if ((STATUS_PRIORITY[rowStatus] || 0) > (STATUS_PRIORITY[worstStatus] || 0)) {
        worstStatus = rowStatus;
      }
      totalExpected += parseInt(r.orders_expected) || 0;
      totalReceived += parseInt(r.orders_received) || 0;
      if (!latestSyncedAt || r.synced_at > latestSyncedAt) {
        latestSyncedAt = r.synced_at;
        latestId = r.id;
      }
      if (r.error_message) errorMessages.push(`${r.terminal}: ${r.error_message}`);
      if (r.warnings) {
        const w = Array.isArray(r.warnings) ? r.warnings : [];
        allWarnings.push(...w.map((msg: string) => `${r.terminal}: ${msg}`));
      }
    }

    return {
      id: latestId,
      date,
      syncedAt: latestSyncedAt,
      status: worstStatus,
      ordersExpected: totalExpected,
      ordersReceived: totalReceived,
      errorMessage: errorMessages.length > 0 ? errorMessages.join("; ") : null,
      warnings: allWarnings.length > 0 ? allWarnings : null,
    };
  });
}

let papayaCacheReady = false;
async function initPapayaCache() {
  if (papayaCacheReady) return;
  await ensurePapayaCache();
  await ensurePapayaRawTables();
  await ensurePapayaSyncHealthTable();
  papayaCacheReady = true;
}

export async function getCachedPapayaSummary(date: string, terminal: string = "reception"): Promise<PapayaDailySummary | null> {
  await initPapayaCache();
  const key = `${terminal}:${date}`;
  const result = await pool.query(
    "SELECT summary_json FROM papaya_daily_cache WHERE date = $1",
    [key]
  );
  if (result.rows.length > 0) {
    return result.rows[0].summary_json as PapayaDailySummary;
  }
  return null;
}

async function setCachedPapayaSummary(date: string, summary: PapayaDailySummary, terminal: string = "reception"): Promise<void> {
  await initPapayaCache();
  const key = `${terminal}:${date}`;
  await pool.query(
    `INSERT INTO papaya_daily_cache (date, terminal, synced_at, summary_json)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (date) DO UPDATE SET synced_at = NOW(), summary_json = $3, terminal = $2`,
    [key, terminal, JSON.stringify(summary)]
  );
}

async function storeRawPapayaOrders(orders: any[], terminal: string): Promise<void> {
  await initPapayaCache();
  if (orders.length === 0) return;

  // NOTE: Unlike Funtopia (server/funtopia.ts:storeRawOrders), Papaya is safe
  // from the cross-date duplicate-order bug because each row is keyed on
  // (id, terminal) — NOT on order_date — and we use ON CONFLICT to upsert.
  // If an order's date shifts (e.g. partial payment settled days later) the
  // upsert overwrites the same row in place, so revenue is never double-
  // counted via JOINs across dates. Do NOT change this to a delete-by-date
  // pattern without first replicating Funtopia's cross-date sweep logic.
  for (const order of orders) {
    const orderId = order.id || order.orderId;
    if (!orderId) continue;

    await pool.query(
      `INSERT INTO papaya_orders (id, terminal, status, order_date, total, bill_total, discount_total, channel_name, order_number, receipt_number, payments, applied_discounts, raw_json, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (id, terminal) DO UPDATE SET
         status = EXCLUDED.status,
         order_date = EXCLUDED.order_date,
         total = EXCLUDED.total,
         bill_total = EXCLUDED.bill_total,
         discount_total = EXCLUDED.discount_total,
         channel_name = EXCLUDED.channel_name,
         order_number = EXCLUDED.order_number,
         receipt_number = EXCLUDED.receipt_number,
         payments = EXCLUDED.payments,
         applied_discounts = EXCLUDED.applied_discounts,
         raw_json = EXCLUDED.raw_json,
         synced_at = NOW()`,
      [
        orderId,
        terminal,
        order.status || null,
        order.orderDate || null,
        order.total != null ? order.total : null,
        order.billTotal || null,
        order.discountTotal || null,
        order.channelName || null,
        order.orderNumber || null,
        order.receiptNumber || null,
        JSON.stringify(order.payments || []),
        JSON.stringify(order.appliedDiscounts || []),
        JSON.stringify(order),
      ]
    );

    await pool.query(
      `DELETE FROM papaya_order_items WHERE papaya_order_id = $1 AND terminal = $2`,
      [orderId, terminal]
    );

    for (const item of order.items || []) {
      await pool.query(
        `INSERT INTO papaya_order_items (papaya_order_id, terminal, name, quantity, item_total, menu_item_category_id, status, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          orderId,
          terminal,
          item.name || null,
          item.quantity || 1,
          item.itemTotal || 0,
          item.menuItemCategoryId || null,
          item.status || null,
        ]
      );
    }
  }
}

async function loadRawOrdersForDate(date: string, terminal: string): Promise<any[]> {
  await initPapayaCache();
  const from = `${date}T00:00:00+07:00`;
  const to = `${date}T23:59:59+07:00`;
  const result = await pool.query(
    `SELECT raw_json FROM papaya_orders WHERE terminal = $1 AND order_date >= $2 AND order_date <= $3`,
    [terminal, from, to]
  );
  return result.rows.map((r: any) => r.raw_json);
}

export async function regeneratePapayaSummariesFromRaw(
  startDate?: string,
  endDate?: string,
  terminal?: string,
  onProgress?: (msg: string) => void
): Promise<{ regenerated: number }> {
  await initPapayaCache();

  let dateQuery = `SELECT DISTINCT DATE(order_date AT TIME ZONE 'Asia/Bangkok') as d, terminal FROM papaya_orders WHERE 1=1`;
  const params: any[] = [];
  let paramIdx = 1;

  if (startDate) {
    dateQuery += ` AND order_date >= $${paramIdx}`;
    params.push(`${startDate}T00:00:00+07:00`);
    paramIdx++;
  }
  if (endDate) {
    dateQuery += ` AND order_date <= $${paramIdx}`;
    params.push(`${endDate}T23:59:59+07:00`);
    paramIdx++;
  }
  if (terminal) {
    dateQuery += ` AND terminal = $${paramIdx}`;
    params.push(terminal);
    paramIdx++;
  }

  // Also include dates that only have a birthday override (no raw orders),
  // so override-only days get cached with their override totals applied.
  let overrideQuery = `SELECT order_date AS d, terminal FROM papaya_birthday_overrides WHERE 1=1`;
  const overrideParams: any[] = [];
  let oIdx = 1;
  if (startDate) {
    overrideQuery += ` AND order_date >= $${oIdx}`;
    overrideParams.push(startDate);
    oIdx++;
  }
  if (endDate) {
    overrideQuery += ` AND order_date <= $${oIdx}`;
    overrideParams.push(endDate);
    oIdx++;
  }
  if (terminal) {
    overrideQuery += ` AND terminal = $${oIdx}`;
    overrideParams.push(terminal);
    oIdx++;
  }

  dateQuery += ` ORDER BY d ASC`;

  const [dateResultRaw, overrideResult] = await Promise.all([
    pool.query(dateQuery, params),
    pool.query(overrideQuery, overrideParams),
  ]);
  const seen = new Set<string>();
  const combined: Array<{ d: any; terminal: string }> = [];
  for (const r of dateResultRaw.rows) {
    const dStr = new Date(r.d).toISOString().split("T")[0];
    const key = `${r.terminal}:${dStr}`;
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(r);
    }
  }
  for (const r of overrideResult.rows) {
    const dStr =
      r.d instanceof Date ? r.d.toISOString().split("T")[0] : String(r.d).slice(0, 10);
    const key = `${r.terminal}:${dStr}`;
    if (!seen.has(key)) {
      seen.add(key);
      combined.push({ d: r.d, terminal: r.terminal });
    }
  }
  combined.sort((a, b) => {
    const aStr = a.d instanceof Date ? a.d.toISOString() : String(a.d);
    const bStr = b.d instanceof Date ? b.d.toISOString() : String(b.d);
    return aStr.localeCompare(bStr);
  });
  const dateResult = { rows: combined };
  let regenerated = 0;

  for (const row of dateResult.rows) {
    const dateStr = new Date(row.d).toISOString().split("T")[0];
    const term = row.terminal;
    const orders = await loadRawOrdersForDate(dateStr, term);
    const summary = buildPapayaSummary(dateStr, orders, term);
    applyPapayaBirthdayOverride(summary, await loadPapayaBirthdayOverride(dateStr, term));
    await setCachedPapayaSummary(dateStr, summary, term);
    regenerated++;
    if (onProgress) onProgress(`Regenerated ${regenerated}: ${term}:${dateStr} → ${summary.totalOrders} orders`);
  }

  return { regenerated };
}

export async function clearPapayaCacheForDate(date: string): Promise<void> {
  await initPapayaCache();
  await pool.query(
    "DELETE FROM papaya_daily_cache WHERE date LIKE $1",
    [`%:${date}`]
  );
}

export async function clearPapayaCacheByTerminal(terminal: string): Promise<number> {
  await initPapayaCache();
  const result = await pool.query(
    "DELETE FROM papaya_daily_cache WHERE date LIKE $1",
    [`${terminal}:%`]
  );
  return result.rowCount || 0;
}

async function computeSourceBreakdownFromRawOrders(
  date: string,
  terminal: string,
  totalRevenue: number,
): Promise<SourceBreakdownEntry[]> {
  const from = `${date}T00:00:00+07:00`;
  const to = `${date}T23:59:59+07:00`;
  const res = await pool.query(
    `SELECT raw_json FROM papaya_orders
       WHERE terminal = $1 AND order_date >= $2 AND order_date <= $3`,
    [terminal, from, to],
  );
  const orders = res.rows
    .map((r: any) => r.raw_json as any)
    .filter((o: any) => o && o.status === "complete");
  let bdayRev = 0;
  let bdayOrders = 0;
  const nonBday: any[] = [];
  for (const o of orders) {
    const cn = (o.channelName || "").toLowerCase();
    const orderRev = o.total != null ? (o.total as number) : (o.billTotal || 0);
    if (cn.includes("birthday")) {
      bdayRev += orderRev;
      bdayOrders += 1;
    } else {
      nonBday.push(o);
    }
  }
  const breakdown = buildSourceBreakdown(
    nonBday.map((o: any) => ({
      revenue: o.total != null ? (o.total as number) : (o.billTotal || 0),
      discounts: (o.appliedDiscounts || []).map((d: any) => ({
        name: d.name || "",
        total: d.total || 0,
      })),
    })),
    Math.max(0, totalRevenue - bdayRev),
  );
  if (bdayRev > 0 || bdayOrders > 0) {
    const walkInIdx = breakdown.findIndex((e) => e.source === "Walk-in" || e.source === "Unattributed");
    const entry = {
      source: "Birthdays",
      orders: bdayOrders,
      revenue: Math.round(bdayRev * 100) / 100,
      discount: 0,
      variants: [],
    };
    if (walkInIdx >= 0) breakdown.splice(walkInIdx, 0, entry);
    else breakdown.push(entry);
  }
  return breakdown;
}

async function ensureSourceBreakdown(
  summary: PapayaDailySummary | null,
  terminal: string,
): Promise<PapayaDailySummary | null> {
  if (!summary) return summary;
  // task-111: force recompute when formulaVersion is stale so cached days
  // (pre-v12) pick up the Birthdays source bucket and bday-channel split.
  const stale = summary.formulaVersion !== PAPAYA_FORMULA_VERSION;
  if (!stale && summary.sourceBreakdown && summary.sourceBreakdown.length > 0) return summary;
  try {
    summary.sourceBreakdown = await computeSourceBreakdownFromRawOrders(
      summary.date,
      terminal,
      summary.totalRevenue,
    );
    summary.formulaVersion = PAPAYA_FORMULA_VERSION;
  } catch (e) {
    console.warn(`[Papaya] ensureSourceBreakdown failed for ${terminal}:${summary.date}`, e);
    summary.sourceBreakdown = summary.sourceBreakdown || [];
  }
  return summary;
}

// task-114: read the current Chalong branch BD allocation preference. The
// pref is no longer baked into cached summaries (v3+ always builds in
// "bday" form and emits `birthdayChannelSplit` metadata for the client),
// but the pref still drives the toggle's initial state.
export async function getPapayaBirthdayAllocationForTerminal(
  terminal: string,
): Promise<PapayaBirthdayAllocation> {
  // Both terminals belong to the Chalong branch; the toggle is branch-scoped.
  try {
    const { getChalongBirthdayAllocation } = await import("./funtopia");
    return await getChalongBirthdayAllocation();
  } catch {
    return "bday";
  }
}

// task-114 v3: rebuild cached summaries whose stored formula version is
// stale so they pick up the new `birthdayChannelSplit` metadata shape.
// Manual birthday overrides for the date are re-applied after the rebuild
// so override-only days keep their corrected totals.
async function ensurePapayaFormulaVersion(
  summary: PapayaDailySummary | null,
  terminal: string,
): Promise<PapayaDailySummary | null> {
  if (!summary) return summary;
  if (summary.formulaVersion === PAPAYA_FORMULA_VERSION) return summary;
  try {
    const orders = await loadRawOrdersForDate(summary.date, terminal);
    if (orders.length === 0 && !summary.birthdayOverride) {
      // No raw orders to rebuild from; just restamp so we don't loop.
      summary.formulaVersion = PAPAYA_FORMULA_VERSION;
      await setCachedPapayaSummary(summary.date, summary, terminal);
      return summary;
    }
    const rebuilt = buildPapayaSummary(summary.date, orders, terminal);
    applyPapayaBirthdayOverride(
      rebuilt,
      await loadPapayaBirthdayOverride(summary.date, terminal),
    );
    await setCachedPapayaSummary(summary.date, rebuilt, terminal);
    return rebuilt;
  } catch (e) {
    console.warn(
      `[Papaya] ensurePapayaFormulaVersion failed for ${terminal}:${summary.date}`,
      e,
    );
    return summary;
  }
}

export async function getPapayaDailySummary(
  date: string,
  terminal: string = "reception"
): Promise<PapayaDailySummary | null> {
  const cached = await getCachedPapayaSummary(date, terminal);
  const aligned = await ensurePapayaFormulaVersion(cached, terminal);
  return await ensureSourceBreakdown(aligned, terminal);
}

export async function syncPapayaToday(terminal: string = "reception"): Promise<PapayaDailySummary | null> {
  const token = terminal === "reception" ? PAPAYA_RECEPTION_TOKEN : PAPAYA_RESTAURANT_TOKEN;
  if (!token) return null;

  const nowTH = new Date(Date.now() + 7 * 3600 * 1000);
  const todayStr = nowTH.toISOString().split("T")[0];

  try {
    const from = `${todayStr}T00:00:00+07:00`;
    const to = `${todayStr}T23:59:59+07:00`;
    const orders = await fetchPapayaOrders(token, from, to);
    await storeRawPapayaOrders(orders, terminal);
    const storedOrders = await loadRawOrdersForDate(todayStr, terminal);
    const summary = buildPapayaSummary(todayStr, storedOrders.length > 0 ? storedOrders : orders, terminal);
    applyPapayaBirthdayOverride(summary, await loadPapayaBirthdayOverride(todayStr, terminal));

    const warnings: string[] = [];
    let syncStatus: "clean" | "partial" | "skipped" = "clean";
    const completedOrders = orders.filter((o: any) => o.status === "complete");
    if (orders.length > 0 && summary.totalOrders === 0) {
      syncStatus = "partial";
      warnings.push(`Fetched ${orders.length} orders but 0 completed`);
    } else if (orders.length > 0 && summary.totalOrders < completedOrders.length * 0.97) {
      syncStatus = "partial";
      warnings.push(`Expected ~${completedOrders.length} completed orders, got ${summary.totalOrders} in summary`);
    }

    const existingCached = await getCachedPapayaSummary(todayStr, terminal);
    if (existingCached && existingCached.totalOrders > 0 && summary.totalOrders < existingCached.totalOrders * 0.97) {
      warnings.push(`Drop protection bypassed for today (${summary.totalOrders} vs ${existingCached.totalOrders} existing)`);
    }

    if (summary.totalOrders > 0) {
      await setCachedPapayaSummary(todayStr, summary, terminal);
    }

    await recordPapayaSyncHealth({
      date: todayStr,
      terminal,
      status: syncStatus,
      ordersExpected: completedOrders.length,
      ordersReceived: summary.totalOrders,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
    return summary;
  } catch (e: any) {
    console.error(`[Papaya] syncPapayaToday failed for ${terminal}:`, e);
    await recordPapayaSyncHealth({
      date: todayStr,
      terminal,
      status: "failed",
      errorMessage: e.message || "syncPapayaToday failed",
    }).catch(() => {});
    return null;
  }
}

export async function getPapayaDateRangeSummary(
  startDate: string,
  endDate: string,
  terminal: string = "reception"
): Promise<PapayaDailySummary[]> {
  await initPapayaCache();
  const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().split("T")[0];

  const result = await pool.query(
    "SELECT date, summary_json FROM papaya_daily_cache WHERE date >= $1 AND date <= $2 ORDER BY date ASC",
    [`${terminal}:${startDate}`, `${terminal}:${endDate}`]
  );
  const rawSummaries: PapayaDailySummary[] = result.rows
    .map((r: any) => r.summary_json as PapayaDailySummary)
    .filter((s: PapayaDailySummary) => s.totalOrders > 0);

  // task-114 v3: rebuild any cached days that pre-date the current formula
  // version so they pick up the `birthdayChannelSplit` metadata shape.
  const aligned = await Promise.all(
    rawSummaries.map((s) => ensurePapayaFormulaVersion(s, terminal)),
  );
  const summaries: PapayaDailySummary[] = aligned.filter(
    (s): s is PapayaDailySummary => s != null && s.totalOrders > 0,
  );

  if (startDate <= todayStr && endDate >= todayStr) {
    const todaySummary = await getPapayaDailySummary(todayStr, terminal);
    if (todaySummary && todaySummary.totalOrders > 0) {
      const hasToday = summaries.some(s => s.date === todayStr);
      if (!hasToday) summaries.push(todaySummary);
    }
  }

  await Promise.all(summaries.map((s) => ensureSourceBreakdown(s, terminal)));
  return summaries;
}

export async function syncPapayaDateRange(
  startDate: string,
  endDate: string,
  terminal: string = "reception",
  onProgress?: (msg: string) => void,
  syncMode: "quick" | "full" = "full"
): Promise<{ synced: number; dates: string[] }> {
  const token = terminal === "reception" ? PAPAYA_RECEPTION_TOKEN : PAPAYA_RESTAURANT_TOKEN;
  if (!token) throw new Error(`No token configured for Papaya ${terminal}`);

  const dates: string[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split("T")[0]);
  }

  let synced = 0;
  for (const date of dates) {
    try {
      const from = `${date}T00:00:00+07:00`;
      const to = `${date}T23:59:59+07:00`;
      const orders = await fetchPapayaOrders(token, from, to);
      await storeRawPapayaOrders(orders, terminal);
      const storedOrders = await loadRawOrdersForDate(date, terminal);
      const summary = buildPapayaSummary(date, storedOrders.length > 0 ? storedOrders : orders, terminal);
      applyPapayaBirthdayOverride(summary, await loadPapayaBirthdayOverride(date, terminal));

      const dayWarnings: string[] = [];
      let dayStatus: "clean" | "partial" | "skipped" = "clean";
      const completedOrders = orders.filter((o: any) => o.status === "complete");

      if (orders.length > 0 && summary.totalOrders === 0) {
        dayStatus = "partial";
        dayWarnings.push(`Fetched ${orders.length} orders but 0 completed`);
      } else if (completedOrders.length > 0 && summary.totalOrders < completedOrders.length * 0.97) {
        dayStatus = "partial";
        dayWarnings.push(`Expected ~${completedOrders.length} orders but only ${summary.totalOrders} stored (${Math.round(summary.totalOrders / completedOrders.length * 100)}%)`);
      }

      const nowTH = new Date(Date.now() + 7 * 3600 * 1000);
      const todayStr = nowTH.toISOString().split("T")[0];
      const yesterdayTH = new Date(nowTH);
      yesterdayTH.setDate(yesterdayTH.getDate() - 1);
      const yesterdayStr = yesterdayTH.toISOString().split("T")[0];
      const isRecentDate = date === todayStr || date === yesterdayStr;

      const existingCached = await getCachedPapayaSummary(date, terminal);
      if (existingCached && existingCached.totalOrders > 0 && summary.totalOrders < existingCached.totalOrders * 0.97) {
        if (syncMode === "quick" && isRecentDate) {
          dayWarnings.push(`Drop protection bypassed for ${date} in quick mode (${summary.totalOrders} vs ${existingCached.totalOrders} existing)`);
        } else {
          dayStatus = "skipped";
          dayWarnings.push(`New data has ${summary.totalOrders} orders vs ${existingCached.totalOrders} existing (>${Math.round((1 - summary.totalOrders / existingCached.totalOrders) * 100)}% drop)`);
        }
      }

      if (dayStatus !== "skipped") {
        await setCachedPapayaSummary(date, summary, terminal);
      }

      synced++;
      if (onProgress) onProgress(`${synced}/${dates.length}: ${date} → ${summary.totalOrders} orders, ฿${summary.totalRevenue}${dayStatus !== "clean" ? ` [${dayStatus.toUpperCase()}]` : ""}`);

      await recordPapayaSyncHealth({
        date,
        terminal,
        status: dayStatus,
        ordersExpected: completedOrders.length,
        ordersReceived: summary.totalOrders,
        warnings: dayWarnings.length > 0 ? dayWarnings : undefined,
      });
      await new Promise((r) => setTimeout(r, 300));
    } catch (e: any) {
      console.error(`[Papaya] Sync failed for ${date}:`, e);
      if (onProgress) onProgress(`${synced}/${dates.length}: ${date} → FAILED`);
      await recordPapayaSyncHealth({
        date,
        terminal,
        status: "failed",
        errorMessage: e.message || "Sync failed",
      }).catch(() => {});
    }
  }

  return { synced, dates };
}

export async function resyncPapayaDate(date: string): Promise<{ summary: PapayaDailySummary | null; syncHealth: PapayaSyncHealthRecord }> {
  await clearPapayaCacheForDate(date);

  const terminals = getPapayaTerminals();
  const activeTerminals = terminals.length > 0 ? terminals : ["reception"];
  let combinedSummary: PapayaDailySummary | null = null;
  const terminalResults: Record<string, { expected: number; received: number; error?: string; warning?: string }> = {};

  for (const terminal of activeTerminals) {
    const token = terminal === "reception" ? PAPAYA_RECEPTION_TOKEN : PAPAYA_RESTAURANT_TOKEN;
    if (!token) continue;

    try {
      const from = `${date}T00:00:00+07:00`;
      const to = `${date}T23:59:59+07:00`;

      await pool.query(
        `DELETE FROM papaya_orders WHERE terminal = $1 AND order_date >= $2 AND order_date <= $3`,
        [terminal, from, to]
      );

      const orders = await fetchPapayaOrders(token, from, to);
      await storeRawPapayaOrders(orders, terminal);
      const storedOrders = await loadRawOrdersForDate(date, terminal);
      const summary = buildPapayaSummary(date, storedOrders.length > 0 ? storedOrders : orders, terminal);
      applyPapayaBirthdayOverride(summary, await loadPapayaBirthdayOverride(date, terminal));
      await setCachedPapayaSummary(date, summary, terminal);

      const completedOrders = orders.filter((o: any) => o.status === "complete");
      terminalResults[terminal] = { expected: completedOrders.length, received: summary.totalOrders };

      if (orders.length > 0 && summary.totalOrders === 0) {
        terminalResults[terminal].warning = `Fetched ${orders.length} orders but 0 completed`;
      }

      if (!combinedSummary) {
        combinedSummary = summary;
      } else if (summary.totalOrders > 0) {
        combinedSummary = mergePapayaSummaries(combinedSummary, summary);
      }
    } catch (e: any) {
      console.error(`[Papaya] resyncPapayaDate failed for ${terminal}:${date}:`, e);
      terminalResults[terminal] = { expected: 0, received: 0, error: e.message || "Re-sync failed" };
    }
  }

  await pool.query(`DELETE FROM papaya_sync_health WHERE date = $1`, [date]);

  if (Object.keys(terminalResults).length === 0) {
    await recordPapayaSyncHealth({
      date,
      terminal: "combined",
      status: "failed",
      errorMessage: "No terminal tokens configured",
    });
  } else {
    for (const terminal of activeTerminals) {
      const result = terminalResults[terminal];
      if (!result) continue;

      let termStatus: "clean" | "partial" | "failed" = "clean";
      if (result.error) {
        termStatus = "failed";
      } else if (result.expected > 0 && result.received < result.expected * 0.97) {
        termStatus = "partial";
      } else if (result.warning) {
        termStatus = "partial";
      }

      await recordPapayaSyncHealth({
        date,
        terminal,
        status: termStatus,
        ordersExpected: result.expected,
        ordersReceived: result.received,
        errorMessage: result.error,
        warnings: result.warning ? [result.warning] : undefined,
      });
    }
  }

  const healthRecords = await getPapayaSyncHealth([date]);
  return { summary: combinedSummary, syncHealth: healthRecords[0] };
}

export function mergePapayaSummaries(a: PapayaDailySummary, b: PapayaDailySummary): PapayaDailySummary {
  const totalOrders = a.totalOrders + b.totalOrders;
  const totalRevenue = a.totalRevenue + b.totalRevenue;
  const paymentBreakdown: Record<string, number> = { ...a.paymentBreakdown };
  for (const [k, v] of Object.entries(b.paymentBreakdown)) {
    paymentBreakdown[k] = (paymentBreakdown[k] || 0) + v;
  }
  const categoryBreakdown: Record<string, any> = {};
  const allCats = new Set([...Object.keys(a.categoryBreakdown), ...Object.keys(b.categoryBreakdown)]);
  for (const cat of allCats) {
    const ac = a.categoryBreakdown[cat];
    const bc = b.categoryBreakdown[cat];
    if (ac && bc) {
      const itemsMap: Record<string, { name: string; category: string; revenue: number; quantity: number }> = {};
      for (const it of [...ac.items, ...bc.items]) {
        const key = it.name;
        if (itemsMap[key]) { itemsMap[key].revenue += it.revenue; itemsMap[key].quantity += it.quantity; }
        else itemsMap[key] = { ...it };
      }
      categoryBreakdown[cat] = {
        revenue: ac.revenue + bc.revenue,
        quantity: ac.quantity + bc.quantity,
        items: Object.values(itemsMap).sort((x, y) => y.revenue - x.revenue),
      };
    } else {
      categoryBreakdown[cat] = ac || bc;
    }
  }
  const topMap: Record<string, { name: string; category: string; quantity: number; revenue: number }> = {};
  for (const p of [...a.topProducts, ...b.topProducts]) {
    if (topMap[p.name]) { topMap[p.name].revenue += p.revenue; topMap[p.name].quantity += p.quantity; }
    else topMap[p.name] = { ...p };
  }
  const topProducts = Object.values(topMap).sort((x, y) => y.revenue - x.revenue).slice(0, 10);
  const hourlyMerge: Record<number, { hour: number; label: string; revenue: number; orders: number; ticketsSold: number; summerCamp: { revenue: number; orders: number; ticketsSold: number }; categories: Record<string, number>; customerTypes: Record<string, { kids: number; adults: number }> }> = {};
  for (const h of [...a.hourlyBreakdown, ...b.hourlyBreakdown]) {
    if (!hourlyMerge[h.hour]) {
      hourlyMerge[h.hour] = { hour: h.hour, label: (h as any).label || `${h.hour.toString().padStart(2, "0")}:00`, revenue: 0, orders: 0, ticketsSold: 0, summerCamp: { revenue: 0, orders: 0, ticketsSold: 0 }, categories: {}, customerTypes: {} };
    }
    hourlyMerge[h.hour].revenue += h.revenue;
    hourlyMerge[h.hour].orders += h.orders;
    hourlyMerge[h.hour].ticketsSold += (h as any).ticketsSold || 0;
    hourlyMerge[h.hour].summerCamp.revenue += (h as any).summerCamp?.revenue || 0;
    hourlyMerge[h.hour].summerCamp.orders += (h as any).summerCamp?.orders || 0;
    hourlyMerge[h.hour].summerCamp.ticketsSold += (h as any).summerCamp?.ticketsSold || 0;
  }
  const hourlyBreakdown = Object.values(hourlyMerge).sort((x, y) => x.hour - y.hour);
  const channelBreakdown: Record<string, number> = { ...a.channelBreakdown };
  for (const [k, v] of Object.entries(b.channelBreakdown)) {
    channelBreakdown[k] = (channelBreakdown[k] || 0) + v;
  }
  // task-114 v3: merge per-natural-category birthday-channel split metadata
  // so the client can still flip allocation views on the combined summary.
  const birthdayChannelSplit: Record<
    string,
    { revenue: number; quantity: number; items: Array<{ name: string; category: string; revenue: number; quantity: number }> }
  > = {};
  const allBcsCats = new Set([
    ...Object.keys(a.birthdayChannelSplit || {}),
    ...Object.keys(b.birthdayChannelSplit || {}),
  ]);
  for (const cat of allBcsCats) {
    const ac = a.birthdayChannelSplit?.[cat];
    const bc = b.birthdayChannelSplit?.[cat];
    if (ac && bc) {
      const itemsMap: Record<string, { name: string; category: string; revenue: number; quantity: number }> = {};
      for (const it of [...ac.items, ...bc.items]) {
        const key = it.name;
        if (itemsMap[key]) { itemsMap[key].revenue += it.revenue; itemsMap[key].quantity += it.quantity; }
        else itemsMap[key] = { ...it };
      }
      birthdayChannelSplit[cat] = {
        revenue: ac.revenue + bc.revenue,
        quantity: ac.quantity + bc.quantity,
        items: Object.values(itemsMap).sort((x, y) => y.revenue - x.revenue),
      };
    } else {
      birthdayChannelSplit[cat] = (ac || bc)!;
    }
  }
  return {
    date: a.date,
    totalRevenue,
    totalOrders,
    avgOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
    paymentBreakdown,
    topProducts,
    categoryBreakdown,
    birthdayChannelSplit,
    formulaVersion: PAPAYA_FORMULA_VERSION,
    hourlyBreakdown,
    guestBreakdown: a.guestBreakdown,
    discountTotal: a.discountTotal + b.discountTotal,
    channelBreakdown,
    discountBreakdown: (() => {
      const map = new Map<string, { name: string; count: number; total: number }>();
      for (const d of [...(a.discountBreakdown || []), ...(b.discountBreakdown || [])]) {
        const ex = map.get(d.name);
        if (ex) { ex.count += d.count; ex.total += d.total; }
        else map.set(d.name, { ...d });
      }
      return Array.from(map.values()).sort((a, b) => b.total - a.total);
    })(),
    sourceBreakdown: mergeSourceBreakdowns([
      a.sourceBreakdown || [],
      b.sourceBreakdown || [],
    ]),
  };
}

export async function getCombinedPapayaDailySummary(date: string): Promise<PapayaDailySummary | null> {
  const parkSummary = await getPapayaDailySummary(date, "reception");
  const cafeSummary = await getPapayaDailySummary(date, "restaurant");
  console.log(`[Papaya] Combined ${date}: park=${parkSummary?.totalOrders || 0} orders ฿${parkSummary?.totalRevenue || 0}, cafe=${cafeSummary?.totalOrders || 0} orders ฿${cafeSummary?.totalRevenue || 0}${!PAPAYA_RECEPTION_TOKEN ? " (no reception token)" : ""}`);

  if (parkSummary && cafeSummary && cafeSummary.totalOrders > 0) {
    return mergePapayaSummaries(parkSummary, cafeSummary);
  }

  return parkSummary || cafeSummary;
}

async function getLastKnownReceptionSummary(beforeDate: string): Promise<PapayaDailySummary | null> {
  await initPapayaCache();
  const result = await pool.query(
    "SELECT summary_json FROM papaya_daily_cache WHERE date < $1 AND date LIKE 'reception:%' AND (summary_json->>'totalOrders')::int > 0 ORDER BY date DESC LIMIT 1",
    [`reception:${beforeDate}`]
  );
  if (result.rows.length > 0) {
    return result.rows[0].summary_json as PapayaDailySummary;
  }
  return null;
}

// task-134: Events tab. Returns a flat list of Chalong birthday events
// for [startDate, endDate]. A "Chalong event" is any non-cancelled
// papaya_orders row whose channelName matches /birthday/i — Papaya doesn't
// produce a separate party↔F&B linking proposal (orders already contain
// both the package and the F&B lines), so we expose the same orders as
// events. Items use an Events-specific refinement of the existing
// getCategoryForItem heuristic so entertainment upgrades do not become
// packages. Read-only — never triggers a sync.
export interface PapayaEventRow {
  date: string;
  branch: "chalong";
  partyOrderId: string;
  partyOrderCode: string;
  packageName: string;
  packageRevenue: number;
  fnbRevenue: number;
  totalRevenue: number;
  /** Revenue for non-package/non-F&B lines (including entertainment). */
  otherRevenue: number;
  /**
   * Amount which could not be attributed to an item because the active item
   * totals did not reconcile to the Papaya bill.  It is included in
   * otherRevenue so the three displayed buckets always add to totalRevenue.
   */
  reconciliationRevenue?: number;
  entertainmentItems: Array<{ name: string; qty: number; revenue: number }>;
  terminal: string;
}

export interface PapayaBirthdayPackageOverride {
  date: string;
  terminal: string;
  partyTotal: number;
}

export function calculateChalongBirthdayPackageRevenue(
  events: Array<Pick<PapayaEventRow, "date" | "terminal" | "packageRevenue">>,
  overrides: PapayaBirthdayPackageOverride[],
): number {
  const overrideKeys = new Set(
    overrides.map((override) => `${override.date}::${override.terminal}`),
  );
  const overrideTotal = overrides.reduce(
    (sum, override) => sum + (Number(override.partyTotal) || 0),
    0,
  );
  const nonOverriddenEventTotal = events.reduce((sum, event) => {
    const key = `${event.date}::${event.terminal}`;
    return overrideKeys.has(key)
      ? sum
      : sum + (Number(event.packageRevenue) || 0);
  }, 0);
  return Math.round((overrideTotal + nonOverriddenEventTotal) * 100) / 100;
}

type ChalongEventItemKind = "package" | "fnb" | "other";

interface ChalongEventLine {
  name: string;
  qty: number;
  kind: ChalongEventItemKind;
  rawCents: number;
  index: number;
}

interface ChalongEventOrderMetadata {
  id: string;
  terminal: string;
  orderDate: string | Date;
  orderNumber?: string | null;
  receiptNumber?: string | null;
}

function papayaMoneyToCents(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
}

function papayaCentsToMoney(value: number): number {
  return value / 100;
}

function isCancelledPapayaItem(item: any): boolean {
  const status = String(item?.status || "").toLowerCase();
  return status === "cancelled" || status === "canceled" || status === "voided" || status === "void";
}

/**
 * A few entertainment SKUs contain words such as "upgrade" or "game" that
 * the general Papaya classifier intentionally maps to Tickets & Packages.
 * Events needs a narrower classifier: an active Bubble Show upgrade is an
 * entertainment add-on, not another birthday package.
 */
function isChalongEntertainmentName(name: string): boolean {
  return /\b(show|game|games|pinata|piñata|pinyata|photo\s*zone|photozone|workshop|face\s*paint|facepainting)\b/i.test(name);
}

function isExplicitChalongPackageName(name: string): boolean {
  return /\b(birthday|bday|party)\b/i.test(name);
}

function classifyChalongEventItem(item: any, terminal: string): ChalongEventItemKind {
  const name = String(item?.name || "Unknown");
  const generalCategory = getCategoryForItem(item);

  // A named birthday/party package is always a package, even when its SKU
  // also contains a word used by the entertainment classifier.
  if (isExplicitChalongPackageName(name) && /\b(package|pkg)\b/i.test(name)) {
    return "package";
  }
  if (isChalongEntertainmentName(name)) return "other";
  if (generalCategory === "Tickets & Packages") {
    return "package";
  }
  if (terminal === "restaurant" && getCafeCategory(item) === "F&B") {
    return "fnb";
  }
  if (generalCategory === "Events / Birthdays") return "package";
  return "other";
}

/**
 * Build one Chalong Events row without touching the database.  Keeping the
 * accounting here pure makes the cent allocation and status handling easy to
 * regression-test independently from the cache query.
 */
export function buildChalongEventRow(
  order: any,
  metadata: ChalongEventOrderMetadata,
): PapayaEventRow | null {
  if (!order || String(order.status || "").toLowerCase() !== "complete") return null;

  const totalCents = papayaMoneyToCents(order.total != null ? order.total : order.billTotal);
  const billCents = papayaMoneyToCents(order.billTotal);
  const lines: ChalongEventLine[] = [];
  for (const [index, item] of (Array.isArray(order.items) ? order.items : []).entries()) {
    if (!item || isCancelledPapayaItem(item)) continue;
    lines.push({
      name: String(item.name || "Unknown"),
      qty: Number(item.quantity) || 1,
      kind: classifyChalongEventItem(item, metadata.terminal),
      rawCents: papayaMoneyToCents(item.itemTotal),
      index,
    });
  }

  const itemSubtotalCents = lines.reduce((sum, line) => sum + line.rawCents, 0);
  const lineRevenueCents = new Map<number, number>();
  let reconciliationCents = 0;

  if (billCents > 0 && itemSubtotalCents === billCents) {
    // Largest-remainder allocation is deterministic (the original item index
    // breaks ties) and avoids floating-point drift at the one-cent boundary.
    const exactRemainders = lines.map((line) => {
      const numerator = line.rawCents * totalCents;
      const floor = Math.floor(numerator / billCents);
      return { index: line.index, floor, remainder: numerator - floor * billCents };
    });
    let allocatedCents = exactRemainders.reduce((sum, line) => sum + line.floor, 0);
    const residualCents = totalCents - allocatedCents;
    exactRemainders
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
      .slice(0, Math.max(0, residualCents))
      .forEach((line) => {
        line.floor += 1;
        allocatedCents += 1;
      });
    for (const line of exactRemainders) lineRevenueCents.set(line.index, line.floor);
  } else {
    // Do not hide a broken/missing bill reconciliation by discounting each
    // line as if the missing amount belonged to it.  Preserve the known line
    // values and expose the unknown remainder explicitly.
    for (const line of lines) lineRevenueCents.set(line.index, line.rawCents);
    reconciliationCents = totalCents - itemSubtotalCents;
  }

  let packageCents = 0;
  let fnbCents = 0;
  let otherCents = reconciliationCents;
  const entertainmentMap = new Map<string, { name: string; qty: number; cents: number }>();
  let packageName = "";
  let packageNameCents = -1;
  for (const line of lines) {
    const revenueCents = lineRevenueCents.get(line.index) || 0;
    if (line.kind === "package") {
      packageCents += revenueCents;
      if (isExplicitChalongPackageName(line.name) && revenueCents > packageNameCents) {
        packageName = line.name;
        packageNameCents = revenueCents;
      }
    } else if (line.kind === "fnb") {
      fnbCents += revenueCents;
    } else {
      otherCents += revenueCents;
      const existing = entertainmentMap.get(line.name);
      if (existing) {
        existing.qty += line.qty;
        existing.cents += revenueCents;
      } else {
        entertainmentMap.set(line.name, { name: line.name, qty: line.qty, cents: revenueCents });
      }
    }
  }
  if (!packageName) packageName = "Birthday party";

  const orderDate = metadata.orderDate instanceof Date ? metadata.orderDate : new Date(metadata.orderDate);
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Bangkok" }).format(orderDate);
  const packageRevenue = papayaCentsToMoney(packageCents);
  const fnbRevenue = papayaCentsToMoney(fnbCents);
  const otherRevenue = papayaCentsToMoney(otherCents);
  const result: PapayaEventRow = {
    date,
    branch: "chalong",
    // Papaya order ids are not globally unique across reception/restaurant.
    partyOrderId: `${metadata.terminal}:${metadata.id}`,
    partyOrderCode: metadata.orderNumber || metadata.receiptNumber || metadata.id,
    packageName,
    packageRevenue,
    fnbRevenue,
    totalRevenue: papayaCentsToMoney(totalCents),
    otherRevenue,
    entertainmentItems: Array.from(entertainmentMap.values())
      .map((item) => ({ name: item.name, qty: item.qty, revenue: papayaCentsToMoney(item.cents) }))
      .sort((a, b) => b.revenue - a.revenue),
    terminal: metadata.terminal,
  };
  if (reconciliationCents !== 0) result.reconciliationRevenue = papayaCentsToMoney(reconciliationCents);
  return result;
}

export async function getChalongBirthdayPackageRevenue(
  startDate: string,
  endDate: string,
): Promise<number> {
  await initPapayaCache();
  const [events, overrideResult] = await Promise.all([
    getChalongEventsRange(startDate, endDate),
    pool.query(
      `SELECT order_date, terminal, party_total
         FROM papaya_birthday_overrides
        WHERE order_date >= $1::date AND order_date <= $2::date`,
      [startDate, endDate],
    ),
  ]);
  const overrides: PapayaBirthdayPackageOverride[] = overrideResult.rows.map(
    (row: any) => ({
      date:
        row.order_date instanceof Date
          ? row.order_date.toISOString().slice(0, 10)
          : String(row.order_date).slice(0, 10),
      terminal: String(row.terminal),
      partyTotal: parseFloat(row.party_total) || 0,
    }),
  );
  return calculateChalongBirthdayPackageRevenue(events, overrides);
}

export async function getChalongEventsRange(
  startDate: string,
  endDate: string,
): Promise<PapayaEventRow[]> {
  await initPapayaCache();
  const fromTs = `${startDate}T00:00:00+07:00`;
  const toTs = `${endDate}T23:59:59+07:00`;
  const res = await pool.query(
    `SELECT id, terminal, order_date, channel_name, order_number, receipt_number, raw_json
       FROM papaya_orders
      WHERE order_date >= $1 AND order_date <= $2
        AND LOWER(COALESCE(channel_name,'')) LIKE '%birthday%'
      ORDER BY order_date ASC`,
    [fromTs, toTs],
  );
  const out: PapayaEventRow[] = [];
  for (const row of res.rows) {
    const order = row.raw_json as any;
    const event = buildChalongEventRow(order, {
      id: String(row.id),
      terminal: String(row.terminal),
      orderDate: row.order_date,
      orderNumber: row.order_number,
      receiptNumber: row.receipt_number,
    });
    if (event) out.push(event);
  }
  return out;
}

export async function getCombinedPapayaDateRangeSummary(
  startDate: string,
  endDate: string
): Promise<PapayaDailySummary[]> {
  const parkSummaries = await getPapayaDateRangeSummary(startDate, endDate, "reception");
  const cafeSummaries = await getPapayaDateRangeSummary(startDate, endDate, "restaurant");
  if (cafeSummaries.length === 0) return parkSummaries;
  if (parkSummaries.length === 0) return cafeSummaries;
  const cafeByDate = new Map(cafeSummaries.map(s => [s.date, s]));
  const merged: PapayaDailySummary[] = [];
  const seenDates = new Set<string>();
  for (const ps of parkSummaries) {
    const cs = cafeByDate.get(ps.date);
    merged.push(cs ? mergePapayaSummaries(ps, cs) : ps);
    seenDates.add(ps.date);
  }
  for (const cs of cafeSummaries) {
    if (!seenDates.has(cs.date)) merged.push(cs);
  }
  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

export async function getAllPapayaDailySummaries(): Promise<Array<{ date: string; summary: any }>> {
  await initPapayaCache();
  const result = await pool.query(
    "SELECT date, summary_json FROM papaya_daily_cache ORDER BY date ASC"
  );
  const byDate = new Map<string, PapayaDailySummary[]>();
  for (const r of result.rows) {
    const dateKey = r.date as string;
    const actualDate = dateKey.includes(":") ? dateKey.split(":").slice(1).join(":") : dateKey;
    const summary = r.summary_json as PapayaDailySummary;
    if (!byDate.has(actualDate)) byDate.set(actualDate, []);
    byDate.get(actualDate)!.push(summary);
  }
  const merged: Array<{ date: string; summary: any }> = [];
  for (const [date, summaries] of byDate) {
    if (summaries.length === 1) {
      merged.push({ date, summary: summaries[0] });
    } else {
      let combined = summaries[0];
      for (let i = 1; i < summaries.length; i++) {
        if (summaries[i].totalOrders > 0) {
          combined = mergePapayaSummaries(combined, summaries[i]);
        }
      }
      merged.push({ date, summary: combined });
    }
  }
  return merged.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Look up the orders that used a specific discount, served from the cached
 * `papaya_orders` table (covers both reception and restaurant terminals and
 * supports either a single date or a from/to range). Returned shape matches
 * the `DiscountOrder` interface used by the dashboard.
 */
export async function getPapayaOrdersByDiscount(
  dateOrFrom: string,
  discountName: string,
  toDate?: string
): Promise<{ orders: any[] }> {
  await initPapayaCache();
  const from = `${dateOrFrom}T00:00:00+07:00`;
  const to = `${toDate || dateOrFrom}T23:59:59+07:00`;

  const res = await pool.query(
    `SELECT id, terminal, raw_json
       FROM papaya_orders
      WHERE order_date >= $1 AND order_date <= $2`,
    [from, to]
  );

  const orders: any[] = [];
  for (const row of res.rows) {
    const order = row.raw_json as any;
    if (!order) continue;
    if (order.status !== "complete") continue;

    const applied: any[] = order.appliedDiscounts || [];
    const matching = applied.filter(
      (d: any) => (d?.name || "Unknown Discount") === discountName,
    );
    if (matching.length === 0) continue;

    const revenue = order.total != null ? (order.total as number) : (order.billTotal || 0);
    const items = (order.items || []).map((it: any) => ({
      name: it.name || "Unknown",
      quantity: it.quantity || 1,
      price: it.itemTotal || 0,
    }));
    const payments = (order.payments || [])
      .filter((p: any) => p && p.status !== "cancelled")
      .map((p: any) => ({
        method: normalizePapayaPaymentMethod(p),
        amount: p.amount || 0,
      }));

    const discountItems = matching.map((d: any) => ({
      name: d.name || "Unknown Discount",
      total: d.total || 0,
    }));

    orders.push({
      orderId: row.id,
      orderNumber: order.orderNumber || order.receiptNumber || "",
      time: order.orderDate || order.createdAt || order.completedAt || "",
      channel: order.channelName || "Unknown",
      terminal: row.terminal,
      billTotal: order.billTotal || 0,
      discountTotal: order.discountTotal || 0,
      revenue,
      items,
      payments,
      discountItems,
    });
  }

  orders.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  return { orders };
}

export async function fetchPapayaOrdersByDiscount(
  date: string,
  discountName: string
): Promise<any[]> {
  const from = `${date}T00:00:00+07:00`;
  const to = `${date}T23:59:59+07:00`;
  const results: any[] = [];

  for (const terminal of ["reception", "restaurant"] as const) {
    const token = terminal === "reception" ? PAPAYA_RECEPTION_TOKEN : PAPAYA_RESTAURANT_TOKEN;
    if (!token) continue;
    const orders = await fetchPapayaOrders(token, from, to);
    const completed = orders.filter((o) => o.status === "complete");
    for (const order of completed) {
      const discounts = order.appliedDiscounts || [];
      const hasDiscount = discounts.some((d: any) => (d.name || "Unknown Discount") === discountName);
      if (!hasDiscount) continue;

      const revenue = order.total != null ? (order.total as number) : (order.billTotal || 0);

      const items = (order.items || []).map((it: any) => ({
        name: it.name || "Unknown",
        quantity: it.quantity || 1,
        price: it.itemTotal || 0,
      }));

      const payments = (order.payments || [])
        .filter((p: any) => p.paid || p.status === "succeeded")
        .map((p: any) => ({
          method: normalizePapayaPaymentMethod(p),
          amount: p.amount || 0,
        }));

      const orderTime = order.createdAt || order.completedAt || "";
      const discountItems = discounts
        .filter((d: any) => (d.name || "Unknown Discount") === discountName)
        .map((d: any) => ({ name: d.name || "Unknown Discount", total: d.total || 0 }));

      results.push({
        orderId: order.id || order.orderId || "unknown",
        orderNumber: order.orderNumber || order.receiptNumber || "",
        time: orderTime,
        channel: order.channelName || "Unknown",
        terminal,
        billTotal: order.billTotal || 0,
        discountTotal: order.discountTotal || 0,
        revenue,
        items,
        payments,
        discountItems,
      });
    }
  }

  return results.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
}

export function isPapayaConfigured(): boolean {
  return !!(PAPAYA_RECEPTION_TOKEN || PAPAYA_RESTAURANT_TOKEN);
}

export function getPapayaTerminals(): string[] {
  const terminals: string[] = [];
  if (PAPAYA_RECEPTION_TOKEN) terminals.push("reception");
  if (PAPAYA_RESTAURANT_TOKEN) terminals.push("restaurant");
  return terminals;
}

export async function setPapayaSyncMeta(mode: "quick" | "full"): Promise<void> {
  await initPapayaCache();
  let existing: any = {};
  try {
    const metaResult = await pool.query(
      "SELECT summary_json FROM papaya_daily_cache WHERE date = '__meta__'"
    );
    if (metaResult.rows.length > 0) {
      existing = metaResult.rows[0].summary_json || {};
    }
  } catch {}

  const now = new Date().toISOString();
  if (mode === "full") existing.lastFullSyncAt = now;
  if (mode === "quick") existing.lastQuickSyncAt = now;

  await pool.query(
    `INSERT INTO papaya_daily_cache (date, terminal, synced_at, summary_json)
     VALUES ('__meta__', 'meta', NOW(), $1)
     ON CONFLICT (date) DO UPDATE SET synced_at = NOW(), summary_json = $1`,
    [JSON.stringify(existing)]
  );
}

export async function getPapayaSyncStatus(): Promise<{
  cachedDays: number;
  totalOrders: number;
  earliestDate: string | null;
  latestDate: string | null;
  lastSyncedAt: string | null;
  lastFullSyncAt: string | null;
  lastQuickSyncAt: string | null;
  receptionConnected: boolean;
  restaurantConnected: boolean;
}> {
  await initPapayaCache();
  const countRes = await pool.query("SELECT COUNT(DISTINCT SUBSTRING(date FROM POSITION(':' IN date) + 1)) as cnt FROM papaya_daily_cache WHERE date != '__meta__'");
  const cachedDays = parseInt(countRes.rows[0]?.cnt || "0");

  const ordersRes = await pool.query("SELECT COALESCE(SUM((summary_json->>'totalOrders')::int), 0) as total FROM papaya_daily_cache WHERE date != '__meta__'");
  const totalOrders = parseInt(ordersRes.rows[0]?.total || "0");

  const rangeRes = await pool.query("SELECT MIN(SUBSTRING(date FROM POSITION(':' IN date) + 1)) as earliest, MAX(SUBSTRING(date FROM POSITION(':' IN date) + 1)) as latest, MAX(synced_at) as last_synced FROM papaya_daily_cache WHERE date != '__meta__'");
  const row = rangeRes.rows[0];

  let lastFullSyncAt: string | null = null;
  let lastQuickSyncAt: string | null = null;
  try {
    const metaResult = await pool.query(
      "SELECT summary_json FROM papaya_daily_cache WHERE date = '__meta__'"
    );
    if (metaResult.rows.length > 0) {
      const meta = metaResult.rows[0].summary_json as any;
      lastFullSyncAt = meta?.lastFullSyncAt || null;
      lastQuickSyncAt = meta?.lastQuickSyncAt || null;
    }
  } catch {}

  return {
    cachedDays,
    totalOrders,
    earliestDate: row?.earliest || null,
    latestDate: row?.latest || null,
    lastSyncedAt: row?.last_synced ? new Date(row.last_synced).toISOString() : null,
    lastFullSyncAt,
    lastQuickSyncAt,
    receptionConnected: !!PAPAYA_RECEPTION_TOKEN,
    restaurantConnected: !!PAPAYA_RESTAURANT_TOKEN,
  };
}

// =====================================================================
// Tax Invoice (ABB) generation — settings + invoice data assembly.
// =====================================================================

export interface PapayaInvoiceSettings {
  header: {
    companyName: string;
    addressLines: string[];
    tel: string;
    taxId: string;
    legalEntity: string;
  };
  posTaxIds: { reception: string; restaurant: string };
}

export const DEFAULT_INVOICE_SETTINGS: PapayaInvoiceSettings = {
  header: {
    companyName: "OTO Cafe (T&T Concept Co.,Ltd _Branch 00001)",
    addressLines: [
      "Oto Play Park, 3rd floor, Robinson Chalong,",
      "Tambon Chalong, Phuket, Chang Wat Phuket 83130",
    ],
    tel: "+66615016666",
    legalEntity: "T&T Concept Co., Ltd.",
    taxId: "0835567020131",
  },
  posTaxIds: { reception: "", restaurant: "E118300002A9215" },
};

export async function getPapayaInvoiceSettings(): Promise<PapayaInvoiceSettings> {
  const { getBranchSetting } = await import("./funtopia");
  const stored = await getBranchSetting<Partial<PapayaInvoiceSettings>>("papaya_invoice", "settings");
  if (!stored) return DEFAULT_INVOICE_SETTINGS;
  return {
    header: { ...DEFAULT_INVOICE_SETTINGS.header, ...(stored.header || {}) },
    posTaxIds: { ...DEFAULT_INVOICE_SETTINGS.posTaxIds, ...(stored.posTaxIds || {}) },
  };
}

export async function setPapayaInvoiceSettings(s: PapayaInvoiceSettings): Promise<void> {
  const { setBranchSetting } = await import("./funtopia");
  await setBranchSetting("papaya_invoice", "settings", s);
}

export interface PapayaInvoiceData {
  id: string;
  terminal: string;
  receiptNumber: string;
  orderNumber: string;
  orderDate: string | null;
  channelName: string;
  channelType: string;
  customerName: string;
  posNo: string;
  items: Array<{ name: string; quantity: number; itemTotal: number }>;
  itemSubtotal: number;
  serviceCharge: number;
  totalBeforeTax: number;
  tax: number;
  total: number;
  billTotal: number;
  tipTotal: number;
  isTaxInclusive: boolean;
  payments: Array<{ method: string; amount: number }>;
}

function buildInvoiceFromRaw(id: string, terminal: string, o: any): PapayaInvoiceData {
  const items = (o.items || []).map((it: any) => ({
    name: it.name || "",
    quantity: it.quantity || 1,
    itemTotal: Number(it.itemTotal) || 0,
  }));
  const payments = (o.payments || [])
    .filter((p: any) => p && p.status !== "cancelled")
    .map((p: any) => ({
      method: normalizePapayaPaymentMethod(p),
      amount: Number(p.amount) || 0,
    }));
  const itemSubtotal = items.reduce((a: number, x: any) => a + x.itemTotal, 0);
  const customerName = (o.items || [])[0]?.customerName || "Ordered with Staff";
  const posNo = (o.posNo || o.posNumber || o.deviceName || "").toString();
  return {
    id,
    terminal,
    receiptNumber: o.receiptNumber || "",
    orderNumber: o.number || o.orderNumber || "",
    orderDate: o.orderDate || o.created || o.completedAt || null,
    channelName: o.channelName || "",
    channelType: o.channelType || "",
    customerName,
    posNo,
    items,
    itemSubtotal,
    serviceCharge: Number(o.serviceCharge) || 0,
    totalBeforeTax: o.totalBeforeTax != null ? Number(o.totalBeforeTax) : (Number(o.total) || 0) - (Number(o.tax) || 0),
    tax: Number(o.tax) || 0,
    total: Number(o.total ?? o.billTotal) || 0,
    billTotal: Number(o.billTotal) || 0,
    tipTotal: Number(o.tipTotal) || 0,
    isTaxInclusive: !!o.isTaxInclusive,
    payments,
  };
}

export async function getPapayaInvoices(
  from: string,
  to: string,
  terminal?: string
): Promise<PapayaInvoiceData[]> {
  await initPapayaCache();
  const fromTs = `${from}T00:00:00+07:00`;
  const toTs = `${to}T23:59:59+07:00`;
  const params: any[] = [fromTs, toTs];
  let sql = `SELECT id, terminal, raw_json FROM papaya_orders
             WHERE order_date >= $1 AND order_date <= $2`;
  if (terminal) {
    params.push(terminal);
    sql += ` AND terminal = $${params.length}`;
  }
  sql += ` ORDER BY order_date ASC`;
  const res = await pool.query(sql, params);
  const out: PapayaInvoiceData[] = [];
  for (const row of res.rows) {
    const o = row.raw_json as any;
    if (!o || o.status !== "complete") continue;
    out.push(buildInvoiceFromRaw(row.id, row.terminal, o));
  }
  return out;
}

export async function getPapayaInvoice(
  id: string,
  terminal: string
): Promise<PapayaInvoiceData | null> {
  await initPapayaCache();
  const res = await pool.query(
    `SELECT id, terminal, raw_json FROM papaya_orders WHERE id = $1 AND terminal = $2 LIMIT 1`,
    [id, terminal]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (!row.raw_json || row.raw_json.status !== "complete") return null;
  return buildInvoiceFromRaw(row.id, row.terminal, row.raw_json);
}

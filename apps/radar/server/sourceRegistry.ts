export interface SourceRegistryEntry {
  source: string;
  match: RegExp;
}

export const SOURCE_REGISTRY: SourceRegistryEntry[] = [
  // Sales Booth: matches the staff-facing names ("Sales-booth", "Sales Booth")
  // AND the customer-facing wallet-pass titles that Pisell ships when staff
  // edit the coupon name ("10% / 20% / 50% Discount (on kid ticket only)").
  // The customer-facing pattern is intentionally narrow so it can't catch
  // unrelated discounts — it requires "(on kid ticket only)" suffix.
  { source: "Sales Booth", match: /sales[\s_\-]*booth|\d+%\s*discount\s*\(on\s*kid\s*ticket\s*only\)/i },
  { source: "Tops Daily", match: /\btops\b/i },
  { source: "Department Store", match: /department\s*store|dept\s*store/i },
  { source: "Airport", match: /\bairport\b/i },
  { source: "School", match: /\bschool\b/i },
  { source: "Mascot", match: /\bmascot\b/i },
  // NOTE: order matters. Staff Rewards must come BEFORE Review Rewards so
  // titles like "Staff Rewards 1000" are not misclassified as Review Rewards.
  { source: "Staff Rewards", match: /\bstaff\b/i },
  { source: "Review Rewards", match: /\breview\b|\bgoogle\s*review\b/i },
  { source: "Free Coffee", match: /\bfree\s*coffee\b/i },
  { source: "Free Ice Cream", match: /\bfree\s*ice[\s\-]*cream\b/i },
  // Indian package vouchers (sold via OTAs / third-party partners at face values
  // ฿690 / ฿890 / ฿1090). Registered so isKnownChannel() recognises the channel
  // and discount names containing "indian" classify here.
  { source: "Indian Package", match: /\bindian\b/i },
];

// Sources whose voucher redemptions are F&B perks (not ticket promos). They
// still appear as their own bucket on the Ticket Revenue by Source card, but
// they only credit the ticket portion of the order they were redeemed against.
export const FNB_PERK_SOURCES = new Set<string>(["Free Coffee", "Free Ice Cream"]);

export const UNATTRIBUTED_SOURCE = "Walk-in";
export const LEGACY_UNATTRIBUTED_SOURCE = "Unattributed";
// task-111: Birthdays bucket on the Revenue by Source card. Carries the
// birthday-party PACKAGE revenue only (linked F&B never enters this
// bucket). Always rendered as its own row regardless of the BD→Bday /
// BD→Tix/F&B toggle, and ordered after marketing channels but before
// Walk-in (see mergeSourceBreakdowns).
export const BIRTHDAYS_SOURCE = "Birthdays";

export const VOUCHER_CODE_REGISTRY: Record<string, { source: string; label: string }> = {
  "8280f2ef653de7a1": { source: "Airport", label: "THB 250" },
  "8ef2c2dc2f671209": { source: "School", label: "THB 250" },
  "6a28e849b70a5ca0": { source: "Tops Daily", label: "10% OFF" },
  "7363624b9455c8ba": { source: "Tops Daily", label: "20% OFF" },
  // Each Sales-booth coupon in Pisell has TWO voucher codes (an issue/redeem
  // pair). The `9acdc0…/77c48e…/4ca2a3…` codes are the partner side that
  // wasn't in the original registry — they account for ~half of Sales Booth
  // redemptions and a stray 2026-01-23 redemption that pre-dates the May 1
  // ramp. Both halves now map to Sales Booth so neither side leaks to
  // Walk-in.
  "c7cdcdb8efa7fcc6": { source: "Sales Booth", label: "10% OFF" },
  "9acdc0a567f477e6": { source: "Sales Booth", label: "10% OFF" },
  "c1b3e9a1feec6d7f": { source: "Sales Booth", label: "20% OFF" },
  "77c48ea67d81dd61": { source: "Sales Booth", label: "20% OFF" },
  "b2d32eb7487a439f": { source: "Sales Booth", label: "50% OFF" },
  "4ca2a3dbb3f9763e": { source: "Sales Booth", label: "50% OFF" },
  "bf58b9f4a7575f15": { source: "Department Store", label: "10% OFF" },
  "f99cb761f6803202": { source: "Department Store", label: "20% OFF" },
  "7bb098a6e0f98041": { source: "Mascot", label: "THB 150" },
  "caa3496aa9317513": { source: "Mascot", label: "THB 150" },
  "6a6facd56246266e": { source: "Review Rewards", label: "THB 100" },
};

export function classifyByVoucherCode(code: string | null | undefined): { source: string; label: string } | null {
  if (!code) return null;
  return VOUCHER_CODE_REGISTRY[code.trim()] || null;
}

export function cleanVoucherVariantLabel(title: string): string {
  const t = title.trim();
  if (/^\d+% OFF$/i.test(t) || /^THB \d+$/i.test(t)) return t;
  const pctMatch = t.match(/^(\d+)%\s/);
  if (pctMatch) return `${pctMatch[1]}% OFF`;
  const amtMatch = t.match(/\((\d+)\)/);
  if (amtMatch) return `THB ${amtMatch[1]}`;
  const numMatch = t.match(/\b(\d{2,})\b/);
  if (numMatch) return `THB ${numMatch[1]}`;
  return t;
}

const KNOWN_SOURCES = new Set(SOURCE_REGISTRY.map((e) => e.source));

export function isKnownChannel(source: string): boolean {
  return KNOWN_SOURCES.has(source);
}

function titleCase(str: string): string {
  return str
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      if (/^\d+%$/.test(w)) return w;
      const lower = w.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

export function deriveSourceFromDiscountName(name: string): string {
  if (!name) return UNATTRIBUTED_SOURCE;
  let s = name.trim();
  s = s.replace(/^\d+\s*%\s*/, "");
  s = s.replace(/\s*\(\s*\d+(?:\.\d+)?\s*\)\s*$/, "");
  s = s.replace(/\s+\d+(?:\.\d+)?\s*%?\s*$/, "");
  s = s.replace(/^discount\s+/i, "");
  s = s.replace(/\s+discount\s*$/i, "");
  s = s.trim();
  if (!s) return UNATTRIBUTED_SOURCE;
  return titleCase(s);
}

/**
 * Classify a discount/voucher name. If it matches one of the known marketing
 * channels (SOURCE_REGISTRY), return that channel. Otherwise return a
 * normalized title (e.g. "Birthday Promo") so historical Chalong data with
 * arbitrary discount labels keeps working.
 */
export function classifyDiscountSource(name: string | null | undefined): string {
  if (!name || typeof name !== "string") return UNATTRIBUTED_SOURCE;
  const trimmed = name.trim();
  if (!trimmed) return UNATTRIBUTED_SOURCE;
  for (const entry of SOURCE_REGISTRY) {
    if (entry.match.test(trimmed)) return entry.source;
  }
  return deriveSourceFromDiscountName(trimmed);
}

/**
 * STRICT classifier used for Floresta voucher-title attribution: if the
 * voucher title doesn't match any of the configured marketing channels, the
 * order is treated as Walk-in. This avoids creating one bucket per arbitrary
 * voucher title (e.g. "350B FB Voucher", "Free Coffee Voucher" become Walk-in).
 */
export function classifyDiscountSourceStrict(name: string | null | undefined): string {
  if (!name || typeof name !== "string") return UNATTRIBUTED_SOURCE;
  const trimmed = name.trim();
  if (!trimmed) return UNATTRIBUTED_SOURCE;
  for (const entry of SOURCE_REGISTRY) {
    if (entry.match.test(trimmed)) return entry.source;
  }
  return UNATTRIBUTED_SOURCE;
}

export interface SourceVariantEntry {
  name: string;
  orders: number;
  revenue: number;
  discount: number;
}

export interface SourceBreakdownEntry {
  source: string;
  orders: number;
  revenue: number;
  discount: number;
  variants: SourceVariantEntry[];
}

export interface OrderDiscountInfo {
  name: string;
  total: number;
  preClassifiedSource?: string;
}

export interface OrderForSourceAttribution {
  revenue: number;
  discounts: OrderDiscountInfo[];
}

/**
 * Original (non-strict) breakdown used by Papaya/Chalong dashboards.
 *
 * Behavior: each order is attributed to the FIRST matched discount's source
 * ("primary source"). If multiple discounts on the same order map to different
 * sources, only the primary one is credited — the rest are ignored. This
 * preserves long-standing KPI semantics for those branches.
 *
 * Fallback: if a discount name doesn't match any known channel, the legacy
 * `classifyDiscountSource` derives a source from the discount name, so very
 * little ends up under UNATTRIBUTED_SOURCE.
 */
export function buildSourceBreakdown(
  orders: OrderForSourceAttribution[],
  totalRevenue: number,
): SourceBreakdownEntry[] {
  const sourceMap = new Map<
    string,
    { orders: number; revenue: number; discount: number; variants: Map<string, SourceVariantEntry> }
  >();

  let attributedRevenue = 0;
  let attributedOrders = 0;
  let multiSourceWarnings = 0;

  for (const order of orders) {
    const validDiscounts = (order.discounts || []).filter(
      (d) => d && typeof d.name === "string" && d.name.trim().length > 0,
    );
    if (validDiscounts.length === 0) continue;
    attributedOrders += 1;

    const sourcesForOrder = new Set<string>();
    for (const d of validDiscounts) {
      sourcesForOrder.add(classifyDiscountSource(d.name));
    }

    const firstDiscount = validDiscounts[0];
    const primarySource = classifyDiscountSource(firstDiscount.name);

    if (sourcesForOrder.size > 1) {
      multiSourceWarnings++;
    }

    let bucket = sourceMap.get(primarySource);
    if (!bucket) {
      bucket = { orders: 0, revenue: 0, discount: 0, variants: new Map() };
      sourceMap.set(primarySource, bucket);
    }

    bucket.orders += 1;
    bucket.revenue += order.revenue;
    attributedRevenue += order.revenue;

    const primaryDiscountCount = validDiscounts.filter(
      (x) => classifyDiscountSource(x.name) === primarySource,
    ).length;

    for (const d of validDiscounts) {
      const dSource = classifyDiscountSource(d.name);
      if (dSource !== primarySource) continue;
      bucket.discount += d.total || 0;

      const variantName = d.name.trim();
      const perVariantRev = order.revenue / Math.max(1, primaryDiscountCount);
      const existingVariant = bucket.variants.get(variantName);
      if (existingVariant) {
        existingVariant.orders += 1;
        existingVariant.revenue += perVariantRev;
        existingVariant.discount += d.total || 0;
      } else {
        bucket.variants.set(variantName, {
          name: variantName,
          orders: 1,
          revenue: perVariantRev,
          discount: d.total || 0,
        });
      }
    }
  }

  if (multiSourceWarnings > 0) {
    console.warn(
      `[SourceBreakdown] ${multiSourceWarnings} order(s) had discounts from multiple sources; counted under the first matched source only.`,
    );
  }

  const result: SourceBreakdownEntry[] = [];
  sourceMap.forEach((bucket, source) => {
    const variants: SourceVariantEntry[] = [];
    bucket.variants.forEach((v) => {
      variants.push({
        name: v.name,
        orders: v.orders,
        revenue: Math.round(v.revenue * 100) / 100,
        discount: Math.round(v.discount * 100) / 100,
      });
    });
    variants.sort((a, b) => b.revenue - a.revenue);
    result.push({
      source,
      orders: bucket.orders,
      revenue: Math.round(bucket.revenue * 100) / 100,
      discount: Math.round(bucket.discount * 100) / 100,
      variants,
    });
  });

  result.sort((a, b) => b.revenue - a.revenue);

  const unattributedRevenue = Math.max(0, Math.round((totalRevenue - attributedRevenue) * 100) / 100);
  const unattributedOrders = Math.max(0, orders.length - attributedOrders);
  if (unattributedRevenue > 0 || unattributedOrders > 0 || result.length === 0) {
    result.push({
      source: UNATTRIBUTED_SOURCE,
      orders: unattributedOrders,
      revenue: unattributedRevenue,
      discount: 0,
      variants: [],
    });
  }

  return result;
}

/**
 * Strict breakdown used by the Floresta dashboard's wallet-pass-driven
 * attribution.
 *
 * Behavior: only orders whose discount names match one of the 7 known
 * marketing channels (Airport / School / Mascot / Sales Booth / Tops Daily /
 * Department Store / Review Rewards) are attributed. If a single order
 * redeems vouchers from MULTIPLE channels, its revenue is split evenly across
 * the matched channels. Anything else is treated as Walk-in.
 *
 * This split-mode is intentional for Floresta because each order's discounts
 * are sourced from real Pisell wallet-pass titles, where a multi-voucher
 * redemption legitimately represents revenue earned from multiple campaigns.
 */
export function buildSourceBreakdownStrict(
  orders: OrderForSourceAttribution[],
  totalRevenue: number,
): SourceBreakdownEntry[] {
  const sourceMap = new Map<
    string,
    { orders: number; revenue: number; discount: number; variants: Map<string, SourceVariantEntry> }
  >();

  let attributedRevenue = 0;
  let attributedOrders = 0;

  for (const order of orders) {
    const validDiscounts = (order.discounts || []).filter(
      (d) => d && typeof d.name === "string" && d.name.trim().length > 0,
    );
    if (validDiscounts.length === 0) continue;

    const resolveSource = (d: OrderDiscountInfo): string =>
      d.preClassifiedSource || classifyDiscountSourceStrict(d.name);

    const channelDiscounts = validDiscounts.filter((d) => {
      return resolveSource(d) !== UNATTRIBUTED_SOURCE;
    });

    if (channelDiscounts.length === 0) continue;

    attributedOrders += 1;

    const channelsForOrder = Array.from(
      new Set(channelDiscounts.map((d) => resolveSource(d))),
    );

    const revenueShare = order.revenue / channelsForOrder.length;
    attributedRevenue += order.revenue;

    for (const channel of channelsForOrder) {
      let bucket = sourceMap.get(channel);
      if (!bucket) {
        bucket = { orders: 0, revenue: 0, discount: 0, variants: new Map() };
        sourceMap.set(channel, bucket);
      }
      // Orders are counted as whole units per channel an order touches, so a
      // single multi-channel order contributes 1 to each channel's count
      // (totals across channels can exceed the unique order count). Revenue
      // is still split evenly so the attributed total still ties out.
      bucket.orders += 1;
      bucket.revenue += revenueShare;

      const channelMatches = channelDiscounts.filter(
        (d) => resolveSource(d) === channel,
      );
      const perVariantRev = revenueShare / Math.max(1, channelMatches.length);
      const seenVariantsInOrder = new Set<string>();
      for (const d of channelMatches) {
        const variantName = d.name.trim();
        const isFirstForOrder = !seenVariantsInOrder.has(variantName);
        seenVariantsInOrder.add(variantName);
        bucket.discount += d.total || 0;
        const existing = bucket.variants.get(variantName);
        if (existing) {
          if (isFirstForOrder) existing.orders += 1;
          existing.revenue += perVariantRev;
          existing.discount += d.total || 0;
        } else {
          bucket.variants.set(variantName, {
            name: variantName,
            orders: 1,
            revenue: perVariantRev,
            discount: d.total || 0,
          });
        }
      }
    }
  }

  const result: SourceBreakdownEntry[] = [];
  sourceMap.forEach((bucket, source) => {
    const variants: SourceVariantEntry[] = [];
    bucket.variants.forEach((v) => {
      variants.push({
        name: v.name,
        orders: Math.round(v.orders),
        revenue: Math.round(v.revenue * 100) / 100,
        discount: Math.round(v.discount * 100) / 100,
      });
    });
    variants.sort((a, b) => b.revenue - a.revenue);
    result.push({
      source,
      orders: Math.round(bucket.orders),
      revenue: Math.round(bucket.revenue * 100) / 100,
      discount: Math.round(bucket.discount * 100) / 100,
      variants,
    });
  });

  result.sort((a, b) => b.revenue - a.revenue);

  const unattributedRevenue = Math.max(0, Math.round((totalRevenue - attributedRevenue) * 100) / 100);
  const unattributedOrders = Math.max(0, orders.length - attributedOrders);
  if (unattributedRevenue > 0 || unattributedOrders > 0 || result.length === 0) {
    result.push({
      source: UNATTRIBUTED_SOURCE,
      orders: unattributedOrders,
      revenue: unattributedRevenue,
      discount: 0,
      variants: [],
    });
  }

  return result;
}

export function mergeSourceBreakdowns(
  breakdowns: SourceBreakdownEntry[][],
): SourceBreakdownEntry[] {
  const sourceMap = new Map<
    string,
    { orders: number; revenue: number; discount: number; variants: Map<string, SourceVariantEntry> }
  >();

  for (const breakdown of breakdowns) {
    for (const entry of breakdown || []) {
      // Migrate any legacy "Unattributed" entries to the new "Walk-in" name
      const normalizedSource = entry.source === LEGACY_UNATTRIBUTED_SOURCE ? UNATTRIBUTED_SOURCE : entry.source;
      let bucket = sourceMap.get(normalizedSource);
      if (!bucket) {
        bucket = { orders: 0, revenue: 0, discount: 0, variants: new Map() };
        sourceMap.set(normalizedSource, bucket);
      }
      bucket.orders += entry.orders;
      bucket.revenue += entry.revenue;
      bucket.discount += entry.discount;
      for (const v of entry.variants || []) {
        const ex = bucket.variants.get(v.name);
        if (ex) {
          ex.orders += v.orders;
          ex.revenue += v.revenue;
          ex.discount += v.discount;
        } else {
          bucket.variants.set(v.name, { ...v });
        }
      }
    }
  }

  const result: SourceBreakdownEntry[] = [];
  for (const [source, bucket] of Array.from(sourceMap.entries())) {
    result.push({
      source,
      orders: bucket.orders,
      revenue: Math.round(bucket.revenue * 100) / 100,
      discount: Math.round(bucket.discount * 100) / 100,
      variants: Array.from(bucket.variants.values())
        .map((v) => ({
          name: v.name,
          orders: v.orders,
          revenue: Math.round(v.revenue * 100) / 100,
          discount: Math.round(v.discount * 100) / 100,
        }))
        .sort((a, b) => b.revenue - a.revenue),
    });
  }

  const unattributed = result.find((r) => r.source === UNATTRIBUTED_SOURCE);
  const birthdays = result.find((r) => r.source === BIRTHDAYS_SOURCE);
  const others = result.filter(
    (r) => r.source !== UNATTRIBUTED_SOURCE && r.source !== BIRTHDAYS_SOURCE,
  );
  others.sort((a, b) => b.revenue - a.revenue);
  const ordered = [...others];
  if (birthdays) ordered.push(birthdays);
  if (unattributed) ordered.push(unattributed);
  return ordered;
}

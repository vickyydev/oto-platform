import crypto from "crypto";
import { pool } from "./db";
import {
  buildSourceBreakdownStrict,
  mergeSourceBreakdowns,
  classifyByVoucherCode,
  classifyDiscountSourceStrict,
  cleanVoucherVariantLabel,
  UNATTRIBUTED_SOURCE,
  type SourceBreakdownEntry,
} from "./sourceRegistry";
import { latestOrderRows, latestPaymentRows } from "./funtopiaDedup";

export const FORMULA_VERSION = "v30";
export const FORMULA_LAST_UPDATED = "2026-09-15";
// v30 (2026-09-15): birthday event "cash" revenue now comes from actual
//   non-voucher payment rows (pay_amount − refund_amount), not paid product
//   line values. The Events range endpoint now prefers those cash fields over
//   booking-value fields. This prevents voucher-funded F&B from being reported
//   as collected birthday revenue while preserving booking values for display
//   and link scoring. Backfills and Events-range rows use deduplicated payment
//   rows across the requested report dates, and the combined birthday total
//   subtracts any F&B amount already moved into Events by the allocation.
// v29 (2026-09-15): birthday event "cash" revenue now comes from actual
//   non-voucher payment rows (pay_amount − refund_amount), not paid product
//   line values. The Events range endpoint now prefers those cash fields over
//   booking-value fields. This prevents voucher-funded F&B from being reported
//   as collected birthday revenue while preserving booking values for display
//   and link scoring.
// v28 (2026-07-17): hardening after v27 exposed real staff notes to the
//   linker. Direction-B Tier-A pairs (another order's note references the
//   party's code) now additionally require a birthday marker in that note,
//   so administrative notes ("Make up Vouchers For Order A47210") can't
//   forge code-confirmed links. BDAY_FNB_TOKEN_REGEX gained a leading \b.
//   getFlorestaEventsRange now self-heals stale cached days (formulaVersion
//   mismatch triggers a raw rebuild) instead of serving old links forever.
// v27 (2026-07-17): Pisell started returning staff-entered "Order Notes"
//   as `order_notes` on the bulk orders payload. storeRawOrders now maps it
//   into funtopia_raw_orders.note (historical rows backfilled from raw_json),
//   which activates the existing Tier-A code-confirmed birthday linking
//   ("#T038" on a party order) and note-based party detection that were
//   previously dormant because the note column was always NULL. Version
//   bump forces cached days to re-summarise on read so links recompute.
// v26 (2026-05-28, task-139): Floresta SKUs are now classified by Pisell's
//   stable product identifier rather than re-matching the display name on
//   every read. A new funtopia_product_registry table keyed by
//   `${product_id}::${variant_id}` stores each SKU's resolved Revenue
//   Category along with how the decision was made (pisell_category /
//   keyword_rescue / manual_override / unclassified). The first time a SKU
//   is seen the resolver runs the bootstrap chain (Pisell category →
//   keyword rescue → unclassified) and persists the result; every
//   subsequent read uses the stored decision directly via
//   resolveProductClassification(). buildCategoryBreakdown was refactored
//   to call the resolver instead of the inline if-chain of name-rescues,
//   so a renamed Pisell product or staff using "Open Item" for an off-menu
//   F&B charge can no longer drift a SKU's bucket. partyOrderIds promotion
//   is still applied as an order-level override on top of the SKU
//   decision. A read-only Products panel on the Config tab surfaces the
//   registry (Needs review filter at top); a manual override is available
//   as a safety valve but is not required for correctness. Bumped
//   FORMULA_VERSION v25 → v26 so cached days re-summarise on first read.
//   Chalong/Papaya has the same shape of problem and is intentionally out
//   of scope for this task — handle in a follow-up.
// v25 (2026-05-27, task-136): partially-paid order line items are now
//   proportionally attributed into real categories. Pre-v25 buildCategoryBreakdown
//   only consumed `paidProducts` (orders with payment_status === "paid"),
//   so a Partially-Paid order's payment landed in totalRevenue while its
//   line items were dropped into a bare "Other (Unattributed)" bar.
//   v25 computes per-order netCollected (cash basis: non-voucher net pay −
//   refund) and productSum (sum of payment_price for the order's active
//   products); for each non-paid order with both > 0 it scales every line
//   by share = min(1, netCollected / productSum) and feeds the synthetic
//   products into buildCategoryBreakdown alongside paidProducts. The
//   Unattributed bucket then only retains true residuals (orders with
//   payment but no line items, and rounding / voucher residual < ฿1),
//   each carrying orderCode/reason/createdAt/paymentStatus so the
//   dashboard renders a per-order drill-down. totalRevenue is unchanged —
//   only how products attribute into categories changes.
// v25 (2026-05-27, task-135): also rescues F&B items mis-categorized as
//   Extras. Pisell SKUs for clear food/drink items were sometimes tagged
//   with off-whitelist category_titles ("Asian Food", "Open Item",
//   "CHOCOLATE", "Kids juice", "seasonal", "Soup"), so they fell through
//   classifyCategory to "Extras" and inflated the Extras bar (~฿25k in
//   May 2026 on Floresta) while shrinking F&B. Mirrors the existing
//   isMerchandiseProduct / isWorkshopProduct pattern with
//   isFoodOrDrinkProduct(name) → "Food" | "Drinks" | null, wired into
//   buildCategoryBreakdown (Extras → F&B retag, sub-category override)
//   and into reclassifyCachedCategories so cached days self-heal on read.
//   "Open Item" is intentionally treated as F&B because staff use it for
//   custom F&B charges (cake corkage, off-menu drinks, etc.). Bday
//   tagging, party-promotion, totalRevenue and every other tile are
//   unchanged.
// v16 (2026-05-20): adds "indian" to TICKET_CATEGORIES so classifyCategory
//   buckets the "Indian​" Pisell category (and "1+1 Indian Package" SKUs)
//   under "Tickets & Packages" instead of "Extras". v11 added Indian as a
//   ticket sub-category but the top-level classifier list was never updated,
//   so Indian revenue was showing up under Extras on Revenue by Category.
//   Cached daily summaries < v16 are auto-reprocessed on read via the
//   existing formulaVersion-mismatch path so the fix back-applies without
//   a forced re-sync.
// v15 (2026-05-18): Floresta Total Revenue formula is now defined canonically as
//   payment_collected − walletpass_redeem to match Pisell's Net Sales (Cash
//   Basis). In practice the voucher pay_method bucket is the cash-basis
//   representation of walletpass_redeem (Pisell records each voucher
//   redemption that maps to actual money as a Voucher payment line), but the
//   subtraction is now computed symmetrically across ALL active voucher
//   payment rows — including any with net ≤ 0 (refund ≥ pay_amount) — so a
//   voucher refund can never be double-subtracted by being included in
//   paymentCollected (which already nets refunds) while being dropped from
//   voucherPaymentsTotal (previously filtered to net > 0). Cached daily
//   summaries < v15 are auto-corrected on read via fixCachedRevenue using the
//   matching SQL.
// v12 (2026-05-17): default birthday allocation flips to "events" so the
//   dashboard ships in BD→Bday view (party package + linked F&B combined
//   under Events / Birthdays). Adds a dedicated "Birthdays" bucket on
//   Revenue by Source carrying the birthday-party PACKAGE revenue only
//   (linked F&B is never in this bucket; ticket-only attribution rules
//   for other channels still apply to non-party orders). Tags birthday-
//   origin line items with bdayRevenue inside Tickets / F&B / Events
//   drill-downs so the ProductList can render a "bday" badge. Cached
//   summaries < v12 are restamped on next read via backfillBirthdayLinks.
// v11 (2026-05-15): adds Indian customer type. Orders in the new "Ticket > Indian"
//   Pisell subcategory are recognized as their own customer type. Each
//   "1+1 Indian Package" SKU counts as exactly 2 kids + 0 adults regardless of
//   price tier (฿690 / ฿890 / ฿1090). Additional Adult tickets on Indian-only
//   orders attach to the Indian bucket via the same orderTypeMap path used by
//   Tourist/Thai/Expat. Cached daily summaries from v10 will continue to bucket
//   Indian orders as "Other" until reprocessed.
// v10 (2026-05-14): computeBirthdayLinks now reads a manual override list
//   (funtopia_birthday_overrides) and treats each matching order_code+date
//   row as a bare-BDAY-tagged F&B order (Tier-B confirmed). If the row has
//   a party_order_code, it's promoted to a Tier-A code-confirmed pair
//   instead. Used to backfill historical Floresta birthday F&B orders
//   from before the BDAY-note convention existed. Chalong (Papaya) has a
//   parallel per-day override table (papaya_birthday_overrides) that
//   replaces channel-detected BD revenue when present. Overrides are
//   stored only in our DB; Pisell/Papaya source data is never modified.
// v9 (2026-05-14): computeBirthdayLinks now emits `bdTickets` — the
//   ticket/package-only revenue inside BD-identified orders
//   (partyOrderIds ∪ bdayTaggedFnbIds), restricted to lines classified as
//   "Tickets & Packages" or "Events / Birthdays" (or whose product name
//   matches isBirthdayPackage). Surfaced for the header BD→Tickets pill
//   so it doesn't double-count F&B lines that ride along inside a single
//   party order. Lazy re-stamp on access; no migration needed.
// v8 (2026-05-13): Birthday-party detection (computeBirthdayLinks) now treats
//   a standalone BDAY / B-DAY / BIRTHDAY token in an order's Pisell note as
//   an F&B-side marker (NOT a promotion to party). Pairing now runs in
//   strict tiers: Tier A code-confirmed (party note has F&B code OR F&B
//   note has party code, e.g. "BDAY A44539") always beats Tier B
//   bare-BDAY-confirmed (closest party with matching order_date by
//   created_at; time proximity is the sole tie-breaker; the same-day
//   guard prevents leakage from crossDateOrders), which always beats Tier C
//   heuristic ≥8. BDAY-tagged F&B orders that can't be paired (including
//   on days with zero parties) are logged as orphans before the early
//   return. Order notes are read from Pisell's API (`note` / `remark`)
//   as-is — the dashboard never edits notes itself.
// v5 (2026-05-11): Birthday party detection now reads staff-entered Pisell
//   order notes. An order whose note contains an unambiguous birthday/party
//   marker is recognized as a party order even without a "birthday package"
//   line item. Notes that cross-reference another order code (party ↔ F&B)
//   are treated as a confirmed link and bypass the heuristic score threshold.
// v4 (2026-05-06): "Revenue by Source" card now reflects ticket revenue only.
//   Source rows credit the Tickets & Packages portion of attributed orders
//   (excluding voucher-swing line items). Free Coffee and Free Ice Cream
//   wallet passes are recognized as their own source buckets. Orders whose
//   only voucher is a non-channel F&B voucher (e.g. 350B FB Voucher) are
//   dropped from the card entirely (not rolled into Walk-in).

export interface FormulaEntry {
  id: string;
  name: string;
  description: string;
  formula: string;
  version: string;
  lastUpdated: string;
}

export interface FormulaCategory {
  category: string;
  formulas: FormulaEntry[];
}

export const FORMULA_REGISTRY: FormulaCategory[] = [
  {
    category: "Revenue & Financials",
    formulas: [
      {
        id: "gross_revenue",
        name: "Gross Revenue",
        description: "Cash-basis revenue collected from non-voided orders, matching Pisell's Net Sales (Cash Basis) = payment_collected − walletpass_redeem. Voucher pay_method rows are the cash-basis representation of walletpass_redeem.",
        formula: "Gross Revenue = SUM(pay_amount − refund_amount) over all active payments on non-voided orders − SUM(pay_amount − refund_amount) over voucher-method payments on the same orders (computed symmetrically — net ≤ 0 voucher rows are kept so a voucher refund cannot be double-subtracted).",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "net_revenue",
        name: "Net Revenue",
        description: "Revenue after subtracting voucher payments from gross revenue.",
        formula: "Net Revenue = Gross Revenue − Voucher payments total.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "avg_order_value",
        name: "Avg Order Value",
        description: "Average revenue per non-voided order.",
        formula: "Avg Order Value = Gross Revenue / count of non-voided orders.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "discount",
        name: "Discount",
        description: "Sum of all discount amounts applied to orders.",
        formula: "Discount = Sum of (product_discount + order_discount) for all non-voided orders.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "voucher_swing",
        name: "Voucher Swing",
        description: "Face value of vouchers sold as products (not redeemed as payment).",
        formula: "Voucher Swing = For each paid product matching /(\\d+)\\s*voucher/, multiply the face value by quantity and sum.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "pure_ticket_revenue",
        name: "Pure Ticket Revenue",
        description: "Ticket & Packages category revenue minus voucher face-value sales.",
        formula: "Pure Ticket Revenue = categoryBreakdown['Tickets & Packages'].revenue − Voucher Swing amount.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
    ],
  },
  {
    category: "Payment Methods",
    formulas: [
      {
        id: "payment_normalization",
        name: "Payment Method Normalization",
        description: "Raw Pisell pay_method values are normalized into standard categories.",
        formula: "Cash → 'Cash'; PromptPay, QR, Thai QR → 'PromptPay/QR'; Credit Card, Visa, Mastercard → 'Credit Card'; Voucher → 'Voucher'; all others → 'Custom-E-Wallets'.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "payment_net",
        name: "Payment Net Amount",
        description: "Net amount per payment entry.",
        formula: "Net = pay_amount − refund_amount. Only positive net amounts are counted toward breakdowns.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
    ],
  },
  {
    category: "Category Classification",
    formulas: [
      {
        id: "cat_tickets",
        name: "Tickets & Packages",
        description: "Products classified into the Tickets & Packages category.",
        formula: "category_title contains 'tourist', 'thai', 'expat', 'ticket', or 'special'. Also reclassified by product_title patterns.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "cat_fnb",
        name: "F&B",
        description: "Food & Beverage products (drinks and food).",
        formula: "category_title matches drink keywords (coffee, juice, bar, soda) or food keywords (mains, kids menu, cafe, pasta, desserts).",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "cat_events",
        name: "Events / Birthdays",
        description: "Event and birthday party packages.",
        formula: "category_title contains 'party', 'birthday', or 'event'. Also reclassified if product_title contains 'birthday' or 'party' AND 'package'.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "cat_nanny",
        name: "Nanny & Drop-off",
        description: "Nanny and drop-off service products.",
        formula: "Reclassified from Extras/Tickets if product_title contains 'nanny', 'drop-off', or 'dropoff'.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "cat_merchandise",
        name: "Merchandise",
        description: "Physical merchandise items.",
        formula: "category_title is 'merchandise' or product_title matches known items (bunny, sunglasses, toy, bracelet, etc.).",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "cat_extras",
        name: "Extras",
        description: "Everything not matching other categories.",
        formula: "Catch-all for products not classified into Tickets, F&B, Events, Nanny, or Merchandise (primarily socks, open items).",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "cat_reconciliation",
        name: "Category Revenue Reconciliation",
        description: "Reconciles category revenues to total revenue with asymmetric handling for partial-payment residuals (v25, task-136).",
        formula: "v25 proportional attribution: for each non-paid active order with netCollected > 0 and productSum > 0, every line item is scaled by share = min(1, netCollected / productSum) and fed into the category breakdown alongside paidProducts. Orders with payment > 0 but no line items become explicit per-order entries in the 'Other (Unattributed)' bucket (each carrying orderCode, reason, createdAt, paymentStatus for drill-down). Voucher-refund orders (net ≤ 0 against totalRevenue) are also surfaced as per-order entries. Reconciliation: if diff = totalRevenue − catSum > 0 the bucket revenue equals diff (explicit items kept as-is, scaled down only if their sum exceeds diff, with a 'Rounding / voucher residual' filler row for the remainder < ฿1). If diff < 0 (refunds/rounding overshoot), categories scale down proportionally by (totalRevenue / catSum) and no positive bucket is added — explicit per-order entries are still attached as zero-revenue rows so the drill-down stays available.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
    ],
  },
  {
    category: "Guest Counts",
    formulas: [
      {
        id: "bundle_solving",
        name: "Bundle Solving",
        description: "Separates bundled ticket line items (e.g., '1 Kid + 1 Adult') into individual kid and adult counts.",
        formula: "Compare original_price against known kid base prices. Adults = (OriginalPrice − Kids × KidBasePrice) / ADULT_TICKET_PRICE (฿327.10). Iterate kids 1..15, pick solution with smallest rounding error.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "known_kid_prices",
        name: "Known Kid Base Prices",
        description: "Reference prices used for bundle solving.",
        formula: "Thai 1hr = ฿393, Thai 2hr = ฿486, Tourist 1hr = ฿645, Tourist 2hr = ฿832, Expat 1hr = ฿778. Indian 1+1 Package: 1hr = ฿690, 2hr = ฿890, Full-day = ฿1090 (each represents 2 kids, see Indian Package Headcount Rule). Adult ticket price (ADULT_TICKET_PRICE) = ฿327.10.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "thai_free_guardian",
        name: "Thai Free Guardian Rule",
        description: "Adds 1 free adult guardian per Thai order containing at least 1 kid ticket.",
        formula: "For Thai market orders: if kidTickets ≥ 1, add 1 to estimatedTotalAdults. These guardians appear in headcount but not in ticket revenue.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
    ],
  },
  {
    category: "Birthday Links",
    formulas: [
      {
        id: "birthday_fnb_allocation",
        name: "Birthday F&B Allocation Toggle",
        description: "Per-branch preference (default OFF) controlling whether F&B revenue linked to birthday parties is reported under F&B or moved to Events / Birthdays. Applied at read time to category breakdowns served by /api/funtopia/today, /api/funtopia/range, the AI assistant, and the chart-builder so every tab agrees.",
        formula: "If allocation = 'events': moved = min(partyFnbRevenue, categoryBreakdown['F&B'].revenue); F&B -= moved; Events / Birthdays += moved. Stored in funtopia_branch_settings(branch, 'birthday_fnb_allocation'). Each served summary is stamped with `birthdayAllocation` so historical comparisons stay consistent with the allocation in effect.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "birthday_party_link",
        name: "Party F&B Linking (Heuristic)",
        description: "Party orders are detected by Pisell line-item content AND staff-entered notes; same-day F&B orders are linked via either a note cross-reference (confirmed) or a heuristic score (fallback).",
        formula: "Order notes are read from Pisell's API as-is; the dashboard never edits them. Staff write the linking notes on the Pisell side using the convention: party-side note = the F&B order code (e.g. 'T059'); F&B-side note = 'BDAY' or 'BDAY A44539'. Party Order = any paid Floresta order whose line items include a product matching isBirthdayPackage(name) (Gold/Silver/Platinum/Bronze Party Package, Birthday Package), OR whose staff note contains an unambiguous PARTY-side marker ('birthday party', 'bday party', 'b-day party', 'party package', 'bd party', วันเกิด, ปาร์ตี้). A bare 'BDAY'/'B-DAY'/'BIRTHDAY' token is an F&B-side marker and does NOT promote the order to a party. Confirmed Link = (A) party note references an F&B order_code, (B) non-party order's note references a party order_code (covers 'BDAY A44539'-style notes), or (C) F&B order tagged with bare BDAY token gets paired with the closest same-day party by created_at. Confirmed pairs bypass the score threshold and are accepted first in greedy assignment. BDAY-tagged F&B with no same-day party is left unlinked and logged. Candidate F&B Order (heuristic fallback) = same-day non-party order with lineCount>=5 OR totalQty>=8 AND fnbRev>0. Each candidate scored against the party order: lineCount (20+:+8 / 10+:+5 / 5+:+2), total (฿10k+:+6 / ฿5k+:+4 / ฿2k+:+2), Jug of Juice (+5), Birthday cake (+4), kid items qty (8+:+4 / 4+:+2 / 1+:+1), F&B-dominant ≥50% (+2), time gap to party in Bangkok TZ (±30m:+4 / ±2h:+2 / >4h but <24h:-2; advance bookings >24h skip the penalty). Greedy 1-to-1 assignment: confirmed (note-based) pairs first, then scored heuristic pairs ≥8; each party + each F&B order linked at most once. Party F&B Revenue = sum of linked F&B order revenues; Combined Birthday Total = Events/Birthdays category revenue + Party F&B Revenue.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
    ],
  },
  {
    category: "Customer Types",
    formulas: [
      {
        id: "ct_tourist",
        name: "Tourist Detection",
        description: "Identifies tourist customer tickets.",
        formula: "product_title or category_title contains 'tourist'.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "ct_thai",
        name: "Thai Detection",
        description: "Identifies Thai customer tickets.",
        formula: "product_title or category_title contains 'thai'.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "ct_expat",
        name: "Expat Detection",
        description: "Identifies Expat customer tickets.",
        formula: "product_title or category_title contains 'expat'.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "ct_indian",
        name: "Indian Detection",
        description: "Identifies Indian customer tickets.",
        formula: "product_title or category_title contains 'indian' (e.g. Pisell category 'Ticket > Indian', product '1+1 Indian Package (1 hour / 2 hour / Full-day)').",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "ct_indian_headcount",
        name: "Indian Package Headcount Rule",
        description: "Each '1+1 Indian Package' SKU is sold as one line item but always represents 2 kids and 0 adults.",
        formula: "For any product whose title contains 'indian package' (case-insensitive): kidTickets += qty * 2, adultTickets += 0, totalGuests += qty * 2. Applied regardless of price tier (฿690 / ฿890 / ฿1090). Adult headcount on Indian orders only comes from separately-purchased 'Additional Adult' tickets on the same order (attached via orderTypeMap).",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
      {
        id: "ct_eat_play",
        name: "Eat & Play Detection",
        description: "Identifies Eat & Play bundle tickets.",
        formula: "product_title contains 'eat' AND 'play' (excluding 'voucher'), OR category_title is 'special' or 'extra'.",
        version: FORMULA_VERSION,
        lastUpdated: FORMULA_LAST_UPDATED,
      },
    ],
  },
];

const FUNTOPIA_API_URL = process.env.FUNTOPIA_API_URL || "https://ap.pisellapi.com";
const FUNTOPIA_CLIENT_ID = process.env.FUNTOPIA_CLIENT_ID || "";
const FUNTOPIA_CLIENT_SECRET = process.env.FUNTOPIA_CLIENT_SECRET || "";
const FUNTOPIA_ACCESS_TOKEN = process.env.FUNTOPIA_ACCESS_TOKEN || "";

async function ensureCacheTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_daily_cache (
      date TEXT PRIMARY KEY,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      summary_json JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_raw_orders (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      order_date TEXT NOT NULL,
      order_code TEXT,
      payment_status TEXT,
      total_amount NUMERIC(12,2) DEFAULT 0,
      product_discount NUMERIC(12,2) DEFAULT 0,
      order_discount NUMERIC(12,2) DEFAULT 0,
      created_at TEXT,
      source TEXT,
      channel TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      customer_email TEXT,
      note TEXT,
      raw_json JSONB,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_raw_orders_date ON funtopia_raw_orders(order_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_raw_orders_order_id ON funtopia_raw_orders(order_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_orders (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      order_date TEXT NOT NULL,
      created_at TEXT,
      product_id TEXT,
      variant_id TEXT,
      product_name TEXT,
      product_category TEXT,
      quantity INTEGER DEFAULT 1,
      unit_price NUMERIC(12,2) DEFAULT 0,
      subtotal NUMERIC(12,2) DEFAULT 0,
      discount NUMERIC(12,2) DEFAULT 0,
      tax NUMERIC(12,2) DEFAULT 0,
      payment_method TEXT,
      sales_channel TEXT,
      raw_json JSONB,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_orders_date ON funtopia_orders(order_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_orders_order_id ON funtopia_orders(order_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_orders_product ON funtopia_orders(product_name)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_raw_payments (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      order_date TEXT NOT NULL,
      pay_method TEXT,
      payment_name TEXT,
      pay_amount NUMERIC(12,2) DEFAULT 0,
      refund_amount NUMERIC(12,2) DEFAULT 0,
      payment_surcharge NUMERIC(12,2) DEFAULT 0,
      payment_at TEXT,
      raw_json JSONB,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_raw_payments_date ON funtopia_raw_payments(order_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_raw_payments_order_id ON funtopia_raw_payments(order_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_raw_wallet_passes (
      id SERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      order_date TEXT NOT NULL,
      title TEXT,
      code TEXT,
      code_type TEXT,
      action TEXT,
      redeem_amount NUMERIC(12,2) DEFAULT 0,
      raw_json JSONB,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_wallet_passes_date ON funtopia_raw_wallet_passes(order_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_wallet_passes_order_id ON funtopia_raw_wallet_passes(order_id)`);

  try { await pool.query(`ALTER TABLE funtopia_orders ADD COLUMN IF NOT EXISTS product_id TEXT`); } catch {}
  try { await pool.query(`ALTER TABLE funtopia_orders ADD COLUMN IF NOT EXISTS variant_id TEXT`); } catch {}
  try { await pool.query(`ALTER TABLE funtopia_orders ADD COLUMN IF NOT EXISTS raw_json JSONB`); } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_voucher_channel_map (
      face_value NUMERIC(12,2) PRIMARY KEY,
      channel TEXT,
      ignored BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Migrate single channel TEXT -> channels TEXT[] (supports ambiguous face values like ฿250 = Airport AND School)
  try { await pool.query(`ALTER TABLE funtopia_voucher_channel_map ADD COLUMN IF NOT EXISTS channels TEXT[]`); } catch {}
  try {
    await pool.query(`
      UPDATE funtopia_voucher_channel_map
      SET channels = ARRAY[channel]
      WHERE channels IS NULL AND channel IS NOT NULL AND TRIM(channel) <> ''
    `);
  } catch {}
  try {
    await pool.query(`UPDATE funtopia_voucher_channel_map SET channels = '{}'::TEXT[] WHERE channels IS NULL`);
  } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_birthday_overrides (
      order_code TEXT NOT NULL,
      order_date DATE NOT NULL,
      party_order_code TEXT,
      note TEXT,
      PRIMARY KEY (order_code, order_date)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_birthday_overrides_date ON funtopia_birthday_overrides(order_date)`);
  await seedFuntopiaBirthdayOverrides();
}

// Manual backfill list (see task-103). Idempotent: inserts only when missing.
// Each row marks an F&B-side order as belonging to a birthday party, equivalent
// to a bare "BDAY" note token. partyOrderCode is optional — when present it
// promotes the pair to a Tier-A code-confirmed link (task-135); when omitted
// we let the same-day Tier-B pairing find the party.
const FUNTOPIA_BIRTHDAY_OVERRIDE_SEED: Array<{ orderCode: string; orderDate: string; partyOrderCode?: string; note?: string }> = [
  // May 2026 — task-135: parties whose staff-entered Pisell notes aren't
  // returned by the bulk API, so the cross-reference has to be codified.
  // A48963 (party, Partially Paid, note "T007") ↔ T007 (F&B, note "BDAY")
  { orderCode: "T007", orderDate: "2026-05-24", partyOrderCode: "A48963", note: "task-135: Pisell notes T007/BDAY not exposed via API" },
  // A48547 (Gold Party Package, fully paid via Merchant Portal) ↔ T019
  // (F&B, note "BDAY"). A48547 itself was missing from our 2026-05-23
  // cache until a forced resync — the daily auto-sync window had not
  // refreshed since the order was finalized on Pisell.
  { orderCode: "T019", orderDate: "2026-05-23", partyOrderCode: "A48547", note: "task-135: Pisell notes T019/BDAY not exposed via API" },
  // April 2026
  { orderCode: "T011", orderDate: "2026-04-02" },
  { orderCode: "T182", orderDate: "2026-04-04" },
  { orderCode: "T214", orderDate: "2026-04-04" },
  { orderCode: "T034", orderDate: "2026-04-06" },
  { orderCode: "T007", orderDate: "2026-04-08" },
  { orderCode: "T383", orderDate: "2026-04-12" },
  { orderCode: "T016", orderDate: "2026-04-22" },
  { orderCode: "T171", orderDate: "2026-04-25" },
  { orderCode: "T184", orderDate: "2026-04-25" },
  { orderCode: "T016", orderDate: "2026-04-29" },
  // March 2026
  { orderCode: "T426", orderDate: "2026-03-01" },
  { orderCode: "T152", orderDate: "2026-03-03" },
  { orderCode: "T202", orderDate: "2026-03-04" },
  { orderCode: "T232", orderDate: "2026-03-04" },
  { orderCode: "T056", orderDate: "2026-03-07" },
  { orderCode: "T196", orderDate: "2026-03-07" },
  { orderCode: "T414", orderDate: "2026-03-07" },
  { orderCode: "T004", orderDate: "2026-03-08" },
  { orderCode: "T151", orderDate: "2026-03-12" },
  { orderCode: "T254", orderDate: "2026-03-12" },
  { orderCode: "T009", orderDate: "2026-03-21" },
  { orderCode: "T069", orderDate: "2026-03-21" },
  { orderCode: "T018", orderDate: "2026-03-29" },
  { orderCode: "T408", orderDate: "2026-03-29" },
];

let floraBirthdayOverridesSeeded = false;
async function seedFuntopiaBirthdayOverrides(): Promise<void> {
  if (floraBirthdayOverridesSeeded) return;
  for (const row of FUNTOPIA_BIRTHDAY_OVERRIDE_SEED) {
    // task-135: if a row carries partyOrderCode, upsert so the Tier-A pairing
    // is applied even if a NULL row was previously seeded for the same key.
    if (row.partyOrderCode) {
      await pool.query(
        `INSERT INTO funtopia_birthday_overrides (order_code, order_date, party_order_code, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (order_code, order_date) DO UPDATE
           SET party_order_code = EXCLUDED.party_order_code,
               note = EXCLUDED.note`,
        [row.orderCode, row.orderDate, row.partyOrderCode, row.note || "task-135 manual link"],
      );
    } else {
      await pool.query(
        `INSERT INTO funtopia_birthday_overrides (order_code, order_date, party_order_code, note)
         VALUES ($1, $2, NULL, 'task-103 backfill')
         ON CONFLICT (order_code, order_date) DO NOTHING`,
        [row.orderCode, row.orderDate],
      );
    }
  }
  floraBirthdayOverridesSeeded = true;
  // task-103 Step 5: log current Floresta March/April totals from the cache
  // so the user can compare against the expected figures (March F&B ≈฿54,178
  // BD ≈฿195,709; April should now show 10 linked birthday events).
  await logTask103FlorestaVerification();
}

async function logTask103FlorestaVerification(): Promise<void> {
  try {
    const res = await pool.query(
      `SELECT date, summary_json FROM funtopia_daily_cache
       WHERE date >= '2026-03-01' AND date <= '2026-04-30' ORDER BY date`,
    );
    let marchFnb = 0, marchBd = 0, aprilLinked = 0, marchLinked = 0;
    for (const r of res.rows) {
      const s: any = r.summary_json;
      if (!s) continue;
      const fnb = s.categoryBreakdown?.["F&B"]?.revenue || 0;
      const bd = s.categoryBreakdown?.["Events / Birthdays"]?.revenue || 0;
      const linked = s.birthdayLinks?.linkedOrderCount || 0;
      if (r.date.startsWith("2026-03")) { marchFnb += fnb; marchBd += bd; marchLinked += linked; }
      else if (r.date.startsWith("2026-04")) { aprilLinked += linked; }
    }
    console.log(
      `[Funtopia][task-103] verification (cached) — March 2026 Central: F&B=฿${marchFnb.toFixed(0)} (target ≈฿54,178), BD=฿${marchBd.toFixed(0)} (target ≈฿195,709), linked=${marchLinked}; April 2026 Central: linked=${aprilLinked} (target 10). Regenerate March/April caches to pick up overrides if numbers are off.`,
    );
  } catch (e) {
    console.warn(`[Funtopia][task-103] verification log failed`, e);
  }
}

export interface FuntopiaBirthdayOverrideRow {
  orderCode: string;
  partyOrderCode: string | null;
}

export async function loadFuntopiaBirthdayOverridesForDate(
  date: string,
): Promise<Map<string, FuntopiaBirthdayOverrideRow>> {
  const map = new Map<string, FuntopiaBirthdayOverrideRow>();
  try {
    const res = await pool.query(
      `SELECT order_code, party_order_code FROM funtopia_birthday_overrides WHERE order_date = $1`,
      [date],
    );
    for (const r of res.rows) {
      const code = String(r.order_code || "").toUpperCase();
      if (!code) continue;
      map.set(code, {
        orderCode: code,
        partyOrderCode: r.party_order_code ? String(r.party_order_code).toUpperCase() : null,
      });
    }
  } catch (err) {
    console.warn(`[Funtopia] loadFuntopiaBirthdayOverridesForDate(${date}) failed:`, err);
  }
  return map;
}

// task-134 (manual linker): list same-day non-party orders that could
// plausibly be the F&B side of an event. Used by the Events tab "Link F&B"
// picker. Read-only — no cache mutation here.
export interface EventCandidateRow {
  orderId: string;
  orderCode: string;
  createdAt: string | null;
  totalAmount: number;
  lineCount: number;
  totalQty: number;
  fnbRevenue: number;
  itemsPreview: string;
  linkedToPartyCode: string | null; // already linked (override or auto) to this party? to another party?
  alreadyLinkedToThisParty: boolean;
}

export async function getFlorestaEventCandidates(
  date: string,
  partyOrderCode: string,
): Promise<EventCandidateRow[]> {
  await initCacheTable();
  const upperParty = String(partyOrderCode || "").toUpperCase();
  if (!upperParty) return [];

  // 1. Identify party order ids on that date (line-item or note based)
  //    so we can exclude them from the candidate list (party != F&B).
  const partyIdsRes = await pool.query(
    `SELECT DISTINCT o.order_id, o.order_code, o.note
       FROM funtopia_raw_orders o
       LEFT JOIN funtopia_orders i
         ON i.order_id = o.order_id AND i.order_date = o.order_date
      WHERE o.order_date = $1
        AND lower(o.payment_status) <> 'voided'`,
    [date],
  );
  const partyIds = new Set<string>();
  // Fetch products for the date to detect party packages
  const productsRes = await pool.query(
    `SELECT order_id, product_name FROM funtopia_orders WHERE order_date = $1`,
    [date],
  );
  for (const p of productsRes.rows) {
    if (isBirthdayPackage(String(p.product_name || ""))) partyIds.add(String(p.order_id));
  }
  for (const r of partyIdsRes.rows) {
    const note = String(r.note || "");
    const lower = normalizeNote(note);
    if (noteHasBirthdayMarker(lower, note)) partyIds.add(String(r.order_id));
  }

  // 2. Aggregate per-order line stats for non-party orders on the date.
  const aggRes = await pool.query(
    `SELECT o.order_id, o.order_code, o.created_at, o.total_amount,
            COALESCE(SUM(i.subtotal), 0) AS sum_subtotal,
            COALESCE(COUNT(i.product_name), 0) AS line_count,
            COALESCE(SUM(i.quantity), 0) AS total_qty,
            COALESCE(SUM(CASE WHEN lower(i.product_category) ~ 'food|drink|cafe|bakery|dessert|kitchen'
                              THEN i.subtotal ELSE 0 END), 0) AS fnb_rev,
            COALESCE(string_agg(i.product_name, ' / ' ORDER BY i.subtotal DESC), '') AS items
       FROM funtopia_raw_orders o
       LEFT JOIN funtopia_orders i
         ON i.order_id = o.order_id AND i.order_date = o.order_date
      WHERE o.order_date = $1
        AND lower(o.payment_status) <> 'voided'
      GROUP BY o.order_id, o.order_code, o.created_at, o.total_amount`,
    [date],
  );

  // 3. Existing overrides for the date (so UI can show "already linked").
  const overrides = await loadFuntopiaBirthdayOverridesForDate(date);

  // 4. Read existing auto-links from the cached summary too (so a candidate
  //    paired by Tier A/B/C heuristics is also flagged).
  const cachedRes = await pool.query(
    `SELECT summary_json FROM funtopia_daily_cache WHERE date = $1`,
    [date],
  );
  const autoLinkByFnbCode = new Map<string, string>(); // fnbCode -> partyCode
  if (cachedRes.rows[0]?.summary_json) {
    const s = cachedRes.rows[0].summary_json as DailySummary;
    for (const lk of s.birthdayLinks?.links || []) {
      autoLinkByFnbCode.set(String(lk.fnbOrderCode || "").toUpperCase(), String(lk.partyOrderCode || "").toUpperCase());
    }
  }

  const rows: EventCandidateRow[] = [];
  for (const r of aggRes.rows) {
    const id = String(r.order_id);
    if (partyIds.has(id)) continue; // never offer a party order as F&B
    const code = String(r.order_code || "").toUpperCase();
    if (code === upperParty) continue;

    const overrideRow = overrides.get(code);
    const autoLinkParty = autoLinkByFnbCode.get(code) || null;
    const linkedToPartyCode =
      overrideRow?.partyOrderCode || autoLinkParty || (overrideRow ? "(bday tagged)" : null);

    rows.push({
      orderId: id,
      orderCode: code,
      createdAt: r.created_at || null,
      totalAmount: Number(r.total_amount) || Number(r.sum_subtotal) || 0,
      lineCount: Number(r.line_count) || 0,
      totalQty: Number(r.total_qty) || 0,
      fnbRevenue: Number(r.fnb_rev) || 0,
      itemsPreview: String(r.items || "").slice(0, 120),
      linkedToPartyCode,
      alreadyLinkedToThisParty: linkedToPartyCode === upperParty,
    });
  }
  // Sort: candidates already linked to *this* party first, then ones linked
  // elsewhere last, otherwise by total revenue desc.
  rows.sort((a, b) => {
    if (a.alreadyLinkedToThisParty !== b.alreadyLinkedToThisParty) {
      return a.alreadyLinkedToThisParty ? -1 : 1;
    }
    const aBusy = a.linkedToPartyCode && !a.alreadyLinkedToThisParty ? 1 : 0;
    const bBusy = b.linkedToPartyCode && !b.alreadyLinkedToThisParty ? 1 : 0;
    if (aBusy !== bBusy) return aBusy - bBusy;
    return b.totalAmount - a.totalAmount;
  });
  return rows;
}

export async function upsertFuntopiaBirthdayOverride(args: {
  orderCode: string;
  orderDate: string;
  partyOrderCode: string | null;
  note?: string | null;
}): Promise<void> {
  const orderCode = String(args.orderCode || "").toUpperCase().trim();
  const partyOrderCode = args.partyOrderCode ? String(args.partyOrderCode).toUpperCase().trim() : null;
  if (!orderCode) throw new Error("orderCode required");
  if (!args.orderDate) throw new Error("orderDate required");
  await initCacheTable();
  await pool.query(
    `INSERT INTO funtopia_birthday_overrides (order_code, order_date, party_order_code, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (order_code, order_date)
     DO UPDATE SET party_order_code = EXCLUDED.party_order_code, note = COALESCE(EXCLUDED.note, funtopia_birthday_overrides.note)`,
    [orderCode, args.orderDate, partyOrderCode, args.note ?? "manual linker (events tab)"],
  );
}

export async function deleteFuntopiaBirthdayOverride(args: {
  orderCode: string;
  orderDate: string;
}): Promise<void> {
  const orderCode = String(args.orderCode || "").toUpperCase().trim();
  if (!orderCode || !args.orderDate) throw new Error("orderCode and orderDate required");
  await initCacheTable();
  await pool.query(
    `DELETE FROM funtopia_birthday_overrides WHERE order_code = $1 AND order_date = $2`,
    [orderCode, args.orderDate],
  );
}

export async function rebuildFlorestaCacheForDate(date: string): Promise<void> {
  await rebuildAndCacheSummaryWithApiLock(date);
}

export type VoucherChannelMapEntry = { channels: string[]; ignored: boolean; note: string | null };

function formatFaceValue(v: number | string): string {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!isFinite(n)) return "0.00";
  return n.toFixed(2);
}

export async function getVoucherChannelMap(): Promise<Map<string, VoucherChannelMapEntry>> {
  await ensureCacheTable();
  const map = new Map<string, VoucherChannelMapEntry>();
  try {
    const res = await pool.query(`SELECT face_value, channels, ignored, note FROM funtopia_voucher_channel_map`);
    for (const r of res.rows) {
      const rawChannels: string[] = Array.isArray(r.channels) ? r.channels : [];
      const channels = rawChannels.map((s) => String(s || "").trim()).filter((s) => s.length > 0);
      map.set(formatFaceValue(r.face_value), {
        channels,
        ignored: !!r.ignored,
        note: r.note || null,
      });
    }
  } catch (err) {
    console.warn(`[Funtopia] getVoucherChannelMap failed:`, err);
  }
  return map;
}

export async function upsertVoucherChannelMapping(
  faceValue: number,
  channels: string[],
  ignored: boolean,
  note?: string | null,
): Promise<void> {
  await ensureCacheTable();
  const cleanChannels = (channels || [])
    .map((c) => String(c || "").trim())
    .filter((c) => c.length > 0);
  // Keep legacy `channel` column populated with the first channel for any lingering readers
  const primary = cleanChannels[0] || (ignored ? "Ignored" : "");
  await pool.query(
    `INSERT INTO funtopia_voucher_channel_map (face_value, channel, channels, ignored, note, updated_at)
     VALUES ($1, $2, $3::text[], $4, $5, NOW())
     ON CONFLICT (face_value)
     DO UPDATE SET channel = EXCLUDED.channel, channels = EXCLUDED.channels, ignored = EXCLUDED.ignored, note = EXCLUDED.note, updated_at = NOW()`,
    [faceValue, primary, cleanChannels, ignored, note || null],
  );
}

export async function deleteVoucherChannelMapping(faceValue: number): Promise<void> {
  await ensureCacheTable();
  await pool.query(`DELETE FROM funtopia_voucher_channel_map WHERE face_value = $1`, [faceValue]);
}

// =====================================================================
// Branch preferences (key/value, scoped per branch).
// Currently used to remember the "Count birthday F&B under Events /
// Birthdays" toggle so every tab/chart/export agrees with the dashboard.
// =====================================================================
async function ensureBranchSettingsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_branch_settings (
      branch TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (branch, key)
    )
  `);
}

export type BranchKey = string;
export const BIRTHDAY_ALLOCATION_KEY = "birthday_fnb_allocation";
export type BirthdayAllocation = "fnb" | "events";

function normalizeBranch(branch: string | undefined | null): BranchKey {
  const b = String(branch || "").trim().toLowerCase();
  return b || "floresta";
}

export async function getBranchSetting<T = unknown>(
  branch: string,
  key: string,
): Promise<T | null> {
  await ensureBranchSettingsTable();
  try {
    const res = await pool.query(
      `SELECT value FROM funtopia_branch_settings WHERE branch = $1 AND key = $2`,
      [normalizeBranch(branch), key],
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].value as T;
  } catch (err) {
    console.warn(`[Funtopia] getBranchSetting(${branch},${key}) failed:`, err);
    return null;
  }
}

export async function setBranchSetting(
  branch: string,
  key: string,
  value: unknown,
): Promise<void> {
  await ensureBranchSettingsTable();
  await pool.query(
    `INSERT INTO funtopia_branch_settings (branch, key, value, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (branch, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [normalizeBranch(branch), key, JSON.stringify(value)],
  );
}

export async function getBirthdayAllocation(branch: string): Promise<BirthdayAllocation> {
  const stored = await getBranchSetting<{ allocation?: BirthdayAllocation } | string>(
    branch,
    BIRTHDAY_ALLOCATION_KEY,
  );
  if (stored && typeof stored === "object" && (stored as any).allocation) {
    const v = (stored as any).allocation;
    return v === "events" ? "events" : "fnb";
  }
  if (stored === "events") return "events";
  if (stored === "fnb") return "fnb";
  // task-111: default flipped to "events" so the dashboard ships in
  // BD→Bday view (combined party package + linked F&B under Events).
  return "events";
}

// task-114: Chalong birthday allocation toggle. Default is "bday"
// (all birthday-channel line items roll up to "Events / Birthdays" — matches
// pre-114 behavior). When set to "split", server/papaya.ts re-buckets each
// line item to its natural category (Tickets & Packages / F&B / Socks /
// Memberships / Merchandise) and falls back to Events / Birthdays for
// anything ambiguous (Extras, Nanny, entertainment, unknown). Stored under
// the same BIRTHDAY_ALLOCATION_KEY but scoped to branch='chalong' to reuse
// the funtopia_branch_settings infrastructure.
export type ChalongBirthdayAllocation = "bday" | "split";
export const CHALONG_BRANCH_KEY = "chalong";

export async function getChalongBirthdayAllocation(): Promise<ChalongBirthdayAllocation> {
  const stored = await getBranchSetting<{ allocation?: ChalongBirthdayAllocation } | string>(
    CHALONG_BRANCH_KEY,
    BIRTHDAY_ALLOCATION_KEY,
  );
  if (stored && typeof stored === "object" && (stored as any).allocation) {
    const v = (stored as any).allocation;
    return v === "split" ? "split" : "bday";
  }
  if (stored === "split") return "split";
  return "bday";
}

export async function setChalongBirthdayAllocation(
  allocation: ChalongBirthdayAllocation,
): Promise<void> {
  const v: ChalongBirthdayAllocation = allocation === "split" ? "split" : "bday";
  await setBranchSetting(CHALONG_BRANCH_KEY, BIRTHDAY_ALLOCATION_KEY, { allocation: v });
}

export async function setBirthdayAllocation(
  branch: string,
  allocation: BirthdayAllocation,
): Promise<void> {
  const v: BirthdayAllocation = allocation === "events" ? "events" : "fnb";
  await setBranchSetting(branch, BIRTHDAY_ALLOCATION_KEY, { allocation: v });
  // Floresta is the only branch with birthdayLinks data; restamp every
  // cached daily summary so historical reads stay consistent with the new
  // preference. Best-effort: any individual failure is logged and skipped.
  if (normalizeBranch(branch) === "floresta") {
    try {
      await initCacheTable();
      const rows = await pool.query(
        `SELECT date, summary_json FROM funtopia_daily_cache WHERE date != '__meta__'`,
      );
      for (const r of rows.rows) {
        const s = r.summary_json as DailySummary;
        const expectedSummary = structuredClone(s);
        if (!s.birthdayLinks || s.formulaVersion !== FORMULA_VERSION) {
          await backfillBirthdayLinks(s);
        }
        if (ensureBirthdayAllocationStampedSync(s, v)) {
          const written = await setCachedSummaryIfUnchanged(r.date, s, expectedSummary);
          if (!written) {
            console.info(`[Funtopia] Skipped stale birthday allocation cache write for ${r.date}`);
          }
        }
      }
    } catch (e) {
      console.warn("[funtopia] setBirthdayAllocation: cache restamp failed:", e);
    }
  }
}

/**
 * If allocation === "events", move min(partyFnbRevenue, F&B revenue) from
 * the "F&B" category into "Events / Birthdays". Returns the (possibly new)
 * categoryBreakdown plus the amount moved. Pure function — does not mutate.
 */
export function applyBirthdayAllocationToCategoryBreakdown<
  T extends Record<string, { revenue: number; quantity?: number; items?: any[]; subCategories?: any }>,
>(
  categoryBreakdown: T,
  partyFnbRevenue: number,
  allocation: BirthdayAllocation,
): { categoryBreakdown: T; movedAmount: number } {
  if (allocation !== "events" || !partyFnbRevenue || partyFnbRevenue <= 0) {
    return { categoryBreakdown, movedAmount: 0 };
  }
  const fnb = categoryBreakdown["F&B"];
  if (!fnb || !(fnb.revenue > 0)) {
    return { categoryBreakdown, movedAmount: 0 };
  }
  const moved = Math.min(partyFnbRevenue, fnb.revenue);
  if (moved <= 0) return { categoryBreakdown, movedAmount: 0 };
  const events = categoryBreakdown["Events / Birthdays"] || { revenue: 0, quantity: 0, items: [] };
  const next: any = { ...categoryBreakdown };
  next["F&B"] = { ...fnb, revenue: fnb.revenue - moved };
  next["Events / Birthdays"] = { ...events, revenue: (events.revenue || 0) + moved };
  return { categoryBreakdown: next as T, movedAmount: moved };
}

/**
 * Make sure `s.categoryBreakdown` reflects the current floresta birthday
 * allocation, and stamp `s.birthdayAllocation` / `s.birthdayMovedAmount`
 * accordingly. Idempotent: a no-op when the stamp already matches the
 * requested allocation. Reverses any previously applied movement (using the
 * stored `birthdayMovedAmount`) before applying the new one. Returns true
 * iff the summary was modified and should be persisted.
 */
export function ensureBirthdayAllocationStampedSync(
  s: DailySummary,
  desired: BirthdayAllocation,
): boolean {
  const prev: BirthdayAllocation = s.birthdayAllocation === "events" ? "events" : "fnb";
  const prevMoved = s.birthdayMovedAmount || 0;
  let cb = s.categoryBreakdown || ({} as Record<string, CategoryBreakdownEntry>);
  let changed = false;

  // Step 1: revert any prior allocation back to base ("fnb")
  if (prev === "events" && prevMoved > 0 && cb["F&B"] && cb["Events / Birthdays"]) {
    cb = {
      ...cb,
      "F&B": { ...cb["F&B"], revenue: cb["F&B"].revenue + prevMoved },
      "Events / Birthdays": {
        ...cb["Events / Birthdays"],
        revenue: cb["Events / Birthdays"].revenue - prevMoved,
      },
    };
    changed = true;
  }

  // Step 2: apply the desired allocation
  const partyFnb = s.birthdayLinks?.partyFnbRevenue || 0;
  const { categoryBreakdown: nextCb, movedAmount } =
    applyBirthdayAllocationToCategoryBreakdown(cb, partyFnb, desired);

  if (changed || nextCb !== cb) {
    s.categoryBreakdown = nextCb;
  }
  if (s.birthdayAllocation !== desired || (s.birthdayMovedAmount || 0) !== movedAmount) {
    s.birthdayAllocation = desired;
    s.birthdayMovedAmount = movedAmount;
    changed = true;
  }
  // `combinedBirthdayTotal` is a display total, not an additional category.
  // When allocation is "events", the moved F&B is already included in the
  // Events / Birthdays bucket, so adding all linked F&B again would double
  // count it. Keep the cached daily value consistent with the category state.
  if (s.birthdayLinks) {
    const eventsRevenue = s.categoryBreakdown?.["Events / Birthdays"]?.revenue || 0;
    const combined = eventsRevenue + (s.birthdayLinks.partyFnbRevenue || 0) - movedAmount;
    if (s.birthdayLinks.combinedBirthdayTotal !== combined) {
      s.birthdayLinks.combinedBirthdayTotal = combined;
      changed = true;
    }
  }
  return changed;
}

export async function clearAllFuntopiaSummaryCache(): Promise<number> {
  const res = await pool.query(`
    UPDATE funtopia_daily_cache
    SET summary_json = jsonb_set(summary_json, '{sourceBreakdown}', '[]'::jsonb)
    WHERE date != '__meta__'
  `);
  return res.rowCount || 0;
}

/**
 * One-time meta flag stored in funtopia_daily_cache(date='__meta__'). Used to
 * gate idempotent migrations like "wallet-pass backfill done".
 */
async function readMetaFlag(key: string): Promise<boolean> {
  try {
    const res = await pool.query(
      `SELECT summary_json FROM funtopia_daily_cache WHERE date = '__meta__'`,
    );
    const meta = res.rows[0]?.summary_json || {};
    return !!meta[key];
  } catch {
    return false;
  }
}

async function setMetaFlag(key: string, value: boolean): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO funtopia_daily_cache (date, summary_json, synced_at)
       VALUES ('__meta__', $1::jsonb, NOW())
       ON CONFLICT (date) DO UPDATE SET
         summary_json = COALESCE(funtopia_daily_cache.summary_json, '{}'::jsonb) || $1::jsonb,
         synced_at = NOW()`,
      [JSON.stringify({ [key]: value })],
    );
  } catch (e) {
    console.warn(`[Funtopia] Failed to set meta flag ${key}:`, e);
  }
}

/**
 * Backfill wallet-pass usage data for any historical date that has raw orders
 * but no wallet-pass records yet. This is what makes the channel attribution
 * (Airport / School / Mascot / Sales Booth / Tops Daily / Department Store /
 * Review Rewards) light up retroactively for old dates.
 *
 * Designed to be run in the background on server startup AND as an idempotent
 * admin-triggered endpoint. Caps the per-run scope so we don't hammer Pisell.
 */
export async function backfillWalletPasses(options?: {
  maxDates?: number;
  daysBack?: number;
  onProgress?: (msg: string) => void;
}): Promise<{ processed: number; skipped: number; failed: number; dates: string[] }> {
  await ensureCacheTable();
  if (!isFuntopiaConfigured()) {
    return { processed: 0, skipped: 0, failed: 0, dates: [] };
  }
  const maxDates = options?.maxDates ?? 200;
  const daysBack = options?.daysBack ?? 365;
  const onProgress = options?.onProgress;

  // Find dates with raw orders but no wallet-pass coverage yet
  const res = await pool.query(
    `SELECT DISTINCT o.order_date
       FROM funtopia_raw_orders o
       LEFT JOIN funtopia_raw_wallet_passes wp ON wp.order_date = o.order_date
      WHERE o.order_date >= (CURRENT_DATE - $1::int * INTERVAL '1 day')::text
        AND wp.order_date IS NULL
      ORDER BY o.order_date DESC
      LIMIT $2`,
    [daysBack, maxDates],
  );
  const dates: string[] = res.rows.map((r: any) => r.order_date);
  if (dates.length === 0) {
    return { processed: 0, skipped: 0, failed: 0, dates: [] };
  }

  if (onProgress) onProgress(`[wallet-pass backfill] ${dates.length} date(s) need backfill`);
  console.log(`[Funtopia] Wallet-pass backfill: ${dates.length} date(s) needed`);

  let processed = 0;
  let failed = 0;
  for (const dateStr of dates) {
    try {
      const startAt = `${dateStr} 00:00:00`;
      const endAt = `${dateStr} 23:59:59`;
      const result = await fetchAllPages("order_wallet_pass_usage_information", startAt, endAt);
      await storeWalletPasses(dateStr, result.items || []);
      processed += 1;
      if (onProgress) onProgress(`[wallet-pass backfill] ${dateStr}: stored ${result.items.length} entries`);
      // gentle pacing — Pisell rate limit
      await new Promise((r) => setTimeout(r, 500));
    } catch (err: any) {
      failed += 1;
      console.warn(`[Funtopia] Wallet-pass backfill failed for ${dateStr}: ${err.message}`);
      // Brief back-off on failure
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // After backfill, clear cached source breakdowns so they regenerate from the new data
  if (processed > 0) {
    const cleared = await clearAllFuntopiaSummaryCache();
    console.log(`[Funtopia] Wallet-pass backfill complete: processed=${processed}, failed=${failed}, cleared ${cleared} cached source breakdowns`);
    if (onProgress) onProgress(`[wallet-pass backfill] done: ${processed} succeeded, ${failed} failed, cleared ${cleared} cached breakdowns`);
  }

  return { processed, skipped: 0, failed, dates };
}

/**
 * Fire-and-forget startup hook: runs the wallet-pass backfill in the background
 * once on server start. Safe to call repeatedly — only processes dates that
 * still need backfilling.
 */
export async function backfillWalletPassesOnStartup(): Promise<void> {
  if (!isFuntopiaConfigured()) return;
  // Always invalidate stale source breakdowns once, so the new "Walk-in" naming and
  // strict-channel logic take effect on the first dashboard load after deploy.
  const migrated = await readMetaFlag("walk_in_rename_v1");
  if (!migrated) {
    const cleared = await clearAllFuntopiaSummaryCache();
    await setMetaFlag("walk_in_rename_v1", true);
    console.log(`[Funtopia] Migrated source breakdowns to Walk-in naming — cleared ${cleared} caches`);
  }

  // Clean up duplicate order rows left behind by the old delete-by-date-only
  // storeRawOrders flow (see #5228889). Idempotent + cheap on subsequent boots.
  try {
    await cleanupDuplicateOrdersOnStartup();
  } catch (e) {
    console.warn("[Funtopia] cleanupDuplicateOrdersOnStartup error:", e);
  }

  // task-139 (v26): Load + backfill the product registry so SKU classifications
  // are anchored to Pisell's stable product_id rather than re-matched on every
  // read. Idempotent on subsequent boots.
  try {
    await initProductRegistryOnStartup();
  } catch (e) {
    console.warn("[Funtopia] initProductRegistryOnStartup error:", e);
  }

  try {
    await backfillWalletPasses({ maxDates: 200, daysBack: 365 });
  } catch (e) {
    console.warn("[Funtopia] Wallet-pass startup backfill error:", e);
  }
}

export interface DiscoveredVoucherFaceValue {
  face_value: number;
  times_used: number;
  total_value: number;
  first_seen: string | null;
  last_seen: string | null;
}

export async function discoverVoucherFaceValues(daysBack = 180): Promise<DiscoveredVoucherFaceValue[]> {
  await ensureCacheTable();
  const res = await pool.query(`
    SELECT
      pay_amount AS face_value,
      COUNT(*)::int AS times_used,
      ROUND(SUM(pay_amount)::numeric, 2) AS total_value,
      MIN(payment_at) AS first_seen,
      MAX(payment_at) AS last_seen
    FROM funtopia_raw_payments
    WHERE pay_method = 'Voucher'
      AND order_date >= TO_CHAR(NOW() - ($1 || ' days')::interval, 'YYYY-MM-DD')
      AND pay_amount > 0
    GROUP BY pay_amount
    ORDER BY times_used DESC, pay_amount DESC
  `, [String(daysBack)]);
  return res.rows.map((r: any) => ({
    face_value: parseFloat(r.face_value) || 0,
    times_used: parseInt(r.times_used) || 0,
    total_value: parseFloat(r.total_value) || 0,
    first_seen: r.first_seen || null,
    last_seen: r.last_seen || null,
  }));
}

export interface WalletPassEntry {
  order_id: string;
  title: string;
  code: string | null;
  code_type: string | null;
  action: string | null;
  redeem_amount: number;
}

/**
 * Store wallet-pass usage records (voucher titles per order) for a given date.
 * Replaces any existing records for that date so re-syncs are idempotent.
 */
export async function storeWalletPasses(dateStr: string, items: any[]): Promise<void> {
  await initCacheTable();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM funtopia_raw_wallet_passes WHERE order_date = $1", [dateStr]);
    const BATCH_SIZE = 100;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;
      const COLS = 9;
      for (const wp of batch) {
        const ph = Array.from({ length: COLS }, (_, k) => `$${paramIdx + k}`).join(", ");
        placeholders.push(`(${ph})`);
        values.push(
          String(wp.order_id || ""),
          dateStr,
          wp.title || null,
          wp.code || null,
          wp.code_type || null,
          wp.action || null,
          parseFloat(wp.redeem_amount) || 0,
          JSON.stringify(wp),
          new Date().toISOString(),
        );
        paramIdx += COLS;
      }
      if (placeholders.length === 0) continue;
      await client.query(
        `INSERT INTO funtopia_raw_wallet_passes (order_id, order_date, title, code, code_type, action, redeem_amount, raw_json, synced_at)
         VALUES ${placeholders.join(", ")}`,
        values,
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[Funtopia] Failed to store wallet passes for ${dateStr}:`, err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Build a Map<order_id, voucher_titles[]> from wallet-pass records, considering
 * only entries that represent actual voucher REDEMPTIONS on an order.
 *
 * Pisell emits redeem_amount as a NEGATIVE number when a voucher is consumed
 * (the customer's wallet balance went down). Positive values represent
 * top-ups / refunds and must NOT be counted as a redemption against the order
 * — otherwise we'd misattribute the order to a channel.
 *
 * This is the source-of-truth for assigning a Floresta order to a marketing
 * channel — the voucher title (e.g. "Airport 250 (Discount QR)") is what
 * carries the channel name, and we let the sourceRegistry do the matching.
 */
function toFiniteNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return isFinite(value) ? value : NaN;
  if (typeof value === "string") {
    const n = Number(value);
    return isFinite(n) ? n : NaN;
  }
  return NaN;
}

export function indexRedeemedTitlesByOrder(
  walletPasses: Array<{
    order_id: string;
    title: string | null;
    action: string | null;
    redeem_amount: number | string;
    code?: string | null;
  }>,
): Map<string, Array<{ title: string; code: string }>> {
  const m = new Map<string, Array<{ title: string; code: string }>>();
  for (const wp of walletPasses) {
    const action = (wp.action || "").trim().toLowerCase();
    const isRedeem = action === "redeem" || action === "customer redeem";
    if (!isRedeem) continue;
    // Pisell field drift (June 2026): redeem records used to carry a NEGATIVE
    // redeem_amount; since June they arrive with redeem_amount = 0.00, which
    // the old `amount >= 0` filter silently dropped — Sales Booth / Mascot
    // revenue vanished from the dashboard after May. The action field
    // ("redeem" / "customer redeem") is the reliable redemption signal, so we
    // now only reject records with a clearly POSITIVE amount (top-ups/refunds)
    // and accept negative, zero, or missing amounts.
    const amount = toFiniteNumber(wp.redeem_amount);
    if (isFinite(amount) && amount > 0) continue;
    const title = (wp.title || "").trim();
    const code = (wp.code || "").trim();
    if (!title && !code) continue;
    const orderId = String(wp.order_id || "");
    if (!orderId) continue;
    const arr = m.get(orderId) || [];
    arr.push({ title, code });
    m.set(orderId, arr);
  }
  return m;
}

/**
 * Attribute FULL ORDER REVENUE to QR-campaign channels based on the voucher face values used in each order.
 *
 * For each paid order:
 *   1. Look at every voucher payment on that order; map each face value to its channel(s) via voucherChannelMap.
 *   2. Skip face values flagged as ignored (e.g. ฿350 generic F&B voucher).
 *   3. Collect the union of mapped channels for the order. If empty -> order is unattributed and skipped.
 *   4. Split the order's revenue / order-count / voucher-discount evenly across all matched channels.
 *      (Ambiguous face values like ฿250 = Airport AND School default to 50/50 split.)
 *
 * The returned breakdown matches the SourceBreakdownEntry shape (source/orders/revenue/discount/variants),
 * so it can be merged directly with discount-name based attribution from buildSourceBreakdown.
 */
export function attributeOrdersByVoucherChannels(
  orders: Array<{ order_id: string; revenue: number }>,
  voucherPaymentsByOrderId: Map<string, Array<{ amount: number }>>,
  voucherChannelMap: Map<string, VoucherChannelMapEntry>,
): SourceBreakdownEntry[] {
  if (!voucherChannelMap || voucherChannelMap.size === 0) return [];

  type Bucket = {
    orders: number;
    revenue: number;
    discount: number;
    variants: Map<string, { name: string; orders: number; revenue: number; discount: number }>;
  };
  const channelBuckets = new Map<string, Bucket>();

  for (const order of orders) {
    const vouchers = voucherPaymentsByOrderId.get(order.order_id) || [];
    if (vouchers.length === 0) continue;

    const matchedChannels = new Set<string>();
    let totalVoucherAmount = 0;
    const variantsForOrder = new Map<string, number>(); // face-value-key -> total amount

    for (const v of vouchers) {
      if (v.amount <= 0) continue;
      const key = formatFaceValue(v.amount);
      const mapping = voucherChannelMap.get(key);
      if (!mapping || mapping.ignored || mapping.channels.length === 0) continue;
      for (const ch of mapping.channels) matchedChannels.add(ch);
      totalVoucherAmount += v.amount;
      variantsForOrder.set(key, (variantsForOrder.get(key) || 0) + v.amount);
    }

    if (matchedChannels.size === 0) continue;
    const shareCount = matchedChannels.size;
    const orderShare = 1 / shareCount;
    const revenueShare = order.revenue / shareCount;
    const discountShare = totalVoucherAmount / shareCount;

    for (const channel of matchedChannels) {
      let bucket = channelBuckets.get(channel);
      if (!bucket) {
        bucket = { orders: 0, revenue: 0, discount: 0, variants: new Map() };
        channelBuckets.set(channel, bucket);
      }
      bucket.orders += orderShare;
      bucket.revenue += revenueShare;
      bucket.discount += discountShare;

      // Per-variant rollup so the UI can show "฿250 voucher (3 orders, ฿4,200 revenue)"
      for (const [faceKey, vAmount] of variantsForOrder.entries()) {
        const mapping = voucherChannelMap.get(faceKey);
        if (!mapping || !mapping.channels.includes(channel)) continue;
        const variantName = `฿${faceKey} voucher`;
        const variantOrderShare = orderShare;
        const variantRevenueShare = revenueShare / variantsForOrder.size;
        const variantDiscountShare = vAmount / shareCount;
        const existing = bucket.variants.get(variantName);
        if (existing) {
          existing.orders += variantOrderShare;
          existing.revenue += variantRevenueShare;
          existing.discount += variantDiscountShare;
        } else {
          bucket.variants.set(variantName, {
            name: variantName,
            orders: variantOrderShare,
            revenue: variantRevenueShare,
            discount: variantDiscountShare,
          });
        }
      }
    }
  }

  const out: SourceBreakdownEntry[] = [];
  for (const [source, bucket] of channelBuckets.entries()) {
    out.push({
      source,
      orders: Math.round(bucket.orders * 100) / 100,
      revenue: Math.round(bucket.revenue * 100) / 100,
      discount: Math.round(bucket.discount * 100) / 100,
      variants: Array.from(bucket.variants.values()).map((v) => ({
        name: v.name,
        orders: Math.round(v.orders * 100) / 100,
        revenue: Math.round(v.revenue * 100) / 100,
        discount: Math.round(v.discount * 100) / 100,
      })),
    });
  }
  // Sort by revenue desc
  out.sort((a, b) => b.revenue - a.revenue);
  return out;
}

/**
 * Seed the user-confirmed initial mappings if the table is empty.
 * User spec (Apr 2026):
 *   - ฿250 -> Airport AND School (ambiguous, split 50/50)
 *   - ฿150 -> Mascot
 *   - ฿100 -> Review Rewards
 *   - ฿1000 -> Staff Rewards
 *   - ฿350 -> Ignored (generic F&B credit, not a campaign)
 * Idempotent: only inserts when mapping is absent for a given face_value.
 */
export async function seedInitialVoucherChannelMappings(): Promise<{ seeded: number }> {
  await ensureCacheTable();
  const seeds: Array<{ faceValue: number; channels: string[]; ignored: boolean; note: string }> = [
    { faceValue: 250, channels: ["Airport", "School"], ignored: false, note: "Same face value used by both campaigns; revenue split 50/50" },
    { faceValue: 150, channels: ["Mascot"], ignored: false, note: "" },
    { faceValue: 100, channels: ["Review Rewards"], ignored: false, note: "" },
    { faceValue: 1000, channels: ["Staff Rewards"], ignored: false, note: "" },
    { faceValue: 350, channels: [], ignored: true, note: "Generic F&B voucher, not a marketing channel" },
    // Indian package face values — seeded so they show in Config even before any
    // voucher payments are observed. Channels left empty so an admin chooses the
    // sales channel (e.g. an OTA partner) before attribution kicks in.
    { faceValue: 690, channels: [], ignored: false, note: "Indian 1+1 package (1hr) — pick the sales channel when these go on sale" },
    { faceValue: 890, channels: [], ignored: false, note: "Indian 1+1 package (2hr) — pick the sales channel when these go on sale" },
    { faceValue: 1090, channels: [], ignored: false, note: "Indian 1+1 package (Full-day) — pick the sales channel when these go on sale" },
  ];
  let seeded = 0;
  for (const s of seeds) {
    const existing = await pool.query(`SELECT 1 FROM funtopia_voucher_channel_map WHERE face_value = $1`, [s.faceValue]);
    if (existing.rows.length > 0) continue;
    await upsertVoucherChannelMapping(s.faceValue, s.channels, s.ignored, s.note);
    seeded++;
  }
  return { seeded };
}

async function ensureCashReportsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_daily_revenue (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      branch TEXT NOT NULL,
      reception_count NUMERIC(12,2) DEFAULT 0,
      cafe_count NUMERIC(12,2) DEFAULT 0,
      cash_income NUMERIC(12,2) DEFAULT 0,
      actual_revenue NUMERIC(12,2) DEFAULT 0,
      source TEXT DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(date, branch)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_daily_revenue_date ON funtopia_daily_revenue(date)`);
}

async function ensureCalendarNotesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_calendar_notes (
      date TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureLockedMonthsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_locked_months (
      month TEXT PRIMARY KEY,
      locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureSyncHealthTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_sync_health (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'clean',
      orders_expected INT DEFAULT 0,
      orders_received INT DEFAULT 0,
      products_expected INT DEFAULT 0,
      products_received INT DEFAULT 0,
      payments_expected INT DEFAULT 0,
      payments_received INT DEFAULT 0,
      error_message TEXT,
      warnings JSONB
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_sync_health_date ON funtopia_sync_health(date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_funtopia_sync_health_synced_at ON funtopia_sync_health(synced_at)`);
}

export async function getLockedMonths(): Promise<string[]> {
  await ensureLockedMonthsTable();
  const result = await pool.query(`SELECT month FROM funtopia_locked_months ORDER BY month`);
  return result.rows.map((r: any) => r.month);
}

export async function setLockedMonths(months: string[]): Promise<void> {
  await ensureLockedMonthsTable();
  await pool.query(`DELETE FROM funtopia_locked_months`);
  for (const m of months) {
    await pool.query(`INSERT INTO funtopia_locked_months (month) VALUES ($1) ON CONFLICT DO NOTHING`, [m]);
  }
}

export function isDateInLockedMonth(dateStr: string, lockedMonths: string[]): boolean {
  const month = dateStr.substring(0, 7);
  return lockedMonths.includes(month);
}

let cacheTableReady = false;
async function initCacheTable() {
  if (!cacheTableReady) {
    await ensureCacheTable();
    await ensureCashReportsTable();
    await ensureCalendarNotesTable();
    await ensureLockedMonthsTable();
    await ensureSyncHealthTable();
    cacheTableReady = true;
  }
}

export async function getCalendarNotes(startDate: string, endDate: string): Promise<Record<string, string>> {
  await initCacheTable();
  const result = await pool.query(
    "SELECT date, note FROM funtopia_calendar_notes WHERE date >= $1 AND date <= $2 AND note != ''",
    [startDate, endDate]
  );
  const notes: Record<string, string> = {};
  for (const row of result.rows) {
    notes[row.date] = row.note;
  }
  return notes;
}

export async function saveCalendarNote(date: string, note: string): Promise<void> {
  await initCacheTable();
  if (!note.trim()) {
    await pool.query("DELETE FROM funtopia_calendar_notes WHERE date = $1", [date]);
    return;
  }
  await pool.query(
    `INSERT INTO funtopia_calendar_notes (date, note, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (date) DO UPDATE SET note = $2, updated_at = NOW()`,
    [date, note.trim()]
  );
}

async function getCachedSummary(date: string): Promise<DailySummary | null> {
  await initCacheTable();
  const result = await pool.query("SELECT summary_json FROM funtopia_daily_cache WHERE date = $1", [date]);
  if (result.rows.length === 0) return null;
  return result.rows[0].summary_json as DailySummary;
}

export async function setCachedSummaryIfUnchanged(
  date: string,
  summary: DailySummary,
  expectedSummary: DailySummary,
): Promise<boolean> {
  await initCacheTable();
  const result = await pool.query(
    `UPDATE funtopia_daily_cache
     SET synced_at = NOW(), summary_json = $2
     WHERE date = $1 AND summary_json = $3::jsonb
     RETURNING date`,
    [date, JSON.stringify(summary), JSON.stringify(expectedSummary)],
  );
  return result.rowCount === 1;
}

async function setCachedSummary(date: string, summary: DailySummary): Promise<void> {
  await initCacheTable();
  await pool.query(
    `INSERT INTO funtopia_daily_cache (date, synced_at, summary_json)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (date) DO UPDATE SET synced_at = NOW(), summary_json = $2`,
    [date, JSON.stringify(summary)]
  );
}

type FuntopiaLockClient = Awaited<ReturnType<typeof pool.connect>>;
const FUNTOPIA_API_SYNC_LOCK = "funtopia:api-sync";

async function acquireFuntopiaApiSyncLock(): Promise<FuntopiaLockClient> {
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1))",
      [FUNTOPIA_API_SYNC_LOCK],
    );
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function releaseFuntopiaApiSyncLock(client: FuntopiaLockClient): Promise<void> {
  let destroyClient = false;
  try {
    const result = await client.query(
      "SELECT pg_advisory_unlock(hashtext($1)) AS unlocked",
      [FUNTOPIA_API_SYNC_LOCK],
    );
    destroyClient = result.rows[0]?.unlocked !== true;
    if (destroyClient) {
      console.error("[Funtopia] API sync advisory lock was not owned; destroying database client");
    }
  } catch (error) {
    destroyClient = true;
    console.error("[Funtopia] Failed to release API sync advisory lock; destroying database client", error);
  } finally {
    client.release(destroyClient);
  }
}

async function storeRawOrders(
  dateStr: string,
  orders: any[],
  products: any[],
  payments: any[]
): Promise<void> {
  await initCacheTable();

  const uniqueOrdersResult = latestOrderRows(orders);
  const uniqueOrders = uniqueOrdersResult.rows;
  if (uniqueOrdersResult.dropped > 0) {
    console.warn(
      `[Funtopia] storeRawOrders ${dateStr}: dropped ${uniqueOrdersResult.dropped} duplicate order row(s) from incoming Pisell response.`,
    );
  }

  const paymentMap = new Map<string, string>();
  for (const p of payments) {
    if (p.order_id) {
      paymentMap.set(p.order_id, p.pay_method || p.payment_name || "Other");
    }
  }

  const orderChannelMap = new Map<string, string>();
  for (const o of uniqueOrders) {
    if (o.order_id) {
      // Pisell added `order_sales_channel` to order_basic_information in
      // May 2026; use it as source-of-truth and fall back to legacy fields
      // for older orders that pre-date the API change.
      orderChannelMap.set(o.order_id, o.order_sales_channel || o.source || o.channel || "Terminal");
    }
  }

  // Collect incoming order_ids so we can also remove any stale rows that the
  // POS previously emitted for the same order under a DIFFERENT order_date
  // (happens when a partial payment is settled days later and Pisell flips
  // the order's "current" date). Without this, we'd leave orphan rows behind
  // and headline revenue would double-count via JOINs (see #5228889).
  const incomingOrderIds = Array.from(new Set(
    uniqueOrders.map((o) => String(o.order_id || "")).filter((id) => id.length > 0)
  ));

  // Pisell may repeat a payment within one response. Collapse only rows with a
  // stable payment id; ID-less rows remain distinct because matching fields do
  // not safely prove they are the same real payment.
  const seenPaymentKeys = new Set<string>();
  const dedupedPayments: any[] = [];
  let droppedDuplicatePayments = 0;
  for (const [paymentIndex, p] of payments.entries()) {
    const pisellId = p?.id ?? p?.payment_id;
    const key = pisellId != null
      ? `id:${String(pisellId)}`
      : `unkeyed:${paymentIndex}`;
    if (seenPaymentKeys.has(key)) {
      droppedDuplicatePayments++;
      continue;
    }
    seenPaymentKeys.add(key);
    dedupedPayments.push(p);
  }
  if (droppedDuplicatePayments > 0) {
    console.log(`[Funtopia] storeRawOrders ${dateStr}: dropped ${droppedDuplicatePayments} duplicate payment row(s) from incoming Pisell response.`);
  }
  const incomingPaymentIds = dedupedPayments
    .map((p) => p?.id ?? p?.payment_id)
    .filter((id) => id != null && String(id).trim())
    .map(String);

  const client = await pool.connect();
  let staleDates: string[] = [];
  let staleOrderRows = 0;
  let staleLineItemRows = 0;
  try {
    await client.query("BEGIN");
    // Cross-process transaction lock: development, production, the interval
    // worker, and a manual sync can share this database. Without this lock,
    // two DELETE-then-INSERT transactions can both leave their order inserts
    // behind even though products/payments are subsequently replaced.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      ["funtopia:store-raw-orders"],
    );

    await client.query("DELETE FROM funtopia_raw_orders WHERE order_date = $1", [dateStr]);
    await client.query("DELETE FROM funtopia_orders WHERE order_date = $1", [dateStr]);
    // Pisell's day snapshots are not authoritative payment ledgers: a payment
    // can appear in one response and be omitted from a later response. Preserve
    // all stable-ID payments as versioned history. Legacy ID-less rows cannot
    // be reconciled safely, so keep replacement semantics for those only.
    await client.query(
      `DELETE FROM funtopia_raw_payments
       WHERE order_date = $1
         AND NULLIF(COALESCE(raw_json->>'id', raw_json->>'payment_id'), '') IS NULL`,
      [dateStr],
    );
    if (incomingPaymentIds.length > 0) {
      // Replace only payment ids actually present in this snapshot. IDs omitted
      // by Pisell stay stored; ids returned again receive their newest
      // refund/status fields without creating duplicates.
      await client.query(
        `DELETE FROM funtopia_raw_payments
         WHERE COALESCE(raw_json->>'id', raw_json->>'payment_id') = ANY($1::text[])`,
        [incomingPaymentIds],
      );
    }

    if (incomingOrderIds.length > 0) {
      // Find which OTHER dates currently hold rows for these order_ids — we'll
      // need to invalidate their cached summaries after the transaction so the
      // dashboard reflects the moved order on next read.
      const staleRes = await client.query(
        `SELECT DISTINCT order_date
         FROM funtopia_raw_orders
         WHERE order_id = ANY($1::text[]) AND order_date != $2`,
        [incomingOrderIds, dateStr]
      );
      staleDates = staleRes.rows.map((r: any) => r.order_date);

      // Delete stale order rows (and their attached line items). Payments are
      // owned by the date the payment actually occurred, so we leave them
      // alone — buildSummaryFromDatabase already does a cross-date lookup to
      // find the order behind a payment row.
      const delOrders = await client.query(
        `DELETE FROM funtopia_raw_orders
         WHERE order_id = ANY($1::text[]) AND order_date != $2`,
        [incomingOrderIds, dateStr]
      );
      const delItems = await client.query(
        `DELETE FROM funtopia_orders
         WHERE order_id = ANY($1::text[]) AND order_date != $2`,
        [incomingOrderIds, dateStr]
      );
      staleOrderRows = delOrders.rowCount || 0;
      staleLineItemRows = delItems.rowCount || 0;
    }

    const BATCH_SIZE = 100;

    for (let i = 0; i < uniqueOrders.length; i += BATCH_SIZE) {
      const batch = uniqueOrders.slice(i, i + BATCH_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;
      const COLS = 16;

      for (const o of batch) {
        const ph = Array.from({ length: COLS }, (_, k) => `$${paramIdx + k}`).join(", ");
        placeholders.push(`(${ph})`);
        values.push(
          o.order_id || "",
          dateStr,
          o.order_code || null,
          o.payment_status || null,
          parseFloat(o.total_amount) || 0,
          parseFloat(o.product_discount) || 0,
          parseFloat(o.order_discount) || 0,
          o.created_at || null,
          o.source || null,
          o.order_sales_channel || o.channel || null,
          o.customer_name || o.guest_name || null,
          o.customer_phone || o.guest_phone || null,
          o.customer_email || o.guest_email || null,
          o.note || o.remark || o.order_notes || null,
          JSON.stringify(o),
          new Date().toISOString()
        );
        paramIdx += COLS;
      }

      await client.query(
        `INSERT INTO funtopia_raw_orders (order_id, order_date, order_code, payment_status, total_amount, product_discount, order_discount, created_at, source, channel, customer_name, customer_phone, customer_email, note, raw_json, synced_at)
         VALUES ${placeholders.join(", ")}`,
        values
      );
    }

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;
      const COLS = 15;

      for (const p of batch) {
        const ph = Array.from({ length: COLS }, (_, k) => `$${paramIdx + k}`).join(", ");
        placeholders.push(`(${ph})`);
        values.push(
          p.order_id || "",
          dateStr,
          p.created_at || null,
          p.product_id || null,
          p.variant_id || null,
          p.product_name || p.product_title || p.name || "Unknown",
          p.category_title || p.category || null,
          parseInt(p.product_quantity || p.quantity) || 1,
          parseFloat(p.price || p.product_price) || 0,
          parseFloat(p.payment_price || p.subtotal) || 0,
          parseFloat(p.product_discount) || 0,
          parseFloat(p.tax) || 0,
          paymentMap.get(p.order_id) || null,
          orderChannelMap.get(p.order_id) || "Terminal",
          JSON.stringify(p)
        );
        paramIdx += COLS;
      }

      await client.query(
        `INSERT INTO funtopia_orders (order_id, order_date, created_at, product_id, variant_id, product_name, product_category, quantity, unit_price, subtotal, discount, tax, payment_method, sales_channel, raw_json)
         VALUES ${placeholders.join(", ")}`,
        values
      );
    }

    for (let i = 0; i < dedupedPayments.length; i += BATCH_SIZE) {
      const batch = dedupedPayments.slice(i, i + BATCH_SIZE);
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;
      const COLS = 10;

      for (const p of batch) {
        const ph = Array.from({ length: COLS }, (_, k) => `$${paramIdx + k}`).join(", ");
        placeholders.push(`(${ph})`);
        values.push(
          p.order_id || "",
          dateStr,
          p.pay_method || null,
          p.payment_name || null,
          parseFloat(p.pay_amount) || 0,
          parseFloat(p.refund_amount) || 0,
          parseFloat(p.payment_surcharge) || 0,
          p.payment_at || p.created_at || null,
          JSON.stringify(p),
          new Date().toISOString()
        );
        paramIdx += COLS;
      }

      await client.query(
        `INSERT INTO funtopia_raw_payments (order_id, order_date, pay_method, payment_name, pay_amount, refund_amount, payment_surcharge, payment_at, raw_json, synced_at)
         VALUES ${placeholders.join(", ")}`,
        values
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[Funtopia] Failed to store raw orders for ${dateStr}:`, err);
    throw err;
  } finally {
    client.release();
  }

  // After the transaction, surface any cross-date order moves and rebuild
  // the cached daily summaries for the dates that lost their copy of the
  // order, so the dashboard reflects corrected numbers on next load. We
  // rebuild rather than just delete because getDateRangeSummary reads from
  // the cache only — a missing cache row would make the date show ฿0.
  if (staleOrderRows > 0 || staleLineItemRows > 0) {
    console.log(
      `[Funtopia] storeRawOrders ${dateStr}: merged ${staleOrderRows} stale order row(s) ` +
      `and ${staleLineItemRows} stale line-item row(s) from previous date(s) [${staleDates.join(", ")}] ` +
      `into the new sync (cross-date order move, e.g. partial payment settled later).`
    );
    for (const staleDate of staleDates) {
      try {
        const rebuilt = await buildSummaryFromDatabase(staleDate);
        await setCachedSummary(staleDate, rebuilt);
      } catch (e) {
        console.warn(`[Funtopia] Failed to rebuild daily summary for ${staleDate}:`, e);
      }
    }
  }
}

/**
 * One-time cleanup: removes duplicate rows from funtopia_raw_orders /
 * funtopia_orders / funtopia_raw_payments that were left behind by the old
 * delete-by-date-only storeRawOrders flow.
 *
 * Two failure modes are addressed:
 *   1) An order's order_date shifted (e.g. partial payment settled days
 *      later) and the same order_id ended up in funtopia_raw_orders /
 *      funtopia_orders under multiple dates. We keep only the most recently
 *      synced order row per order_id and drop the rest (with their line
 *      items).
 *   2) The same Pisell payment row got inserted multiple times into
 *      funtopia_raw_payments (concurrent syncs racing, or the same date's
 *      sync re-running after a crash). We keep one row per Pisell payment
 *      id (raw_json->>'id'); for older rows lacking that field we fall back
 *      to a composite (order_id, payment_at, pay_amount, pay_method) key.
 *
 * The cached daily summaries for any affected dates are rebuilt so the
 * dashboard reflects corrected numbers on next load.
 *
 * Idempotent — safe to call repeatedly. Gated behind a meta flag so it
 * only does the heavy work once, but a fast sanity scan still runs every
 * boot so any future regression gets caught.
 */
export async function cleanupDuplicateOrdersOnStartup(): Promise<void> {
  await initCacheTable();
  const apiSyncLock = await acquireFuntopiaApiSyncLock();
  try {
  const alreadyRan = await readMetaFlag("dedup_orders_v1");

  // ---- Detection: orders + payments ----
  const [dupOrdersRes, dupPaymentsRes] = await Promise.all([
    pool.query(`
      SELECT order_id
      FROM funtopia_raw_orders
      WHERE order_date != '__meta__'
      GROUP BY order_id
      HAVING COUNT(*) > 1
    `),
    pool.query(`
      SELECT 1
      FROM funtopia_raw_payments
      WHERE order_date != '__meta__'
        AND NULLIF(COALESCE(raw_json->>'id', raw_json->>'payment_id'), '') IS NOT NULL
      GROUP BY COALESCE(raw_json->>'id', raw_json->>'payment_id')
      HAVING COUNT(*) > 1
      LIMIT 1
    `),
  ]);

  const hasDupOrders = (dupOrdersRes.rowCount || 0) > 0;
  const hasDupPayments = (dupPaymentsRes.rowCount || 0) > 0;

  if (!hasDupOrders && !hasDupPayments) {
    if (!alreadyRan) await setMetaFlag("dedup_orders_v1", true);
    return;
  }

  const dupOrderIds: string[] = dupOrdersRes.rows.map((r: any) => String(r.order_id));
  console.log(
    `[Funtopia] cleanupDuplicateOrders: found ${dupOrderIds.length} order_id(s) with multiple order rows; ` +
    `payments table has duplicates: ${hasDupPayments}. Cleaning up...`
  );

  const client = await pool.connect();
  let removedOrders = 0;
  let removedItems = 0;
  let removedPayments = 0;
  let affectedDates: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      ["funtopia:store-raw-orders"],
    );

    const datesAffected = new Set<string>();

    // ---- Step 1: dedupe orders + line items ----
    if (dupOrderIds.length > 0) {
      // First remove same-date copies created by overlapping DELETE-then-INSERT
      // syncs. Their line items are already a single valid snapshot, so only
      // the duplicated raw order rows should be removed.
      const delSameDateOrders = await client.query(`
        WITH ranked AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY order_id, order_date
              ORDER BY synced_at DESC, id DESC
            ) AS rn
          FROM funtopia_raw_orders
          WHERE order_id = ANY($1::text[])
        )
        DELETE FROM funtopia_raw_orders
        WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      `, [dupOrderIds]);
      removedOrders += delSameDateOrders.rowCount || 0;

      // For each duplicated order_id, find the order_date of the most recently
      // synced row — that's the row we keep. All other rows for that order_id
      // get removed (along with the corresponding line items).
      const keepRes = await client.query(
        `SELECT DISTINCT ON (order_id) order_id, order_date, synced_at
         FROM funtopia_raw_orders
         WHERE order_id = ANY($1::text[])
         ORDER BY order_id, synced_at DESC`,
        [dupOrderIds]
      );
      const keepDateByOrder = new Map<string, string>();
      for (const r of keepRes.rows) {
        keepDateByOrder.set(String(r.order_id), r.order_date);
      }

      for (const [orderId, keepDate] of keepDateByOrder) {
        const staleRowsRes = await client.query(
          `SELECT DISTINCT order_date FROM funtopia_raw_orders
           WHERE order_id = $1 AND order_date != $2`,
          [orderId, keepDate]
        );
        for (const r of staleRowsRes.rows) datesAffected.add(r.order_date);

        const delO = await client.query(
          `DELETE FROM funtopia_raw_orders
           WHERE order_id = $1 AND order_date != $2`,
          [orderId, keepDate]
        );
        const delI = await client.query(
          `DELETE FROM funtopia_orders
           WHERE order_id = $1 AND order_date != $2`,
          [orderId, keepDate]
        );
        removedOrders += delO.rowCount || 0;
        removedItems += delI.rowCount || 0;
        // The kept date's cache is also stale.
        datesAffected.add(keepDate);
      }
    }

    // ---- Step 2: dedupe payments ----
    // Keep the latest stored version per stable Pisell payment id so later
    // refund/status updates replace the original observation. ID-less rows are
    // deliberately preserved because two legitimate payments can share order,
    // time, amount, and method.
    const dupPayDatesRes = await client.query(`
      WITH keys AS (
        SELECT
          id,
          order_date,
          ROW_NUMBER() OVER (
             PARTITION BY COALESCE(raw_json->>'id', raw_json->>'payment_id')
             ORDER BY synced_at DESC, id DESC
          ) AS rn
        FROM funtopia_raw_payments
        WHERE order_date != '__meta__'
          AND NULLIF(COALESCE(raw_json->>'id', raw_json->>'payment_id'), '') IS NOT NULL
      )
      SELECT DISTINCT order_date FROM keys WHERE rn > 1
    `);
    for (const r of dupPayDatesRes.rows) datesAffected.add(r.order_date);

    const delP = await client.query(`
      WITH keys AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
             PARTITION BY COALESCE(raw_json->>'id', raw_json->>'payment_id')
             ORDER BY synced_at DESC, id DESC
          ) AS rn
        FROM funtopia_raw_payments
        WHERE order_date != '__meta__'
          AND NULLIF(COALESCE(raw_json->>'id', raw_json->>'payment_id'), '') IS NOT NULL
      )
      DELETE FROM funtopia_raw_payments
      WHERE id IN (SELECT id FROM keys WHERE rn > 1)
    `);
    removedPayments = delP.rowCount || 0;

    affectedDates = Array.from(datesAffected).sort();

    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be unhealthy */ }
    console.error(`[Funtopia] cleanupDuplicateOrders failed:`, err);
    return;
  } finally {
    // Single release point — releasing twice (e.g. once in catch + once in
    // finally) would throw on the second call.
    client.release();
  }

  let rebuiltCount = 0;
  for (const d of affectedDates) {
    try {
      const rebuilt = await buildSummaryFromDatabase(d);
      await setCachedSummary(d, rebuilt);
      rebuiltCount++;
    } catch (e) {
      console.warn(`[Funtopia] cleanupDuplicateOrders: failed to rebuild summary for ${d}:`, e);
    }
  }

  console.log(
    `[Funtopia] cleanupDuplicateOrders: removed ${removedOrders} duplicate order row(s), ` +
    `${removedItems} stale line-item row(s), and ${removedPayments} duplicate payment row(s); ` +
    `rebuilt ${rebuiltCount}/${affectedDates.length} cached daily summary(ies) [${affectedDates.join(", ")}]`
  );
  await setMetaFlag("dedup_orders_v1", true);
  } finally {
    await releaseFuntopiaApiSyncLock(apiSyncLock);
  }
}

async function getCachedDates(): Promise<string[]> {
  await initCacheTable();
  const result = await pool.query("SELECT date FROM funtopia_daily_cache WHERE date != '__meta__' ORDER BY date");
  return result.rows.map((r: any) => r.date);
}

async function getLastSyncInfo(): Promise<{ lastSyncedDate: string | null; lastSyncedAt: string | null; cachedDates: number; earliestDate: string | null; latestDate: string | null; lastFullSyncAt: string | null; lastQuickSyncAt: string | null; totalRawOrders: number }> {
  await initCacheTable();
  const [cacheResult, ordersResult] = await Promise.all([
    pool.query(`
      SELECT
        MIN(date) as earliest_date,
        MAX(date) as latest_date,
        MAX(synced_at) as last_synced_at,
        COUNT(*) as total_dates
      FROM funtopia_daily_cache
      WHERE date != '__meta__'
    `),
    pool.query("SELECT COUNT(*) as cnt FROM funtopia_orders"),
  ]);
  const row = cacheResult.rows[0];
  const totalRawOrders = parseInt(ordersResult.rows[0]?.cnt) || 0;

  let lastFullSyncAt: string | null = null;
  let lastQuickSyncAt: string | null = null;
  try {
    const metaResult = await pool.query(
      "SELECT summary_json FROM funtopia_daily_cache WHERE date = '__meta__'"
    );
    if (metaResult.rows.length > 0) {
      const meta = metaResult.rows[0].summary_json as any;
      lastFullSyncAt = meta?.lastFullSyncAt || null;
      lastQuickSyncAt = meta?.lastQuickSyncAt || null;
    }
  } catch {}

  return {
    lastSyncedDate: row.latest_date || null,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    cachedDates: parseInt(row.total_dates) || 0,
    earliestDate: row.earliest_date || null,
    latestDate: row.latest_date || null,
    lastFullSyncAt,
    lastQuickSyncAt,
    totalRawOrders,
  };
}

export async function setSyncMeta(mode: "quick" | "full"): Promise<void> {
  await initCacheTable();
  let existing: any = {};
  try {
    const metaResult = await pool.query(
      "SELECT summary_json FROM funtopia_daily_cache WHERE date = '__meta__'"
    );
    if (metaResult.rows.length > 0) {
      existing = metaResult.rows[0].summary_json || {};
    }
  } catch {}

  const now = new Date().toISOString();
  if (mode === "full") existing.lastFullSyncAt = now;
  if (mode === "quick") existing.lastQuickSyncAt = now;

  await pool.query(
    `INSERT INTO funtopia_daily_cache (date, synced_at, summary_json)
     VALUES ('__meta__', NOW(), $1)
     ON CONFLICT (date) DO UPDATE SET synced_at = NOW(), summary_json = $1`,
    [JSON.stringify(existing)]
  );
}

const PUSH_COOLDOWN_MINUTES = 30;

export async function setLastPushTimestamp(): Promise<void> {
  await initCacheTable();
  let existing: any = {};
  try {
    const metaResult = await pool.query(
      "SELECT summary_json FROM funtopia_daily_cache WHERE date = '__meta__'"
    );
    if (metaResult.rows.length > 0) {
      existing = metaResult.rows[0].summary_json || {};
    }
  } catch {}

  existing.lastPushAt = new Date().toISOString();

  await pool.query(
    `INSERT INTO funtopia_daily_cache (date, synced_at, summary_json)
     VALUES ('__meta__', NOW(), $1)
     ON CONFLICT (date) DO UPDATE SET synced_at = NOW(), summary_json = $1`,
    [JSON.stringify(existing)]
  );
}

export async function getPushProtectionStatus(): Promise<{ protected: boolean; lastPushAt: string | null; minutesRemaining: number }> {
  await initCacheTable();
  try {
    const metaResult = await pool.query(
      "SELECT summary_json FROM funtopia_daily_cache WHERE date = '__meta__'"
    );
    if (metaResult.rows.length > 0) {
      const meta = metaResult.rows[0].summary_json || {};
      if (meta.lastPushAt) {
        const pushTime = new Date(meta.lastPushAt).getTime();
        const elapsed = (Date.now() - pushTime) / (1000 * 60);
        if (elapsed < PUSH_COOLDOWN_MINUTES) {
          return { protected: true, lastPushAt: meta.lastPushAt, minutesRemaining: Math.ceil(PUSH_COOLDOWN_MINUTES - elapsed) };
        }
        return { protected: false, lastPushAt: meta.lastPushAt, minutesRemaining: 0 };
      }
    }
  } catch {}
  return { protected: false, lastPushAt: null, minutesRemaining: 0 };
}

export async function syncDailySummary(date: string): Promise<DailySummary> {
  return getDailySummaryFromApi(date);
}

export async function syncFuntopiaToday(): Promise<DailySummary | null> {
  if (!isFuntopiaConfigured()) return null;

  const pushStatus = await getPushProtectionStatus();
  if (pushStatus.protected) {
    console.log(`[funtopia] syncFuntopiaToday: skipped — push protection active (${pushStatus.minutesRemaining}m remaining)`);
    return null;
  }

  const nowBkk = new Date(Date.now() + 7 * 3600 * 1000);
  const todayStr = nowBkk.toISOString().split('T')[0];
  // task-135 follow-up: also catch up "yesterday" until late-morning Bangkok
  // time. Without this, a mid-day Pisell API hiccup that stops the sync at
  // e.g. 15:05 leaves yesterday frozen with partial data forever, since
  // syncTodayBackground only ever touches "today" after midnight rolls over.
  // We re-pull yesterday for the first 12 Bangkok hours of each new day —
  // enough time for staff to close late orders / clean voids without
  // hammering the API forever.
  const bkkHour = nowBkk.getUTCHours();
  const shouldSyncYesterday = bkkHour < 12;
  let yesterdayStr: string | null = null;
  if (shouldSyncYesterday) {
    const y = new Date(nowBkk.getTime() - 24 * 3600 * 1000);
    yesterdayStr = y.toISOString().split('T')[0];
  }

  let todaySummary: DailySummary | null = null;
  try {
    todaySummary = await getDailySummaryFromApi(todayStr);
    if (todaySummary) {
      console.log(`[funtopia] syncFuntopiaToday: ${todaySummary.totalOrders} orders, ฿${todaySummary.totalRevenue}`);
    }
  } catch (e) {
    console.error(`[funtopia] syncFuntopiaToday failed:`, e);
  }

  if (yesterdayStr) {
    try {
      const ySummary = await getDailySummaryFromApi(yesterdayStr);
      if (ySummary) {
        console.log(`[funtopia] syncFuntopiaYesterday(${yesterdayStr}): ${ySummary.totalOrders} orders, ฿${ySummary.totalRevenue}`);
      }
    } catch (e: any) {
      console.error(`[funtopia] syncFuntopiaYesterday(${yesterdayStr}) failed:`, e?.message || e);
    }
  }

  // task-172: after the routine window above, keep watching yesterday (and
  // the day before) for late-arriving POS uploads. During the Aug 2026
  // Pisell upload outage, orders for Aug 2 kept trickling into Pisell's
  // cloud after noon Aug 3, but the cache stayed frozen at 75 orders until
  // a manual resync. This check compares the API's reported order count
  // (one cheap size-1 report call per day) against our stored raw order
  // count, and triggers a full re-pull only when they diverge.
  try {
    await checkStaleRecentDays(yesterdayStr ? [yesterdayStr] : undefined);
  } catch (e: any) {
    console.error(`[funtopia] checkStaleRecentDays failed:`, e?.message || e);
  }

  return todaySummary;
}

// task-172: divergence detection between cached and API-reported order
// counts for recent days. Re-pull threshold: the API must report at least
// STALE_MIN_DIFF more orders than we have cached (small structural drift —
// e.g. cross-date orders that Pisell moved — should not trigger re-pulls).
const STALE_MIN_DIFF = 3;
// Remember the last (apiCount, cachedCount) pair we re-synced on, per date.
// If a divergence persists unchanged after a re-pull (structural mismatch,
// not late uploads), we skip further re-pulls until either count moves —
// otherwise a permanent 3-order drift would re-pull a full day every cycle.
const staleResyncAttempts = new Map<string, { apiCount: number; cachedCount: number }>();

async function getApiOrderCount(date: string): Promise<number | null> {
  const result = await fetchReport("order_basic_information", {
    skip: 1,
    size: 1,
    start_at: `${date} 00:00:00`,
    end_at: `${date} 23:59:59`,
    local_timezone: "Asia/Bangkok",
  });
  if (!result.status && result.code !== 200) return null;
  return Number(result.data?.count) || 0;
}

/**
 * Check yesterday and the day before for abnormally low cached order counts
 * vs Pisell's reported counts, and re-sync any day that diverges — at any
 * time of day. `skipDates` lets the caller exclude days it just re-pulled.
 */
export async function checkStaleRecentDays(skipDates?: string[]): Promise<void> {
  const nowBkk = new Date(Date.now() + 7 * 3600 * 1000);
  const candidates: string[] = [];
  for (const daysAgo of [1, 2]) {
    const d = new Date(nowBkk.getTime() - daysAgo * 24 * 3600 * 1000);
    candidates.push(d.toISOString().split("T")[0]);
  }

  const lockedMonths = await getLockedMonths();

  for (const date of candidates) {
    if (skipDates?.includes(date)) continue;
    if (isDateInLockedMonth(date, lockedMonths)) continue;

    let apiCount: number | null = null;
    try {
      apiCount = await getApiOrderCount(date);
    } catch (e: any) {
      console.warn(`[funtopia] Stale check: API count fetch failed for ${date}: ${e?.message || e}`);
      continue;
    }
    if (apiCount === null || apiCount === 0) continue;

    const res = await pool.query(
      "SELECT COUNT(DISTINCT order_id) AS cnt FROM funtopia_raw_orders WHERE order_date = $1",
      [date]
    );
    const cachedCount = parseInt(res.rows[0]?.cnt || "0", 10);

    const diff = apiCount - cachedCount;
    if (diff < STALE_MIN_DIFF) {
      staleResyncAttempts.delete(date);
      continue;
    }

    const prev = staleResyncAttempts.get(date);
    if (prev && prev.apiCount === apiCount && prev.cachedCount === cachedCount) {
      // Same divergence as after our last re-pull — structural, not late
      // uploads. Don't hammer the API; counts must move to retry.
      continue;
    }

    console.warn(
      `[funtopia] Stale day detected: ${date} cached ${cachedCount} orders vs API-reported ${apiCount} — re-syncing`
    );
    staleResyncAttempts.set(date, { apiCount, cachedCount });
    try {
      const summary = await getDailySummaryFromApi(date);
      console.log(
        `[funtopia] Stale re-sync done for ${date}: now ${summary.totalOrders} orders, ฿${summary.totalRevenue}`
      );
    } catch (e: any) {
      console.error(`[funtopia] Stale re-sync failed for ${date}:`, e?.message || e);
    }
  }
}

/**
 * Split report dates into contiguous API request windows. The normal sync uses
 * up to three adjacent dates per request, while exact report-date sync passes a
 * size of one so that every response can be attributed to the date requested.
 */
export function groupSyncDatesIntoChunks(dates: string[], maxChunkSize = 3): string[][] {
  if (dates.length === 0) return [];
  if (!Number.isInteger(maxChunkSize) || maxChunkSize < 1) {
    throw new Error("maxChunkSize must be a positive integer");
  }

  const sortedDates = [...dates].sort().reverse();
  const chunks: string[][] = [];
  let currentChunk: string[] = [sortedDates[0]];

  for (let i = 1; i < sortedDates.length; i++) {
    const prevDate = new Date(sortedDates[i - 1] + "T12:00:00");
    const currDate = new Date(sortedDates[i] + "T12:00:00");
    const gapDays = Math.abs(Math.round((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)));

    if (gapDays <= 1 && currentChunk.length < maxChunkSize) {
      currentChunk.push(sortedDates[i]);
    } else {
      chunks.push(currentChunk);
      currentChunk = [sortedDates[i]];
    }
  }
  chunks.push(currentChunk);
  return chunks;
}

/**
 * Assign orders returned for a report window to their report date. A
 * single-day report is authoritative about its requested date; it must not
 * depend on the order's created_at timezone/format to place the row.
 */
export function groupOrdersByReportDate(
  orders: any[],
  reportDates: string[],
  exactReportDates = false,
): Record<string, any[]> {
  const ordersByDay: Record<string, any[]> = {};
  for (const date of reportDates) ordersByDay[date] = [];

  if (exactReportDates && reportDates.length === 1) {
    ordersByDay[reportDates[0]].push(...orders);
    return ordersByDay;
  }

  const reportDateSet = new Set(reportDates);
  const assignedOrderIds = new Set<string>();
  for (const order of orders) {
    const createdDate = extractDateFromCreatedAt(order.created_at);
    if (reportDateSet.has(createdDate)) {
      ordersByDay[createdDate].push(order);
      assignedOrderIds.add(String(order.order_id));
    }
  }

  // Preserve the existing multi-day fallback behavior. This is deliberately
  // not used by exact single-day reconciliation, where every row belongs to
  // the requested report date above.
  const unassignedOrders = orders.filter((order: any) => !assignedOrderIds.has(String(order.order_id)));
  if (unassignedOrders.length > 0 && reportDates.length > 0) {
    const lastDate = [...reportDates].sort()[reportDates.length - 1];
    console.log(`[Funtopia Sync] ${unassignedOrders.length} orders have created_at outside chunk dates, assigning to ${lastDate}`);
    for (const order of unassignedOrders) {
      ordersByDay[lastDate].push(order);
    }
  }
  return ordersByDay;
}

export const MAX_SYNC_RANGE_DAYS = 366;

function parseSyncDate(date: unknown, fieldName: string): Date {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${fieldName} must be a valid date in YYYY-MM-DD format`);
  }
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} must be a valid date in YYYY-MM-DD format`);
  }
  return parsed;
}

/**
 * Build the inclusive date list used by syncDateRange without local-time or
 * DST surprises. Keeping validation here also protects direct callers that do
 * not go through the HTTP route.
 */
export function buildSyncDateRange(
  startDate: unknown,
  endDate: unknown,
  maxDays = MAX_SYNC_RANGE_DAYS,
): string[] {
  const start = parseSyncDate(startDate, "startDate");
  const end = parseSyncDate(endDate, "endDate");
  if (start > end) {
    throw new Error("startDate must be on or before endDate");
  }
  if (!Number.isInteger(maxDays) || maxDays < 1) {
    throw new Error("maxDays must be a positive integer");
  }

  const spanDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (spanDays > maxDays) {
    throw new Error(`Date range must not exceed ${maxDays} days`);
  }

  const dates: string[] = [];
  for (let current = new Date(start); current <= end; current.setUTCDate(current.getUTCDate() + 1)) {
    dates.push(current.toISOString().split("T")[0]);
  }
  return dates;
}

export async function syncDateRange(
  startDate: string,
  endDate: string,
  forceAll = false,
  onProgress?: (msg: string) => void,
  syncMode: "quick" | "full" = "full",
  exactReportDates = false,
): Promise<{ synced: number; fromCache: number; dates: string[]; warnings?: string[]; skippedDates?: string[] }> {
  // Validate before acquiring the lock so malformed direct calls have no
  // synchronization side effects.
  let dates = buildSyncDateRange(startDate, endDate);
  const apiSyncLock = await acquireFuntopiaApiSyncLock();
  try {
  console.log(`[Funtopia Sync] syncDateRange called: start=${startDate}, end=${endDate}, forceAll=${forceAll}`);
  console.log(`[Funtopia Sync] Generated ${dates.length} dates: ${dates[0]} → ${dates[dates.length - 1]}`);

  const warnings: string[] = [];
  const skippedDates: string[] = [];
  const lockedMonths = await getLockedMonths();
  if (lockedMonths.length > 0) {
    const beforeCount = dates.length;
    const lockedDates = dates.filter(dt => isDateInLockedMonth(dt, lockedMonths));
    if (lockedDates.length > 0) {
      skippedDates.push(...lockedDates);
      warnings.push(`Skipped locked dates: ${lockedDates.join(", ")}`);
    }
    dates = dates.filter(dt => !isDateInLockedMonth(dt, lockedMonths));
    console.log(`[Funtopia Sync] Locked months ${lockedMonths.join(', ')}: filtered ${beforeCount} → ${dates.length} dates`);
  }

  const toSync: string[] = dates;
  console.log(`[Funtopia Sync] Will fetch all ${toSync.length} dates from API`);

  if (toSync.length === 0) {
    console.log(`[Funtopia Sync] Nothing to sync — returning early`);
    return {
      synced: 0,
      fromCache: dates.length,
      dates,
      warnings: warnings.length > 0 ? warnings : undefined,
      skippedDates: skippedDates.length > 0 ? skippedDates : undefined,
    };
  }
  const chunkSize = exactReportDates ? 1 : 3;
  console.log(`[Funtopia Sync] Will sync ${toSync.length} days in chunks of ${chunkSize}${exactReportDates ? " (exact report dates)" : ""}`);
  const chunks = groupSyncDatesIntoChunks(toSync, chunkSize);

  const totalDays = toSync.length;
  let synced = 0;
  let errors = 0;
  const startTime = Date.now();

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const fetchWithRetry = async (chunkStart: string, chunkEnd: string, attempt = 1): Promise<[
    { items: any[]; expectedCount: number; isPartial: boolean },
    { items: any[]; expectedCount: number; isPartial: boolean },
    { items: any[]; expectedCount: number; isPartial: boolean },
    { items: any[]; expectedCount: number; isPartial: boolean },
  ]> => {
    const startAt = `${chunkStart} 00:00:00`;
    const endAt = `${chunkEnd} 23:59:59`;
    try {
      // Wallet-pass usage data is best-effort: if it fails we still want orders/products/payments.
      const walletPassPromise = fetchAllPages("order_wallet_pass_usage_information", startAt, endAt)
        .catch((wpErr: any) => {
          console.warn(`[Funtopia Sync] Wallet-pass fetch failed for ${chunkStart}→${chunkEnd}: ${wpErr.message}`);
          return { items: [], expectedCount: 0, isPartial: false };
        });
      return await Promise.all([
        fetchAllPages("order_basic_information", startAt, endAt),
        fetchAllPages("order_products_information", startAt, endAt),
        fetchAllPages("order_payments_information", startAt, endAt),
        walletPassPromise,
      ]);
    } catch (err: any) {
      if (err.message?.includes("429") && attempt <= 5) {
        const waitSec = attempt * 30;
        console.log(`[Funtopia Sync] Rate limited, waiting ${waitSec}s before retry ${attempt}/5...`);
        if (onProgress) onProgress(`Rate limited — waiting ${waitSec}s before retry ${attempt}/5...`);
        await delay(waitSec * 1000);
        return fetchWithRetry(chunkStart, chunkEnd, attempt + 1);
      }
      // Transient aborts/timeouts/network resets: retry up to 3 times with backoff.
      const msg = String(err?.message || err?.name || "");
      const isTransient =
        err?.name === "AbortError" ||
        /aborted|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(msg);
      if (isTransient && attempt <= 3) {
        const waitSec = attempt * 15;
        console.log(`[Funtopia Sync] Transient error (${msg}) for ${chunkStart}→${chunkEnd}, retry ${attempt}/3 in ${waitSec}s...`);
        if (onProgress) onProgress(`Transient error — retry ${attempt}/3 in ${waitSec}s...`);
        await delay(waitSec * 1000);
        return fetchWithRetry(chunkStart, chunkEnd, attempt + 1);
      }
      throw err;
    }
  };

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkSorted = [...chunk].sort();
    const chunkStart = chunkSorted[0];
    const chunkEnd = chunkSorted[chunkSorted.length - 1];

    if (ci > 0) {
      await delay(10000);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const rate = synced > 0 ? elapsed / synced : 0;
    const remaining = Math.round(rate * (totalDays - synced));
    const eta = remaining > 60 ? `~${Math.round(remaining / 60)}m left` : `~${remaining}s left`;
    const progressMsg = `${chunkStart} → ${chunkEnd} | ${synced}/${totalDays} days done (batch ${ci + 1}/${chunks.length})${synced > 0 ? ` | ${eta}` : ""}`;
    console.log(`[Funtopia Sync] ${progressMsg}`);
    if (onProgress) onProgress(progressMsg);

    try {
      const [ordersResultObj, productsResultObj, paymentsResultObj, walletPassesResultObj] = await fetchWithRetry(chunkStart, chunkEnd);

      if (ordersResultObj.isPartial) {
        const warnMsg = `Partial order data for ${chunkStart}→${chunkEnd}: got ${ordersResultObj.items.length}/${ordersResultObj.expectedCount}`;
        console.warn(`[Funtopia Sync] ⚠ ${warnMsg}`);
        if (onProgress) onProgress(`⚠ ${warnMsg}`);
        warnings.push(warnMsg);
      }

      const ordersResult = ordersResultObj.items;
      const productsResult = productsResultObj.items;
      const paymentsResult = paymentsResultObj.items;
      const walletPassesResult = walletPassesResultObj.items;

      const perDayCounts: Record<string, { orders: number; products: number; payments: number }> = {};
      if (chunkSorted.length > 1) {
        for (let di = 0; di < chunkSorted.length; di++) {
          const dateStr = chunkSorted[di];
          if (di > 0) await delay(2000);
          const results = await Promise.allSettled([
            fetchReport("order_basic_information", { skip: 1, size: 1, start_at: `${dateStr} 00:00:00`, end_at: `${dateStr} 23:59:59`, local_timezone: "Asia/Bangkok" }).then(r => r.data?.count || 0),
            fetchReport("order_products_information", { skip: 1, size: 1, start_at: `${dateStr} 00:00:00`, end_at: `${dateStr} 23:59:59`, local_timezone: "Asia/Bangkok" }).then(r => r.data?.count || 0),
            fetchReport("order_payments_information", { skip: 1, size: 1, start_at: `${dateStr} 00:00:00`, end_at: `${dateStr} 23:59:59`, local_timezone: "Asia/Bangkok" }).then(r => r.data?.count || 0),
          ]);
          const extractCount = (r: PromiseSettledResult<number>) => r.status === "fulfilled" ? r.value : 0;
          perDayCounts[dateStr] = {
            orders: extractCount(results[0]),
            products: extractCount(results[1]),
            payments: extractCount(results[2]),
          };
          if (results.some(r => r.status === "rejected")) {
            console.warn(`[Funtopia Sync] Some per-day count calls failed for ${dateStr}, using fallback for failed categories`);
          }
        }
      }

      const ordersByDay = groupOrdersByReportDate(ordersResult, chunkSorted, exactReportDates);

      for (const dateStr of chunkSorted) {
        const dayOrders = ordersByDay[dateStr];
        const dayOrderIds = new Set(dayOrders.map((o: any) => String(o.order_id)));
        const dayProducts = productsResult.filter((p: any) => dayOrderIds.has(String(p.order_id)));
        const dayPayments = paymentsResult.filter((p: any) => {
          const payDate = extractDateFromCreatedAt(p.payment_at);
          return payDate === dateStr || dayOrderIds.has(String(p.order_id));
        });
        const dayWalletPasses = walletPassesResult.filter((wp: any) => dayOrderIds.has(String(wp.order_id)));

        const existingCountResult = await pool.query(
          "SELECT COUNT(*)::int AS cnt FROM funtopia_raw_orders WHERE order_date = $1",
          [dateStr]
        );
        const existingCount = existingCountResult.rows[0]?.cnt || 0;

        const todayStr = new Date(Date.now() + 7 * 3600 * 1000).toISOString().split('T')[0];
        const yesterdayDate = new Date(Date.now() + 7 * 3600 * 1000);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yesterdayStr = yesterdayDate.toISOString().split('T')[0];
        const isRecentDate = dateStr === todayStr || dateStr === yesterdayStr;

        if (dayOrders.length === 0 && existingCount > 0 && isRecentDate) {
          const keepMsg = `Preserved existing ${existingCount} orders for ${dateStr} (batch returned 0 — API delay likely)`;
          console.log(`[Funtopia Sync] ${keepMsg}`);
          warnings.push(keepMsg);
          skippedDates.push(dateStr);
          await recordSyncHealth({
            date: dateStr,
            status: "skipped",
            ordersReceived: 0,
            warnings: [keepMsg],
          });
          continue;
        }

        if (existingCount > 0 && dayOrders.length < existingCount * 0.97) {
          if (syncMode === "quick" && isRecentDate && dayOrders.length > 0) {
            console.log(`[Funtopia Sync] Quick sync: updating ${dateStr} with ${dayOrders.length} orders (was ${existingCount}, bypass drop protection)`);
          } else {
            const skipMsg = `Skipped ${dateStr}: new data has ${dayOrders.length} orders vs ${existingCount} existing (>${Math.round((1 - dayOrders.length / existingCount) * 100)}% drop)`;
            console.warn(`[Funtopia Sync] ⚠ ${skipMsg}`);
            if (onProgress) onProgress(`⚠ ${skipMsg}`);
            warnings.push(skipMsg);
            skippedDates.push(dateStr);
            await recordSyncHealth({
              date: dateStr,
              status: "skipped",
              ordersReceived: dayOrders.length,
              warnings: [skipMsg],
            });
            continue;
          }
        }

        await storeRawOrders(dateStr, dayOrders, dayProducts, dayPayments);
        try {
          await storeWalletPasses(dateStr, dayWalletPasses);
        } catch (wpStoreErr: any) {
          console.warn(`[Funtopia Sync] storeWalletPasses failed for ${dateStr}: ${wpStoreErr.message}`);
        }
        const summary = await buildSummaryFromDatabase(dateStr);
        await setCachedSummary(dateStr, summary);

        const chunkIsPartial = ordersResultObj.isPartial || productsResultObj.isPartial || paymentsResultObj.isPartial;
        const dayWarnings: string[] = [];
        if (chunkIsPartial) {
          dayWarnings.push(`Batch ${chunkStart}→${chunkEnd} had partial data — this date may be affected`);
          if (ordersResultObj.isPartial) dayWarnings.push(`Orders batch: got ${ordersResultObj.items.length}/${ordersResultObj.expectedCount}`);
          if (productsResultObj.isPartial) dayWarnings.push(`Products batch: got ${productsResultObj.items.length}/${productsResultObj.expectedCount}`);
          if (paymentsResultObj.isPartial) dayWarnings.push(`Payments batch: got ${paymentsResultObj.items.length}/${paymentsResultObj.expectedCount}`);
        }
        const dayExpected = perDayCounts[dateStr];
        const singleDay = chunkSorted.length === 1;
        await recordSyncHealth({
          date: dateStr,
          status: chunkIsPartial ? "partial" : "clean",
          ordersExpected: dayExpected && dayExpected.orders > 0 ? dayExpected.orders : singleDay && ordersResultObj.expectedCount > 0 ? ordersResultObj.expectedCount : dayOrders.length,
          ordersReceived: dayOrders.length,
          productsExpected: dayExpected && dayExpected.products > 0 ? dayExpected.products : singleDay && productsResultObj.expectedCount > 0 ? productsResultObj.expectedCount : dayProducts.length,
          productsReceived: dayProducts.length,
          paymentsExpected: dayExpected && dayExpected.payments > 0 ? dayExpected.payments : singleDay && paymentsResultObj.expectedCount > 0 ? paymentsResultObj.expectedCount : dayPayments.length,
          paymentsReceived: dayPayments.length,
          warnings: dayWarnings.length > 0 ? dayWarnings : undefined,
        });

        synced++;
        console.log(`[Funtopia Sync] ✓ ${dateStr}: ${dayOrders.length} orders, ${dayProducts.length} products (${synced}/${totalDays})`);
      }
    } catch (chunkErr: any) {
      errors++;
      const errorMessage = chunkErr?.message || "Batch fetch failed";
      const failedDates = chunkSorted.filter(dateStr => !skippedDates.includes(dateStr));
      skippedDates.push(...failedDates);
      const failMsg = `Failed batch ${chunkStart}→${chunkEnd}: ${errorMessage}`;
      warnings.push(failMsg);
      console.error(`[Funtopia Sync] ✗ ${failMsg}`);
      if (onProgress) onProgress(`${synced}/${totalDays} days done — ${failMsg}, continuing...`);
      for (const dateStr of chunkSorted) {
        await recordSyncHealth({
          date: dateStr,
          status: "failed",
          errorMessage,
        }).catch(() => {});
      }
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const skipSuffix = skippedDates.length > 0 ? `, ${skippedDates.length} date(s) skipped to protect existing data` : "";
  const warnSuffix = warnings.length > 0 ? ` | ${warnings.length} warning(s)${skipSuffix}` : "";
  const completionMsg = `Completed: ${synced} days synced in ${totalTime > 60 ? Math.round(totalTime / 60) + "m" : totalTime + "s"}${errors > 0 ? ` (${errors} batches failed)` : ""}${warnSuffix}`;
  console.log(`[Funtopia Sync] ${completionMsg}`);
  if (onProgress) onProgress(completionMsg);
  return { synced, fromCache: dates.length - synced, dates, warnings: warnings.length > 0 ? warnings : undefined, skippedDates: skippedDates.length > 0 ? skippedDates : undefined };
  } finally {
    await releaseFuntopiaApiSyncLock(apiSyncLock);
  }
}

export async function regenerateSummaries(
  startDate: string,
  endDate: string,
  onProgress?: (msg: string) => void
): Promise<{ regenerated: number; dates: string[] }> {
  await initCacheTable();
  const apiSyncLock = await acquireFuntopiaApiSyncLock();
  try {
  const dates: string[] = [];
  let d = new Date(startDate + "T12:00:00");
  const end = new Date(endDate + "T12:00:00");
  while (d <= end) {
    dates.push(d.toISOString().split("T")[0]);
    d.setDate(d.getDate() + 1);
  }

  let regenerated = 0;
  for (const dateStr of dates) {
    try {
      const hasData = await pool.query(
        "SELECT 1 FROM funtopia_raw_orders WHERE order_date = $1 LIMIT 1",
        [dateStr]
      );
      if (hasData.rows.length === 0) {
        if (onProgress) onProgress(`${dateStr}: no raw data, skipping`);
        continue;
      }
      const summary = await buildSummaryFromDatabase(dateStr);
      await setCachedSummary(dateStr, summary);
      regenerated++;
      if (onProgress) onProgress(`${dateStr}: regenerated (${regenerated}/${dates.length})`);
    } catch (err: any) {
      console.error(`[Funtopia] Failed to regenerate summary for ${dateStr}:`, err.message);
      if (onProgress) onProgress(`${dateStr}: failed - ${err.message}`);
    }
  }

  console.log(`[Funtopia] Regenerated ${regenerated} summaries from ${startDate} to ${endDate}`);
  return { regenerated, dates };
  } finally {
    await releaseFuntopiaApiSyncLock(apiSyncLock);
  }
}

function extractDateFromCreatedAt(createdAt: string): string {
  if (!createdAt) return "";
  const match = createdAt.match(/^(\d{1,2})\/(\w{3})\/(\d{4})/);
  if (match) {
    const day = match[1].padStart(2, "0");
    const monthMap: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
    };
    const month = monthMap[match[2]] || "01";
    return `${match[3]}-${month}-${day}`;
  }
  const isoMatch = createdAt.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  return "";
}

export async function getAllDailySummaries(): Promise<Array<{ date: string; summary: any }>> {
  await initCacheTable();
  const result = await pool.query(
    `SELECT date, summary_json FROM funtopia_daily_cache WHERE date != '__meta__' ORDER BY date`
  );
  // Make sure birthdayLinks is populated AND that the cached
  // `categoryBreakdown` reflects the current floresta birthday allocation
  // (so trends, chart-builder, AI assistant, etc. all see consistent
  // historical numbers). Both helpers are no-ops when already up to date.
  const allocation = await getBirthdayAllocation("floresta");
  const needsRawRebuild = result.rows.some(
    (row: any) => (row.summary_json as DailySummary)?.formulaVersion !== FORMULA_VERSION,
  );
  const apiSyncLock = needsRawRebuild ? await acquireFuntopiaApiSyncLock() : null;
  try {
    return await Promise.all(
    result.rows.map(async (r: any) => {
      let s = r.summary_json as DailySummary;
      const expectedSummary = structuredClone(s);
      let dirty = false;
      // task-135 v24: full raw rebuild on formula mismatch (mirrors
      // getDailySummary / getDateRangeSummary) so categoryBreakdown revenue
      // matches the new rules, not just items[].
      let rebuilt = false;
      if (s.formulaVersion !== FORMULA_VERSION) {
        try {
          const fresh = await buildSummaryFromDatabase(r.date);
          if (fresh && fresh.formulaVersion === FORMULA_VERSION) {
            s = fresh;
            rebuilt = true;
            dirty = true;
          }
        } catch (e) {
          console.warn(`[Funtopia] v24 raw rebuild failed for ${r.date} (all), falling back`, e);
        }
      }
      if (!rebuilt && (!s.birthdayLinks || s.formulaVersion !== FORMULA_VERSION)) {
        await backfillBirthdayLinks(s);
        dirty = true;
      }
      if (ensureBirthdayAllocationStampedSync(s, allocation)) dirty = true;
      if (dirty) {
        // Persist so we don't pay this cost on every read.
        if (rebuilt) {
          // Formula rebuilds run while holding the shared POS sync lock.
          setCachedSummary(r.date, s).catch(() => {});
        } else {
          setCachedSummaryIfUnchanged(r.date, s, expectedSummary).then((written) => {
            if (!written) {
              console.info(`[Funtopia] Skipped stale derived cache write for ${r.date} (all)`);
            }
          }).catch(() => {});
        }
      }
      return { date: r.date, summary: s };
    }),
    );
  } finally {
    if (apiSyncLock) await releaseFuntopiaApiSyncLock(apiSyncLock);
  }
}

export { getLastSyncInfo, getCachedSummary, setCachedSummary, fixCachedRevenue };

function generateSign(timestamp: string): string {
  const values = [timestamp, FUNTOPIA_CLIENT_ID, FUNTOPIA_CLIENT_SECRET].sort();
  const concatenated = values.join("&");
  return crypto.createHash("md5").update(concatenated).digest("hex").toUpperCase();
}

function getHeaders(): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    "Client-Id": FUNTOPIA_CLIENT_ID,
    "Access-Token": FUNTOPIA_ACCESS_TOKEN,
    "Timestamp": timestamp,
    "Sign": generateSign(timestamp),
    "Content-Type": "application/json",
  };
}

// Pisell openapi report types we use. Notes/remarks ingestion endpoint
// discovery (2026-05-13, live-probed against https://ap.pisellapi.com):
//   - order_basic_information: returns NO note/remark/comment field. Keys
//     are order_id, order_code, created_at, *_amount, *_discount, tax,
//     order_sales_channel, payment_status, pay_detail_list, count, skip.
//   - Probed report types (10010 "selected type is invalid"): order_remark_information,
//     order_note_information, order_remarks_information, order_notes_information,
//     order_detail_information, order_extra_information, order_metadata_information,
//     order_attribute_information, order_information, order_full_information,
//     remark_information, note_information, order_extension_information,
//     order_custom_information, order_attributes_information.
//   - Probed alternate paths (404 "Api not found"): /openapi/order/detail,
//     /openapi/order/info, /openapi/order/get, GET /openapi/order/{id},
//     /openapi/order/remark, /openapi/order/note, /openapi/order/list,
//     /openapi/report/list, /openapi/report/types.
// UPDATE 2026-07-17 (v27): Pisell NOW returns staff-entered notes as a
// top-level `order_notes` field on order_basic_information rows (added
// server-side by Pisell some time after the May 2026 probe, alongside
// order_sales_channel). `storeRawOrders` reads
// `o.note || o.remark || o.order_notes` into funtopia_raw_orders.note,
// which feeds computeBirthdayLinks (Tier-A code refs like "#T038",
// note-based party markers) via buildSummaryFromDatabase's SELECT *.
// Historical rows were backfilled from raw_json->>'order_notes'.
export type FuntopiaReportType =
  | "order_basic_information"
  | "order_guest_information"
  | "order_products_information"
  | "order_payments_information"
  | "order_wallet_pass_usage_information";

export interface FuntopiaPayload {
  skip: number;
  size: number;
  start_at: string;
  end_at: string;
  local_timezone: string;
  sales_channel?: string;
  pay_status?: string;
  pay_method?: string;
}

export interface FuntopiaResponse {
  status: boolean;
  code: number;
  message: string;
  data: {
    count: number;
    size: number;
    skip: number;
    refreshed_at?: string;
    list: any[];
  } | null;
}

export interface OrderBasic {
  order_id: number;
  order_code: string;
  created_at: string;
  product_original_amount: number;
  is_price_include_tax: boolean;
  product_discount: number;
  order_discount: number;
  surcharge_fee: number;
  tax: number;
  total_amount: number;
  payment_amount: number;
  order_sales_channel: string;
  payment_status: string;
  pay_detail_list?: string;
}

export interface OrderProduct {
  order_id: number;
  product_id: number;
  product_title: string;
  category_title: string;
  product_tag_title?: string;
  product_quantity: number;
  original_price: number;
  product_discount: number;
  payment_price: number;
  order_sales_channel: string;
  payment_status: string;
}

export interface OrderPayment {
  id: number;
  order_id: number;
  pay_amount: number;
  refund_amount: number;
  payment_surcharge: number;
  payment_at: string;
  order_sales_channel: string;
  payment_status: string;
  pay_method: string;
}

function cleanKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(cleanKeys);
  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const cleanKey = key.replace(/^\[|\]$/g, "");
      result[cleanKey] = cleanKeys(value);
    }
    return result;
  }
  return obj;
}

async function fetchReport(
  type: FuntopiaReportType,
  payload: FuntopiaPayload
): Promise<FuntopiaResponse> {
  const url = `${FUNTOPIA_API_URL}/openapi/report/gateway`;
  const body = { type, payload };

  const controller = new AbortController();
  // Heavy days (high order count + many pages) routinely take > 30s end-to-end.
  // The previous 30s ceiling caused "operation was aborted" failures that
  // skipped entire chunks during historical backfills. Bumped to 120s.
  const timeout = setTimeout(() => controller.abort(), 120000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Funtopia API HTTP error: ${response.status} ${response.statusText}`);
  }

  let json: FuntopiaResponse;
  try {
    json = await response.json() as FuntopiaResponse;
  } catch {
    throw new Error("Funtopia API returned invalid JSON");
  }

  if (!json.status && json.code !== 200) {
    throw new Error(`Funtopia API error: ${json.message || "Unknown error"} (code ${json.code})`);
  }

  if (json.data && json.data.list) {
    json.data.list = cleanKeys(json.data.list);
  }

  return json;
}

async function fetchAllPages(
  type: FuntopiaReportType,
  startAt: string,
  endAt: string,
  timezone: string = "Asia/Bangkok",
  maxPages: number = 50
): Promise<{ items: any[]; expectedCount: number; isPartial: boolean }> {
  const allItems: any[] = [];
  let page = 1;
  const pageSize = 100;
  let expectedCount = 0;
  let maxSeenCount = 0;

  for (let i = 0; i < maxPages; i++) {
    const result = await fetchReport(type, {
      skip: page,
      size: pageSize,
      start_at: startAt,
      end_at: endAt,
      local_timezone: timezone,
    });

    if (!result.status || !result.data || !result.data.list.length) {
      if (i === 0 && result.data?.count > 0) {
        console.warn(`[Funtopia Fetch] ${type}: API reports ${result.data.count} records but returned empty page 1`);
      }
      break;
    }

    const reportedCount = result.data.count || 0;
    if (i === 0) expectedCount = reportedCount;
    maxSeenCount = Math.max(maxSeenCount, reportedCount);
    allItems.push(...result.data.list);

    if (allItems.length >= reportedCount) break;

    page++;
  }

  expectedCount = Math.max(expectedCount, maxSeenCount);
  const isPartial = expectedCount > 0 && allItems.length < expectedCount * 0.97;
  if (isPartial) {
    console.warn(`[Funtopia Fetch] PARTIAL DATA for ${type}: got ${allItems.length}/${expectedCount} records (${Math.round(allItems.length / expectedCount * 100)}%)`);
  }

  return { items: allItems, expectedCount, isPartial };
}

// task-111: bdayRevenue tags the portion of an item's revenue that came from
// birthday-party orders, surfacing as a "bday" badge in ProductList.
export interface CategoryItem {
  name: string;
  category: string;
  revenue: number;
  quantity: number;
  bdayRevenue?: number;
  // task-136: when a CategoryItem belongs to the "Other (Unattributed)"
  // bucket, it represents an order (not a product) that contributed payment
  // but couldn't be attributed to a real category. These optional fields
  // power the drill-down UI on the Revenue by Category card.
  orderId?: string;
  orderCode?: string;
  reason?: string;
  createdAt?: string | null;
  paymentStatus?: string;
}

export interface CategoryBreakdownEntry {
  revenue: number;
  quantity: number;
  items: CategoryItem[];
}

export interface TicketGuestBreakdown {
  adultTickets: number;
  kidTickets: number;
  adultRevenue: number;
  kidRevenue: number;
  estimatedTotalAdults: number;
  totalInPark: number;
  avgStayHours: number | null;
  stayDistribution: Array<{ label: string; hours: number; count: number }>;
  details: Array<{ name: string; type: "adult" | "kid"; quantity: number; revenue: number }>;
  ongoingKids: number;
  ongoingAdults: number;
  ongoingTotal: number;
  completedKids: number;
  completedAdults: number;
  completedTotal: number;
}

export interface HourlyBucket {
  hour: number;
  label: string;
  orders: number;
  revenue: number;
  ticketsSold: number;
  categories?: Record<string, number>;
  customerTypes?: Record<string, { kids: number; adults: number }>;
}

export interface DailySummary {
  date: string;
  totalRevenue: number;
  totalOrders: number;
  totalGuests: number;
  avgOrderValue: number;
  paymentBreakdown: Record<string, number>;
  topProducts: Array<{ name: string; category: string; quantity: number; revenue: number }>;
  categoryBreakdown: Record<string, CategoryBreakdownEntry>;
  discountTotal: number;
  guestBreakdown: TicketGuestBreakdown;
  hourlyBreakdown: HourlyBucket[];
  customerTypeSplit: CustomerTypeEntry[];
  voucherSwingAmount: number;
  pureTicketRevenue: number;
  sourceBreakdown?: SourceBreakdownEntry[];
  birthdayLinks?: BirthdayLinksSummary;
  formulaVersion?: string;
  // The birthday-allocation that the cached `categoryBreakdown` already
  // reflects. "fnb" (default) means no movement was applied. "events"
  // means `birthdayMovedAmount` has been moved from F&B to Events / Birthdays.
  birthdayAllocation?: BirthdayAllocation;
  birthdayMovedAmount?: number;
}

export interface BirthdayLinksUnresolved {
  partyOrderCode: string;
  missingCode: string;
}

export interface BirthdayLinkProposal {
  partyOrderCode: string;
  partyOrderId: string;
  partyCreatedAt: string | null;
  partyPackages: string[];
  partyPackageRevenue: number;
  // v30: cash-basis non-voucher payment sum per order (pay_amount minus
  // refund_amount). Voucher payments are excluded, including voucher refunds.
  // The Events / Birthdays card uses these so the per-event card values show
  // collected cash rather than voucher-funded line values. partyPackageRevenue /
  // fnbRevenue above remain BOOKING-value (total_amount) so the Events tab can
  // still show the full booked amount for partially-paid parties elsewhere.
  partyPackageRevenueCash?: number;
  fnbRevenueCash?: number;
  fnbOrderCode: string;
  fnbOrderId: string;
  fnbCreatedAt: string | null;
  fnbRevenue: number;
  lineCount: number;
  totalQty: number;
  fnbRev: number;
  kidSignalQty: number;
  hasJug: boolean;
  hasCake: boolean;
  minutesGap: number | null;
  score: number;
  signals: string[];
}

export interface BirthdayLinksSummary {
  partyPackageRevenue: number;
  partyFnbRevenue: number;
  // BD→Tickets: ticket/package-only revenue inside BD-identified orders.
  // Sums line revenues classified as "Tickets & Packages" or
  // "Events / Birthdays" from (partyOrderIds ∪ bdayTaggedFnbIds), excluding
  // F&B line items. Used by the BD→Tickets / BD→F&B header pill so the
  // value reflects only ticket/package revenue, not the whole party order.
  bdTickets: number;
  combinedBirthdayTotal: number;
  linkedOrderCount: number;
  partyOrderCount: number;
  unresolvedNoteCodes: BirthdayLinksUnresolved[];
  links?: BirthdayLinkProposal[];
  unmatchedPartyOrders?: Array<{
    partyOrderCode: string;
    partyOrderId: string;
    partyCreatedAt: string | null;
    partyPackages: string[];
    partyPackageRevenue: number;
    partyPackageRevenueCash?: number;
  }>;
}

// Pisell's `created_at` looks like "02/May/2026 15:18:51" (DD/Mon/YYYY HH:mm:ss).
function parsePisellCreatedAt(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(
    /^(\d{2})\/([A-Za-z]{3})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const mon = months[m[2]];
  if (mon === undefined) return null;
  // Treat as Bangkok time (UTC+7).
  return Date.UTC(+m[3], mon, +m[1], +m[4] - 7, +m[5], +m[6]);
}

const KID_FOOD_HINTS = [
  "kids", "kid ", "kids'", "kids ", "junior",
  "pancake", "nugget", "fries", "hot dog",
];
const JUG_HINTS = ["jug of", "jug "];
const CAKE_HINTS = ["birthday cake", "cake display", "selection from cake"];

// Note keywords that unambiguously mark an order as a birthday PARTY order
// (the package side, not the F&B side). Matched on a normalized lowercase
// note (Latin) and as a substring (Thai).
//
// IMPORTANT: bare "bday" / "b-day" / "birthday" tokens are intentionally NOT
// in this list. By the agreed convention staff write those on the F&B order
// to mark it as an F&B-side birthday order; promoting such orders to "party"
// would short-circuit the linking logic. See BDAY_FNB_TOKEN_REGEX below.
const BIRTHDAY_NOTE_KEYWORDS_LATIN = [
  "birthday party",
  "bday party",
  "b-day party",
  "b day party",
  "party package",
  "bd party",
];
const BIRTHDAY_NOTE_KEYWORDS_THAI = [
  "วันเกิด",
  "ปาร์ตี้",
  "ปาตี้",
];

// F&B-side marker. A BDAY-style token anywhere in the note means
// "this F&B order belongs to a birthday party". The note may also
// include the party order_code (e.g. "BDAY A44539") — that path is
// handled by extractOrderCodeRefs.
// Typo-tolerant F&B-side BDAY marker. Matches anywhere in the note
// (case-insensitive, no word boundary) so staff variants like
// `BDAY table 5`, `B-DAY`, `B DAY`, `BIRTHDAY`, common typo `BADY`,
// and `BDATE` all count. Kept narrow enough that unrelated words
// won't false-positive (no plain `bd`, no `birth` alone).
// v28: leading \b so substrings inside other words don't match (e.g. the
// "b day" variant previously matched inside "club day").
const BDAY_FNB_TOKEN_REGEX = /\b(?:bday|b-day|b day|birthday|bady|bdate)/i;

// Pisell order codes look like A12345 or T207. Use a permissive pattern
// (uppercase letter + 2-7 digits) to capture references staff write in notes.
const ORDER_CODE_REF_REGEX = /\b([A-Z])(\d{2,7})\b/g;

function normalizeNote(note: string | null | undefined): string {
  if (!note) return "";
  return String(note).toLowerCase().trim();
}

function noteHasBirthdayMarker(noteLower: string, originalNote: string): boolean {
  if (!noteLower && !originalNote) return false;
  for (const kw of BIRTHDAY_NOTE_KEYWORDS_LATIN) {
    if (noteLower.includes(kw)) return true;
  }
  for (const kw of BIRTHDAY_NOTE_KEYWORDS_THAI) {
    if (originalNote.includes(kw)) return true;
  }
  return false;
}

function extractOrderCodeRefs(note: string, selfCode: string): Set<string> {
  const out = new Set<string>();
  if (!note) return out;
  const upper = note.toUpperCase();
  const selfUpper = (selfCode || "").toUpperCase();
  ORDER_CODE_REF_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ORDER_CODE_REF_REGEX.exec(upper)) !== null) {
    const code = `${m[1]}${m[2]}`;
    if (code && code !== selfUpper) out.add(code);
  }
  return out;
}

export function computeBirthdayLinks(
  activeOrders: any[],
  orderRevenueById: Map<string, number>,
  categoryBreakdown: Record<string, any>,
  paidProducts: any[],
  overrides?: Map<string, FuntopiaBirthdayOverrideRow>,
  activeProducts?: any[],
  activeOrderTotalById?: Map<string, number>,
): BirthdayLinksSummary {
  // task-135: line-item party detection should run over ALL active (non-voided)
  // products, so partially-paid bookings still register as party orders.
  // Callers may omit activeProducts for backward compatibility — in that case
  // we fall back to paidProducts (legacy behaviour).
  const partyDetectProducts = activeProducts && activeProducts.length > 0 ? activeProducts : paidProducts;
  // task-135 follow-up: per-event display revenue should reflect the order's
  // booking value (total_amount of the active order), not just the paid
  // portion. This lets the Events tab show "Gold Party Package = ฿26,899"
  // for a fully-paid party AND "Table Reservation 3000 = ฿40,697" for a
  // party that has only collected a deposit so far. Falls back to
  // orderRevenueById (cash-basis paidProducts sum) when not provided.
  const hasActiveTotals = !!(activeOrderTotalById && activeOrderTotalById.size > 0);
  // Per-order display revenue. Prefers the active order's booking value
  // (total_amount); falls back to cash-basis paid sum when the active map
  // wasn't provided OR when total_amount is missing/zero for that order.
  const displayRevenueFor = (id: string): number => {
    if (hasActiveTotals) {
      const t = activeOrderTotalById!.get(id);
      if (typeof t === "number" && t > 0) return t;
    }
    return orderRevenueById.get(id) || 0;
  };
  const empty: BirthdayLinksSummary = {
    partyPackageRevenue: 0,
    partyFnbRevenue: 0,
    bdTickets: 0,
    combinedBirthdayTotal: categoryBreakdown["Events / Birthdays"]?.revenue || 0,
    linkedOrderCount: 0,
    partyOrderCount: 0,
    unresolvedNoteCodes: [],
    links: [],
    unmatchedPartyOrders: [],
  };

  // 1a. Identify party orders by line-item content.
  // task-135: use partyDetectProducts (active, not paid-only) so partially-paid
  // bookings still register as parties.
  const partyPackagesByOrder = new Map<string, string[]>();
  for (const p of partyDetectProducts) {
    const name = (p.product_title || "").toString();
    if (!isBirthdayPackage(name)) continue;
    const id = String(p.order_id);
    const list = partyPackagesByOrder.get(id) || [];
    list.push(name);
    partyPackagesByOrder.set(id, list);
  }

  const ordersById = new Map<string, any>();
  const orderIdByCode = new Map<string, string>();
  const noteByOrderId = new Map<string, string>();
  const noteLowerByOrderId = new Map<string, string>();
  const noteRefsByOrderId = new Map<string, Set<string>>();
  for (const o of activeOrders) {
    const id = String(o.order_id);
    ordersById.set(id, o);
    const code = String(o.order_code || "").toUpperCase();
    if (code) orderIdByCode.set(code, id);
    const rawNote = o.note ? String(o.note) : "";
    const lower = normalizeNote(rawNote);
    noteByOrderId.set(id, rawNote);
    noteLowerByOrderId.set(id, lower);
    noteRefsByOrderId.set(id, extractOrderCodeRefs(rawNote, code));
  }

  // 1b. Identify additional party orders by staff-entered note markers.
  // A clear birthday/party note is a confirmed party signal even when the
  // order has no birthday-package line item (which Pisell doesn't always
  // attach when the package was sold under a different SKU).
  //
  // The keyword list is narrow on purpose: a bare "BDAY" token is an
  // F&B-side marker (handled separately below) and must NOT promote the
  // order to a party.
  const partyOrderIds = new Set<string>(partyPackagesByOrder.keys());
  for (const o of activeOrders as any[]) {
    const id = String(o.order_id);
    const noteLower = noteLowerByOrderId.get(id) || "";
    const noteRaw = noteByOrderId.get(id) || "";
    if (noteHasBirthdayMarker(noteLower, noteRaw)) {
      partyOrderIds.add(id);
    }
  }

  // 1c. Identify F&B-side BDAY-tagged orders. A bare BDAY/B-DAY/BIRTHDAY
  // token in the note marks the order as belonging to a birthday party
  // (the F&B side). These orders are NEVER promoted to party. They will
  // either be paired with a referenced party code (if present in the
  // note) or with the closest same-day party order — and if no party
  // exists same-day, they are left unlinked AND logged.
  const bdayTaggedFnbIds = new Set<string>();
  for (const o of activeOrders as any[]) {
    const id = String(o.order_id);
    if (partyOrderIds.has(id)) continue;
    const noteRaw = noteByOrderId.get(id) || "";
    if (BDAY_FNB_TOKEN_REGEX.test(noteRaw)) {
      bdayTaggedFnbIds.add(id);
    }
  }

  // Manual overrides (task-103): treat each override row's order as if it
  // had a bare BDAY note token. If the override carries party_order_code,
  // it's promoted to a Tier-A code-confirmed pair downstream instead.
  // overrideTierAPairs is consumed below where codeConfirmedPairs is built.
  const overrideTierAPairs = new Set<string>();
  const overrideMatchedFnbIds = new Set<string>();
  if (overrides && overrides.size > 0) {
    for (const [overrideCode, row] of overrides) {
      const fnbId = orderIdByCode.get(overrideCode);
      if (!fnbId) continue; // order not present on this date (e.g. voided / not synced)
      if (partyOrderIds.has(fnbId)) continue; // never demote a real party
      bdayTaggedFnbIds.add(fnbId);
      overrideMatchedFnbIds.add(fnbId);
      if (row.partyOrderCode) {
        const partyId = orderIdByCode.get(row.partyOrderCode);
        if (partyId) {
          // task-135 follow-up: Pisell sometimes sells party bookings under
          // generic SKUs ("Full Day Expat Kid Package", "Open Item") so
          // isBirthdayPackage() can't recognise them as parties. When a
          // staff-entered override explicitly nominates this order as the
          // party side of a pair, treat that as authoritative and promote
          // it to partyOrderIds even without a matching line-item SKU. The
          // promoted party also picks up the F&B link in the Tier-A pass.
          if (!partyOrderIds.has(partyId)) {
            partyOrderIds.add(partyId);
            console.log(
              `[Funtopia] BD override promoted ${row.partyOrderCode} to party (no birthday-package SKU on order; user-confirmed via override)`,
            );
          }
          overrideTierAPairs.add(`${partyId}|${fnbId}`);
        }
      }
    }
    if (overrideMatchedFnbIds.size > 0) {
      const codes = [...overrideMatchedFnbIds]
        .map((id) => String(ordersById.get(id)?.order_code || id))
        .join(", ");
      console.log(`[Funtopia] BD overrides applied (${overrideMatchedFnbIds.size}): ${codes}`);
    }
  }

  // Log BDAY-tagged orphans BEFORE the no-party early return, so the
  // signal is never silently dropped on days with zero party orders.
  if (partyOrderIds.size === 0 && bdayTaggedFnbIds.size > 0) {
    const codes = [...bdayTaggedFnbIds]
      .map((id) => String(ordersById.get(id)?.order_code || id))
      .join(", ");
    console.warn(`[Funtopia] BDAY-tagged F&B orders with no same-day party: ${codes}`);
  }

  if (partyOrderIds.size === 0) return empty;

  let partyPackageRevenue = 0;
  for (const id of partyOrderIds) partyPackageRevenue += displayRevenueFor(id);

  // 2. Build per-order line aggregates for candidate scoring.
  interface OrderAgg {
    orderId: string;
    lineCount: number;
    totalQty: number;
    fnbRev: number;
    kidSignalQty: number;
    hasJug: boolean;
    hasCake: boolean;
  }
  const aggByOrder = new Map<string, OrderAgg>();
  for (const p of paidProducts) {
    const id = String(p.order_id);
    let agg = aggByOrder.get(id);
    if (!agg) {
      agg = { orderId: id, lineCount: 0, totalQty: 0, fnbRev: 0, kidSignalQty: 0, hasJug: false, hasCake: false };
      aggByOrder.set(id, agg);
    }
    const qty = p.product_quantity || 0;
    const rev = p.payment_price || 0;
    const name = (p.product_title || "").toString().toLowerCase();
    const cat = (p.category_title || "").replace(/\u200b/g, "").toLowerCase();
    agg.lineCount += 1;
    agg.totalQty += qty;
    if (cat.includes("food") || cat.includes("drink") || cat.includes("cafe") || cat.includes("bakery") || cat.includes("dessert") || cat.includes("kitchen")) {
      agg.fnbRev += rev;
    }
    if (KID_FOOD_HINTS.some((h) => name.includes(h))) agg.kidSignalQty += qty;
    if (JUG_HINTS.some((h) => name.includes(h))) { agg.hasJug = true; agg.kidSignalQty += qty; }
    if (CAKE_HINTS.some((h) => name.includes(h))) { agg.hasCake = true; agg.kidSignalQty += qty; }
  }

  // 2b. Compute Tier-A pairs: explicit order_code cross-references in
  //     either direction (party-side note has F&B code, or F&B-side note
  //     has party code, e.g. "BDAY A44539"). These are the strongest
  //     signal and always beat bare-BDAY and heuristic matches.
  const codeConfirmedPairs = new Set<string>(); // "${partyId}|${fnbId}"
  // Seed with override-driven Tier-A pairs (task-103)
  for (const k of overrideTierAPairs) codeConfirmedPairs.add(k);
  for (const partyId of partyOrderIds) {
    const partyOrder = ordersById.get(partyId);
    if (!partyOrder) continue;
    const partyCode = String(partyOrder.order_code || "").toUpperCase();
    const partyRefs = noteRefsByOrderId.get(partyId) || new Set<string>();
    // Direction A: party note references F&B order code(s)
    for (const refCode of partyRefs) {
      const refId = orderIdByCode.get(refCode);
      if (!refId || partyOrderIds.has(refId)) continue;
      codeConfirmedPairs.add(`${partyId}|${refId}`);
    }
    // Direction B: a non-party order whose note references this party code.
    // v28 hardening: the referencing note must ALSO carry a birthday marker
    // (e.g. "BDAY A44539") to count as code-confirmed. Now that Pisell
    // returns real staff notes, administrative notes like "Make up Vouchers
    // For Order A47210" or "Wrong payment from last order T040" mention
    // order codes without any party relationship — without this guard they
    // would forge a Tier-A pair and could steal the link from the true F&B
    // order. Direction A (the party's own note names the F&B code, e.g.
    // "#T038") stays marker-free: staff deliberately wrote the code on the
    // party order itself.
    if (partyCode) {
      for (const [otherId, refs] of noteRefsByOrderId) {
        if (otherId === partyId) continue;
        if (partyOrderIds.has(otherId)) continue;
        if (!refs.has(partyCode)) continue;
        const otherNoteLower = noteLowerByOrderId.get(otherId) || "";
        const otherNoteRaw = noteByOrderId.get(otherId) || "";
        if (!noteHasBirthdayMarker(otherNoteLower, otherNoteRaw) &&
            !BDAY_FNB_TOKEN_REGEX.test(otherNoteRaw)) continue;
        codeConfirmedPairs.add(`${partyId}|${otherId}`);
      }
    }
  }

  // 2c. Tier-B pairs: bare-BDAY F&B orders (no party code in note, and
  //     not already covered by Tier A). Every same-day party becomes a
  //     Tier-B candidate for the F&B order so that when multiple BDAY
  //     F&B orders compete for the same closest party, the loser still
  //     has next-best confirmed fallbacks (and never silently drops to
  //     Tier C heuristic). Within Tier B, pair selection in the greedy
  //     assignment uses time proximity as the sole tie-breaker. F&B
  //     orders with zero same-day party candidates are logged as orphans.
  const bdayConfirmedPairs = new Set<string>(); // "${partyId}|${fnbId}"
  const bdayUnlinked: string[] = [];
  // F&B orders already claimed by Tier A
  const fnbInTierA = new Set<string>();
  for (const key of codeConfirmedPairs) fnbInTierA.add(key.split("|")[1]);

  if (bdayTaggedFnbIds.size > 0) {
    interface PartyTiming { id: string; ts: number | null; date: string | null }
    const partyTimings: PartyTiming[] = [];
    for (const pid of partyOrderIds) {
      const po = ordersById.get(pid);
      partyTimings.push({
        id: pid,
        ts: parsePisellCreatedAt(po?.created_at),
        date: po?.order_date ? String(po.order_date) : null,
      });
    }
    for (const fid of bdayTaggedFnbIds) {
      if (fnbInTierA.has(fid)) continue; // already covered by code-confirmed
      const fo = ordersById.get(fid);
      const fts = parsePisellCreatedAt(fo?.created_at);
      const fdate = fo?.order_date ? String(fo.order_date) : null;
      // Same-day scope guard: Tier B may only pair across orders whose
      // funtopia_raw_orders.order_date matches. activeOrders can include
      // crossDateOrders (orders that moved between dates), so without
      // this filter a BDAY-tagged F&B from day X could be paired with a
      // party from day Y. When the F&B order has no order_date we fall
      // back to allowing any same-day-by-timestamp party.
      const sameDayParties = partyTimings.filter((p) =>
        fdate && p.date ? p.date === fdate : true,
      );
      if (sameDayParties.length === 0) {
        bdayUnlinked.push(fid);
        continue;
      }
      // Emit every same-day party as a Tier-B candidate. The greedy
      // 1-to-1 assignment will pick the closest by time first; if that
      // party is taken (e.g. by another BDAY F&B with a tighter gap),
      // the next-closest same-day party is still a Tier-B fallback,
      // strictly preferred over any Tier-C heuristic match.
      for (const { id: pid } of sameDayParties) {
        bdayConfirmedPairs.add(`${pid}|${fid}`);
      }
    }
  }
  if (bdayUnlinked.length > 0) {
    const codes = bdayUnlinked
      .map((id) => String(ordersById.get(id)?.order_code || id))
      .join(", ");
    console.warn(`[Funtopia] BDAY-tagged F&B orders unlinked after pairing: ${codes}`);
  }

  // Union for downstream candidate-set building. Tier is tracked
  // separately so sort/assignment can enforce strict precedence.
  const confirmedPairs = new Set<string>([
    ...codeConfirmedPairs,
    ...bdayConfirmedPairs,
  ]);
  const tierByPair = new Map<string, "code" | "bday">();
  for (const k of codeConfirmedPairs) tierByPair.set(k, "code");
  for (const k of bdayConfirmedPairs) {
    if (!tierByPair.has(k)) tierByPair.set(k, "bday");
  }

  // 3. For each party order, score every candidate F&B order on the same day.
  //    Scoring rewards: lots of lines, large total, kid-food signals, F&B dominance,
  //    time proximity to the party order. Confirmed (note) pairs bypass the
  //    minimum threshold and substantiality gates.
  interface Scored extends BirthdayLinkProposal {
    confirmed: boolean;
    tier: "code" | "bday" | "heuristic";
    timeGap: number;
  }
  const scored: Scored[] = [];
  const partyPackageFallback = ["Birthday party (note)"];
  for (const partyId of partyOrderIds) {
    const partyOrder = ordersById.get(partyId);
    if (!partyOrder) continue;
    const partyCode = String(partyOrder.order_code || "");
    const partyCreatedAt = partyOrder.created_at || null;
    const partyTs = parsePisellCreatedAt(partyCreatedAt);
    const lineItemPackages = partyPackagesByOrder.get(partyId) || [];
    const partyPackages = lineItemPackages.length > 0 ? lineItemPackages : partyPackageFallback;
    const partyPackageRevenueForOrder = displayRevenueFor(partyId);

    // Build the candidate set: every order in aggByOrder, plus any confirmed
    // F&B candidate that may not have aggregated line items yet (so confirmed
    // pairs are never silently dropped).
    const candidateIds = new Set<string>(aggByOrder.keys());
    for (const key of confirmedPairs) {
      const [pid, fid] = key.split("|");
      if (pid === partyId && !candidateIds.has(fid)) candidateIds.add(fid);
    }
    const emptyAgg: OrderAgg = { orderId: "", lineCount: 0, totalQty: 0, fnbRev: 0, kidSignalQty: 0, hasJug: false, hasCake: false };
    for (const candId of candidateIds) {
      if (partyOrderIds.has(candId)) continue; // never link party→party
      const candOrder = ordersById.get(candId);
      if (!candOrder) continue;
      const agg = aggByOrder.get(candId) || { ...emptyAgg, orderId: candId };
      const isConfirmed = confirmedPairs.has(`${partyId}|${candId}`);
      if (!isConfirmed) {
        if (agg.lineCount < 5 && agg.totalQty < 8) continue; // must be substantial
        // Must contain food-like content. Accept either explicit F&B-category revenue,
        // or items matched by our food-name heuristics (Pisell sometimes categorizes
        // Jug of Juice / cake / kid food outside the food/drink categories).
        const hasFoodContent = agg.fnbRev > 0 || agg.hasJug || agg.hasCake || agg.kidSignalQty > 0;
        if (!hasFoodContent) continue; // guards against linking pure-ticket / pure-merch orders
      }
      const candCode = String(candOrder.order_code || "");
      const candCreatedAt = candOrder.created_at || null;
      // Scoring uses booking value (total_amount) when available so that
      // big-ticket F&B orders sitting in "Pending Payment" still score on
      // the size signal. Falls back to cash-basis when the caller didn't
      // pass activeOrderTotalById or the order has no booking total.
      const candTotal = displayRevenueFor(candId);

      let score = 0;
      const signals: string[] = [];
      if (agg.lineCount >= 20) { score += 8; signals.push(`${agg.lineCount} lines`); }
      else if (agg.lineCount >= 10) { score += 5; signals.push(`${agg.lineCount} lines`); }
      else if (agg.lineCount >= 5) { score += 2; signals.push(`${agg.lineCount} lines`); }

      if (candTotal >= 10000) { score += 6; signals.push(`฿${Math.round(candTotal).toLocaleString()}`); }
      else if (candTotal >= 5000) { score += 4; signals.push(`฿${Math.round(candTotal).toLocaleString()}`); }
      else if (candTotal >= 2000) { score += 2; signals.push(`฿${Math.round(candTotal).toLocaleString()}`); }

      if (agg.hasJug) { score += 5; signals.push("Jug of Juice"); }
      if (agg.hasCake) { score += 4; signals.push("Birthday cake"); }
      if (agg.kidSignalQty >= 8) { score += 4; signals.push(`${agg.kidSignalQty} kid items`); }
      else if (agg.kidSignalQty >= 4) { score += 2; signals.push(`${agg.kidSignalQty} kid items`); }
      else if (agg.kidSignalQty >= 1) { score += 1; }

      if (candTotal > 0 && agg.fnbRev / candTotal >= 0.5) { score += 2; signals.push("F&B-dominant"); }

      let minutesGap: number | null = null;
      const candTs = parsePisellCreatedAt(candCreatedAt);
      if (partyTs !== null && candTs !== null) {
        minutesGap = Math.round(Math.abs(candTs - partyTs) / 60000);
        if (minutesGap <= 30) { score += 4; signals.push(`±${minutesGap}m of party`); }
        else if (minutesGap <= 120) { score += 2; signals.push(`±${minutesGap}m of party`); }
        // Skip the time-gap penalty when the party order is an advance booking
        // (created > 24h before the candidate). Without this, party-room
        // bookings made days ahead were unfairly downgraded vs day-of bookings.
        else if (minutesGap > 240 && minutesGap < 1440) { score -= 2; }
      }

      const tier: "code" | "bday" | "heuristic" = isConfirmed
        ? (tierByPair.get(`${partyId}|${candId}`) || "heuristic")
        : "heuristic";
      if (isConfirmed) {
        // Confirmed pairs bypass the heuristic threshold; the actual tier
        // (code vs bday) is enforced in the sort, not via score.
        score += 100;
        signals.unshift(tier === "code" ? "code-confirmed" : "bday-confirmed");
      } else if (score < 8) {
        continue;
      }
      const timeGap = (minutesGap === null) ? Number.POSITIVE_INFINITY : minutesGap;
      scored.push({
        partyOrderCode: partyCode,
        partyOrderId: partyId,
        partyCreatedAt,
        partyPackages,
        partyPackageRevenue: partyPackageRevenueForOrder,
        fnbOrderCode: candCode,
        fnbOrderId: candId,
        fnbCreatedAt: candCreatedAt,
        fnbRevenue: candTotal,
        lineCount: agg.lineCount,
        totalQty: agg.totalQty,
        fnbRev: agg.fnbRev,
        kidSignalQty: agg.kidSignalQty,
        hasJug: agg.hasJug,
        hasCake: agg.hasCake,
        minutesGap,
        score,
        signals,
        confirmed: isConfirmed,
        tier,
        timeGap,
      });
    }
  }

  // 4. Greedy 1-to-1 assignment with strict tier precedence:
  //      Tier A (code-confirmed) > Tier B (bday-confirmed) > Tier C (heuristic)
  //    Within Tier A: higher score wins, then higher revenue.
  //    Within Tier B: closest by time wins (sole tie-breaker requirement),
  //      then higher revenue, then lexicographic order_id for determinism.
  //    Within Tier C: higher score wins, then higher revenue.
  //    Each party + each F&B order may be linked at most once.
  const tierRank = (t: "code" | "bday" | "heuristic") =>
    t === "code" ? 0 : t === "bday" ? 1 : 2;
  scored.sort((a, b) => {
    const ta = tierRank(a.tier);
    const tb = tierRank(b.tier);
    if (ta !== tb) return ta - tb;
    if (a.tier === "bday") {
      if (a.timeGap !== b.timeGap) return a.timeGap - b.timeGap;
      if (b.fnbRevenue !== a.fnbRevenue) return b.fnbRevenue - a.fnbRevenue;
      return a.fnbOrderId.localeCompare(b.fnbOrderId);
    }
    return (b.score - a.score) || (b.fnbRevenue - a.fnbRevenue);
  });
  const usedParty = new Set<string>();
  const usedFnb = new Set<string>();
  const accepted: BirthdayLinkProposal[] = [];
  for (const s of scored) {
    if (usedParty.has(s.partyOrderId) || usedFnb.has(s.fnbOrderId)) continue;
    usedParty.add(s.partyOrderId);
    usedFnb.add(s.fnbOrderId);
    const { confirmed, ...rest } = s;
    // v30: cash-basis sums per order from non-voucher payment rows. This is
    // deliberately separate from the booking-value display fields above.
    rest.partyPackageRevenueCash = orderRevenueById.get(s.partyOrderId) || 0;
    rest.fnbRevenueCash = orderRevenueById.get(s.fnbOrderId) || 0;
    accepted.push(rest);
  }

  // Aggregate partyFnbRevenue stays CASH-BASIS (non-voucher payment rows) even
  // though per-link `a.fnbRevenue` is booking-value for display. This is
  // critical: partyFnbRevenue feeds applyBirthdayAllocationToCategoryBreakdown
  // which uses min(partyFnbRevenue, F&B category revenue) to move money
  // between cash-basis category buckets. Using booking-value here would
  // shovel ALL paid F&B into Events / Birthdays whenever any party has a
  // pending-payment F&B link.
  let partyFnbRevenue = 0;
  for (const a of accepted) partyFnbRevenue += orderRevenueById.get(a.fnbOrderId) || 0;

  const unmatchedPartyOrders = [...partyOrderIds]
    .filter((id) => !usedParty.has(id))
    .map((id) => {
      const o = ordersById.get(id);
      return {
        partyOrderCode: String(o?.order_code || ""),
        partyOrderId: id,
        partyCreatedAt: o?.created_at || null,
        partyPackages: partyPackagesByOrder.get(id) || [],
        partyPackageRevenue: displayRevenueFor(id),
        partyPackageRevenueCash: orderRevenueById.get(id) || 0,
      };
    });

  const eventsRev = categoryBreakdown["Events / Birthdays"]?.revenue || 0;

  // bdTickets = ticket/package revenue inside BD-identified orders.
  // BD-identified = party orders (line-item OR party-note detected) ∪ F&B
  // orders carrying a bare BDAY/B-DAY/BIRTHDAY note token. For each such
  // order we sum the revenue of line items whose classified RevenueCategory
  // is "Tickets & Packages" or "Events / Birthdays" (i.e. the package /
  // ticket portion, excluding F&B and other categories). This is what the
  // dashboard's BD→Tickets header pill displays.
  const bdOrderIds = new Set<string>([...partyOrderIds, ...bdayTaggedFnbIds]);
  let bdTickets = 0;
  for (const p of paidProducts) {
    const id = String(p.order_id);
    if (!bdOrderIds.has(id)) continue;
    const rawCat = (p.category_title || "").toString();
    const productName = (p.product_title || "").toString();
    const cls = classifyCategory(rawCat);
    // Birthday-package line items can land under various raw Pisell
    // categories ("Packages", "Special", "Extra") — isBirthdayPackage()
    // is the same predicate we use to detect parties, so always count
    // those as BD tickets regardless of raw category.
    const isBdPackage = isBirthdayPackage(productName);
    if (isBdPackage || cls === "Tickets & Packages" || cls === "Events / Birthdays") {
      bdTickets += p.payment_price || 0;
    }
  }

  return {
    partyPackageRevenue,
    partyFnbRevenue,
    bdTickets,
    combinedBirthdayTotal: eventsRev + partyFnbRevenue,
    linkedOrderCount: accepted.length,
    partyOrderCount: partyOrderIds.size,
    unresolvedNoteCodes: [],
    links: accepted,
    unmatchedPartyOrders,
  };
}

async function buildSummaryFromDatabase(date: string): Promise<DailySummary> {
  await initCacheTable();

  const [rawOrdersRes, productsRes, paymentsRes, walletPassesRes] = await Promise.all([
    pool.query("SELECT * FROM funtopia_raw_orders WHERE order_date = $1", [date]),
    pool.query("SELECT * FROM funtopia_orders WHERE order_date = $1", [date]),
    pool.query("SELECT * FROM funtopia_raw_payments WHERE order_date = $1", [date]),
    pool.query(
      "SELECT order_id, title, action, redeem_amount, code FROM funtopia_raw_wallet_passes WHERE order_date = $1",
      [date],
    ),
  ]);

  const ordersResult = latestOrderRows(rawOrdersRes.rows).rows.map((r: any) => ({
    ...r,
    order_id: String(r.order_id),
    total_amount: parseFloat(r.total_amount) || 0,
    product_discount: parseFloat(r.product_discount) || 0,
    order_discount: parseFloat(r.order_discount) || 0,
  }));

  const productsResult = productsRes.rows.map((r: any) => {
    const raw = r.raw_json || {};
    return {
      ...raw,
      order_id: String(r.order_id),
      product_title: r.product_name || raw.product_title,
      category_title: r.product_category || raw.category_title,
      product_quantity: parseInt(r.quantity) || 0,
      payment_price: parseFloat(r.subtotal) || 0,
      price: parseFloat(r.unit_price) || 0,
      product_discount: parseFloat(r.discount) || 0,
      tax: parseFloat(r.tax) || 0,
      created_at: r.created_at,
      product_id: r.product_id,
      variant_id: r.variant_id,
    };
  });

  const paymentsResult = latestPaymentRows(paymentsRes.rows).rows.map((r: any) => ({
    order_id: String(r.order_id),
    pay_method: r.pay_method,
    payment_name: r.payment_name,
    pay_amount: parseFloat(r.pay_amount) || 0,
    refund_amount: parseFloat(r.refund_amount) || 0,
    payment_surcharge: parseFloat(r.payment_surcharge) || 0,
    payment_at: r.payment_at,
  }));

  const localOrderIds = new Set(ordersResult.map((o: any) => o.order_id));
  const crossDatePaymentOrderIds = paymentsResult
    .map((p: any) => p.order_id)
    .filter((id: string) => !localOrderIds.has(id));

  let crossDateOrders: any[] = [];
  if (crossDatePaymentOrderIds.length > 0) {
    const uniqueIds = [...new Set(crossDatePaymentOrderIds)];
    const crossRes = await pool.query(
      `SELECT * FROM funtopia_raw_orders WHERE order_id = ANY($1::text[])`,
      [uniqueIds]
    );
    crossDateOrders = latestOrderRows(crossRes.rows).rows.map((r: any) => ({
      ...r,
      order_id: String(r.order_id),
      total_amount: parseFloat(r.total_amount) || 0,
      product_discount: parseFloat(r.product_discount) || 0,
      order_discount: parseFloat(r.order_discount) || 0,
    }));
  }

  const allOrders = [...ordersResult, ...crossDateOrders];

  const walletPasses = walletPassesRes.rows.map((r: any) => ({
    order_id: String(r.order_id),
    title: r.title,
    action: r.action,
    redeem_amount: parseFloat(r.redeem_amount) || 0,
    code: r.code,
  }));
  const birthdayOverrides = await loadFuntopiaBirthdayOverridesForDate(date);
  const voucherChannelMap = await getVoucherChannelMap();
  return buildSummaryFromRawData(date, allOrders, productsResult, paymentsResult, voucherChannelMap, walletPasses, birthdayOverrides);
}

async function rebuildAndCacheSummaryWithApiLock(date: string): Promise<DailySummary> {
  const apiSyncLock = await acquireFuntopiaApiSyncLock();
  try {
    const summary = await buildSummaryFromDatabase(date);
    await setCachedSummary(date, summary);
    return summary;
  } finally {
    await releaseFuntopiaApiSyncLock(apiSyncLock);
  }
}

function buildSummaryFromRawData(
  date: string,
  ordersResult: any[],
  productsResult: any[],
  paymentsResult: any[],
  voucherChannelMap?: Map<string, VoucherChannelMapEntry>,
  walletPasses?: Array<{ order_id: string; title: string | null; action: string | null; redeem_amount: number; code?: string | null }>,
  birthdayOverrides?: Map<string, FuntopiaBirthdayOverrideRow>,
): DailySummary {
  const activeOrders = ordersResult.filter(
    (o: any) => o.payment_status?.toLowerCase() !== "voided"
  );

  const discountTotal = activeOrders.reduce(
    (sum: number, o: any) => sum + (o.product_discount || 0) + (o.order_discount || 0),
    0
  );
  const activeOrderIds = new Set(activeOrders.map((o: any) => o.order_id));

  const activePayments = paymentsResult.filter(
    (p: any) => activeOrderIds.has(p.order_id)
  );
  const paymentBreakdown: Record<string, number> = {};
  for (const p of activePayments) {
    const method = normalizePaymentMethod(p.pay_method || "Other");
    const net = (p.pay_amount || 0) - (p.refund_amount || 0);
    if (net > 0) {
      paymentBreakdown[method] = (paymentBreakdown[method] || 0) + net;
    }
  }

  const paidOrderIds = new Set(activeOrders.filter(
    (o: any) => o.payment_status?.toLowerCase() === "paid"
  ).map((o: any) => o.order_id));
  const paidProducts = productsResult.filter(
    (p: any) => paidOrderIds.has(p.order_id)
  );
  // task-135: party-package line items live on the ORDER regardless of payment
  // status. A "Table Reservation 3000" / "Full Day Expat Kid Package" booked
  // and only partially paid (deposit only) is still a real party that needs
  // F&B linking. We surface them via activeProducts (non-voided, any status)
  // but keep paidProducts for cash-basis revenue / category breakdowns.
  const activeOrderIdSet = new Set(activeOrders.map((o: any) => String(o.order_id)));
  const activeProducts = productsResult.filter(
    (p: any) => activeOrderIdSet.has(String(p.order_id))
  );
  // task-135 follow-up: order's total_amount (booking value, includes
  // unpaid portion). Used for Events tab display revenue + candidate
  // scoring so partially-paid bookings surface their full value.
  const activeOrderTotalById = new Map<string, number>();
  for (const o of activeOrders) {
    activeOrderTotalById.set(String(o.order_id), Number(o.total_amount) || 0);
  }

  const paymentCollected = activePayments.reduce(
    (sum: number, p: any) => sum + ((p.pay_amount || 0) - (p.refund_amount || 0)),
    0
  );
  // task-128 (v15): voucherPaymentsTotal is computed symmetrically across ALL
  // active voucher payments (including net ≤ 0) so a voucher refund row never
  // gets subtracted from paymentCollected while being dropped from the
  // voucher bucket — which would double-subtract the refund. The paymentBreakdown
  // map intentionally still keeps the net > 0 filter (it drives the
  // user-facing "payment methods" card and shouldn't display negative buckets).
  const voucherPaymentsTotal = activePayments.reduce(
    (sum: number, p: any) =>
      normalizePaymentMethod(p.pay_method || "Other") === "Voucher"
        ? sum + ((p.pay_amount || 0) - (p.refund_amount || 0))
        : sum,
    0,
  );
  const totalRevenue = paymentCollected - voucherPaymentsTotal;
  const productMap = new Map<string, { name: string; category: string; quantity: number; revenue: number }>();
  for (const p of paidProducts) {
    const key = p.product_title || "Unknown";
    const existing = productMap.get(key);
    if (existing) {
      existing.quantity += p.product_quantity || 0;
      existing.revenue += p.payment_price || 0;
    } else {
      productMap.set(key, {
        name: key,
        category: (p.category_title || "").replace(/\u200b/g, ""),
        quantity: p.product_quantity || 0,
        revenue: p.payment_price || 0,
      });
    }
  }

  const topProducts = Array.from(productMap.values())
    .filter((p) => p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // task-111: detect birthday-origin order IDs up-front so buildCategoryBreakdown
  // can stamp per-item bdayRevenue and the source breakdown can route party
  // packages into the Birthdays bucket. Detection mirrors computeBirthdayLinks
  // (line-item party packages ∪ party-note orders ∪ bare-BDAY F&B notes ∪
  // manual overrides). computeBirthdayLinks re-derives the same sets later;
  // both code paths are deterministic so the duplication is safe.
  const partyOrderIds = new Set<string>();
  const bdayTaggedFnbIds = new Set<string>();
  {
    // task-135: scan activeProducts (not paidProducts) so partially-paid
    // bookings still register as parties (their line items exist whether
    // or not the balance is settled).
    for (const p of activeProducts) {
      const name = (p.product_title || "").toString();
      if (isBirthdayPackage(name)) partyOrderIds.add(String(p.order_id));
    }
    const orderIdByCode = new Map<string, string>();
    for (const o of activeOrders as any[]) {
      const code = String(o.order_code || "").toUpperCase();
      if (code) orderIdByCode.set(code, String(o.order_id));
    }
    for (const o of activeOrders as any[]) {
      const id = String(o.order_id);
      const noteRaw = o.note ? String(o.note) : "";
      const lower = normalizeNote(noteRaw);
      if (noteHasBirthdayMarker(lower, noteRaw)) partyOrderIds.add(id);
    }
    for (const o of activeOrders as any[]) {
      const id = String(o.order_id);
      if (partyOrderIds.has(id)) continue;
      const noteRaw = o.note ? String(o.note) : "";
      if (BDAY_FNB_TOKEN_REGEX.test(noteRaw)) bdayTaggedFnbIds.add(id);
    }
    if (birthdayOverrides && birthdayOverrides.size > 0) {
      for (const [overrideCode, row] of birthdayOverrides) {
        const fnbId = orderIdByCode.get(overrideCode);
        if (!fnbId) continue;
        if (partyOrderIds.has(fnbId)) continue;
        bdayTaggedFnbIds.add(fnbId);
        // v22/v23 alignment: if the override carries a party_order_code,
        // promote that order to a party here too so buildCategoryBreakdown
        // sees it and reclassifies its line items into Events / Birthdays.
        // Mirrors the promotion done inside computeBirthdayLinks.
        if (row.partyOrderCode) {
          const partyId = orderIdByCode.get(row.partyOrderCode);
          if (partyId) partyOrderIds.add(partyId);
        }
      }
    }
  }
  const bdOrderIds = new Set<string>([...partyOrderIds, ...bdayTaggedFnbIds]);

  // task-136 (v25): Proportional attribution for partially-paid orders.
  // Until v24, buildCategoryBreakdown only consumed `paidProducts` (orders
  // with payment_status === "paid"), so a Partially-Paid order's payment
  // landed in totalRevenue while its line items were excluded — surfacing
  // as a bare "Other (Unattributed)" bucket. v25 scales each non-paid
  // active order's products by share = netCollected / productSum so they
  // bucket into their natural category. Orders with payment but no line
  // items (and rounding) are the only true residuals; they're listed under
  // the bucket's items[] so the dashboard can drill down per-order.
  const productSumByOrderId = new Map<string, number>();
  for (const p of activeProducts) {
    const id = String(p.order_id);
    productSumByOrderId.set(id, (productSumByOrderId.get(id) || 0) + (p.payment_price || 0));
  }
  // Per-order net contribution to totalRevenue (cash basis):
  //   non-voucher net = pay_amount − refund_amount.
  // Voucher rows net to zero against totalRevenue (paymentCollected −
  // voucherPaymentsTotal), so they contribute 0 to the per-order share.
  const netCollectedByOrderId = buildNonVoucherRevenueByOrder(activePayments);
  const orderById = new Map<string, any>();
  for (const o of activeOrders) orderById.set(String(o.order_id), o);
  // Voucher refunds reduce totalRevenue (cash basis subtracts voucher net),
  // so per-order voucher net ≤ 0 contributors are surfaced as zero-revenue
  // drill-down entries — the user can still see which orders are pulling
  // the day's total down even if they don't add to the bucket revenue.
  const voucherNetByOrderId = new Map<string, number>();
  for (const p of activePayments) {
    if (normalizePaymentMethod(p.pay_method || "") !== "Voucher") continue;
    const id = String(p.order_id);
    const net = (p.pay_amount || 0) - (p.refund_amount || 0);
    if (net === 0) continue;
    voucherNetByOrderId.set(id, (voucherNetByOrderId.get(id) || 0) + net);
  }
  const partialProducts: any[] = [];
  const unattributedResiduals: CategoryItem[] = [];
  for (const [orderId, netContribution] of netCollectedByOrderId) {
    if (netContribution <= 0.005) continue;
    const o = orderById.get(orderId);
    if (!o) continue;
    if ((o.payment_status || "").toLowerCase() === "paid") continue;
    const productSum = productSumByOrderId.get(orderId) || 0;
    if (productSum <= 0.005) {
      unattributedResiduals.push({
        name: String(o.order_code || orderId),
        category: "Unattributed",
        revenue: Math.round(netContribution * 100) / 100,
        quantity: 0,
        orderId,
        orderCode: String(o.order_code || orderId),
        reason: "Order has payment but no line items",
        createdAt: o.created_at || null,
        paymentStatus: o.payment_status || "Unknown",
      });
      continue;
    }
    const share = Math.min(1, netContribution / productSum);
    for (const p of activeProducts) {
      if (String(p.order_id) !== orderId) continue;
      partialProducts.push({
        ...p,
        payment_price: (p.payment_price || 0) * share,
        product_quantity: (p.product_quantity || 0) * share,
        __partialShare: share,
      });
    }
  }
  // Voucher-refund per-order entries: surface orders where a voucher refund
  // is dragging totalRevenue down so the drill-down lists them, even though
  // they contribute 0 to bucket revenue (the refund already subtracted from
  // totalRevenue via the cash-basis formula).
  for (const [orderId, voucherNet] of voucherNetByOrderId) {
    if (voucherNet >= -0.005) continue;
    const o = orderById.get(orderId);
    if (!o) continue;
    unattributedResiduals.push({
      name: String(o.order_code || orderId),
      category: "Unattributed",
      revenue: 0,
      quantity: 0,
      orderId,
      orderCode: String(o.order_code || orderId),
      reason: `Voucher refund ฿${Math.round(Math.abs(voucherNet)).toLocaleString()}`,
      createdAt: o.created_at || null,
      paymentStatus: o.payment_status || "Unknown",
    });
  }
  const categoryProducts = partialProducts.length > 0
    ? [...paidProducts, ...partialProducts]
    : paidProducts;

  const categoryBreakdown = buildCategoryBreakdown(categoryProducts, bdOrderIds, partyOrderIds);
  const paidOrders = activeOrders.filter((o: any) => o.payment_status?.toLowerCase() === "paid");
  const guestBreakdown = buildGuestBreakdown(paidProducts, paidOrders);
  const hourlyBreakdown = buildHourlyBreakdown(paidOrders, paidProducts);
  const customerTypeSplit = buildCustomerTypeSplit(paidProducts);

  let voucherSwingAmount = 0;
  for (const p of paidProducts) {
    const name = (p.product_title || "").toLowerCase();
    const qty = p.product_quantity || 0;
    const voucherMatch = name.match(/(\d+)\s*voucher/);
    if (voucherMatch) {
      const faceValue = parseInt(voucherMatch[1], 10);
      if (faceValue > 0) {
        voucherSwingAmount += faceValue * qty;
      }
    }
  }

  reconcileCategoryBreakdown(categoryBreakdown, totalRevenue, unattributedResiduals);

  const ticketCatRevenue = categoryBreakdown["Tickets & Packages"]?.revenue || 0;
  const pureTicketRevenue = ticketCatRevenue - voucherSwingAmount;

  // Birthday cash fields must use actual non-voucher payments. Paid product
  // values include voucher-funded lines and are therefore not cash revenue.
  const orderRevenueById = new Map(netCollectedByOrderId);

  // Per-order TICKET revenue: sum of payment_price for products that classify
  // to "Tickets & Packages", excluding voucher-swing line items (e.g. "350
  // Voucher" products that inflate the ticket category but aren't true ticket
  // sales). Used by the Revenue by Source card to credit channels for the
  // ticket portion of attributed orders only.
  const ticketRevenueByOrder = new Map<string, number>();
  for (const p of paidProducts) {
    const rawCat = String(p.category_title || "");
    if (classifyCategory(rawCat) !== "Tickets & Packages") continue;
    const name = (p.product_title || "").toLowerCase();
    if (/(\d+)\s*voucher/.test(name)) continue;
    const id = p.order_id;
    ticketRevenueByOrder.set(id, (ticketRevenueByOrder.get(id) || 0) + (p.payment_price || 0));
  }
  let totalTicketRevenueForSources = 0;
  ticketRevenueByOrder.forEach((v) => { totalTicketRevenueForSources += v; });

  // Source breakdown (Floresta-only, voucher-title based, TICKET REVENUE only):
  //   For each order, look at the wallet-pass voucher REDEMPTIONS made on that
  //   order. Each voucher title is matched against the configured marketing
  //   channels (sourceRegistry) plus the two F&B-perk exceptions (Free Coffee,
  //   Free Ice Cream). Orders whose only redemption is a non-channel F&B
  //   voucher (e.g. "350B FB Voucher", "Eat & Play Voucher") are dropped from
  //   the card entirely — they're neither attributed nor counted as Walk-in.
  //   Orders with no vouchers at all fall under "Walk-in". Every row reflects
  //   the ticket portion of the order revenue only.
  const titlesByOrder = walletPasses && walletPasses.length > 0
    ? indexRedeemedTitlesByOrder(walletPasses)
    : new Map<string, Array<{ title: string; code: string }>>();

  // Voucher PAYMENTS per order (face values), so the configurable
  // face-value -> channel map (funtopia_voucher_channel_map) can drive
  // attribution alongside wallet-pass titles. This is how Indian package
  // face values (฿690 / ฿890 / ฿1090) reach Revenue by Source: the admin
  // picks a channel in Config, and any order paying with that face value
  // gets credited to it here.
  const voucherPaymentsByOrder = new Map<string, number[]>();
  for (const p of activePayments as any[]) {
    if (normalizePaymentMethod(p.pay_method || "") !== "Voucher") continue;
    const amt = (p.pay_amount || 0) - (p.refund_amount || 0);
    if (amt <= 0) continue;
    const id = String(p.order_id);
    const list = voucherPaymentsByOrder.get(id) || [];
    list.push(amt);
    voucherPaymentsByOrder.set(id, list);
  }

  // task-111: Birthdays bucket — sum the birthday-package portion of every
  // party order. We use the same predicate as the BD detector
  // (isBirthdayPackage OR classifyCategory === "Events / Birthdays"). Linked
  // F&B is intentionally excluded. Party orders are then removed from the
  // regular channel attribution below so Walk-in/etc don't double-count.
  let birthdaysBucketRev = 0;
  for (const p of paidProducts) {
    const orderId = String(p.order_id);
    if (!partyOrderIds.has(orderId)) continue;
    const rawCat = (p.category_title || "").toString();
    const productName = (p.product_title || "").toString();
    const cls = classifyCategory(rawCat);
    if (isBirthdayPackage(productName) || cls === "Events / Birthdays") {
      birthdaysBucketRev += p.payment_price || 0;
    }
  }

  let excludedTicketRev = 0;
  const sourceInputs: Array<{ revenue: number; discounts: Array<{ name: string; total: number; preClassifiedSource?: string }> }> = [];
  for (const o of activeOrders as any[]) {
    const orderId = String(o.order_id);
    // task-111: party orders are surfaced under the Birthdays bucket and
    // must not contribute to any marketing-channel attribution. Their
    // ticket revenue is removed from the Walk-in pool too.
    if (partyOrderIds.has(orderId)) {
      excludedTicketRev += ticketRevenueByOrder.get(orderId) || 0;
      continue;
    }
    const ticketRev = ticketRevenueByOrder.get(orderId) || 0;
    const entries = titlesByOrder.get(orderId) || [];
    const classified: Array<{ name: string; total: number; preClassifiedSource?: string }> = entries.map((e) => {
      const codeMatch = classifyByVoucherCode(e.code);
      if (codeMatch) {
        return { name: codeMatch.label, total: 0, preClassifiedSource: codeMatch.source };
      }
      const titleSource = classifyDiscountSourceStrict(e.title);
      if (titleSource !== UNATTRIBUTED_SOURCE) {
        return { name: cleanVoucherVariantLabel(e.title), total: 0, preClassifiedSource: titleSource };
      }
      return { name: cleanVoucherVariantLabel(e.title), total: 0 };
    });

    // Layer in face-value-driven attribution from the voucher channel map.
    const voucherAmounts = voucherPaymentsByOrder.get(orderId) || [];
    let faceValueAttributed = false;
    let faceValueIgnoredOnly = voucherAmounts.length > 0;
    if (voucherChannelMap && voucherAmounts.length > 0) {
      for (const amt of voucherAmounts) {
        const key = formatFaceValue(amt);
        const mapping = voucherChannelMap.get(key);
        if (!mapping) { faceValueIgnoredOnly = false; continue; }
        if (mapping.ignored) continue;
        if (mapping.channels.length === 0) { faceValueIgnoredOnly = false; continue; }
        faceValueIgnoredOnly = false;
        faceValueAttributed = true;
        for (const channel of mapping.channels) {
          classified.push({ name: `฿${key} voucher`, total: amt, preClassifiedSource: channel });
        }
      }
    }

    const hasChannelVoucher = classified.some((d) => d.preClassifiedSource);
    const hasAnyVoucher = classified.length > 0;
    if (!hasChannelVoucher && hasAnyVoucher) {
      // Order has only non-channel F&B vouchers — drop entirely.
      excludedTicketRev += ticketRev;
      continue;
    }
    // If the order only had voucher payments and every face value is
    // explicitly Ignored in the config (e.g. ฿350 generic F&B), exclude.
    if (
      !hasAnyVoucher &&
      voucherAmounts.length > 0 &&
      faceValueIgnoredOnly &&
      !faceValueAttributed
    ) {
      excludedTicketRev += ticketRev;
      continue;
    }
    sourceInputs.push({ revenue: ticketRev, discounts: classified });
  }

  const sourceBreakdown = buildSourceBreakdownStrict(
    sourceInputs,
    Math.max(0, totalTicketRevenueForSources - excludedTicketRev),
  );
  if (birthdaysBucketRev > 0 || partyOrderIds.size > 0) {
    // Insert before Walk-in (which is always last in buildSourceBreakdownStrict).
    const walkInIdx = sourceBreakdown.findIndex((e) => e.source === UNATTRIBUTED_SOURCE);
    const entry = {
      source: "Birthdays",
      orders: partyOrderIds.size,
      revenue: Math.round(birthdaysBucketRev * 100) / 100,
      discount: 0,
      variants: [],
    };
    if (walkInIdx >= 0) sourceBreakdown.splice(walkInIdx, 0, entry);
    else sourceBreakdown.push(entry);
  }

  const birthdayLinks = computeBirthdayLinks(
    activeOrders,
    orderRevenueById,
    categoryBreakdown,
    paidProducts,
    birthdayOverrides,
    activeProducts,
    activeOrderTotalById,
  );

  // task-111: expand bdOrderIds with Tier A/B/C accepted links so linked F&B
  // products (heuristic / code-linked) also receive the "bday" badge in
  // drill-downs. Retag in place.
  const bdAllIds = new Set<string>(bdOrderIds);
  if (birthdayLinks.links) {
    for (const lk of birthdayLinks.links) {
      if (lk.fnbOrderId) bdAllIds.add(String(lk.fnbOrderId));
      if (lk.partyOrderId) bdAllIds.add(String(lk.partyOrderId));
    }
  }
  // task-136: use categoryProducts (paid + partially-paid scaled) so the
  // rebuilt items[] match the same attribution that buildCategoryBreakdown
  // applied above. Using paidProducts alone would strip partial-attribution
  // line items back out on the rebuild.
  retagItemsBdayRevenue(categoryBreakdown as any, categoryProducts, bdAllIds, partyOrderIds);

  return {
    date,
    totalRevenue,
    totalOrders: activeOrders.length,
    totalGuests: 0,
    avgOrderValue: activeOrders.length > 0 ? totalRevenue / activeOrders.length : 0,
    paymentBreakdown,
    topProducts,
    categoryBreakdown,
    discountTotal,
    guestBreakdown,
    hourlyBreakdown,
    customerTypeSplit,
    voucherSwingAmount,
    pureTicketRevenue,
    sourceBreakdown,
    birthdayLinks,
    formulaVersion: FORMULA_VERSION,
  };
}

async function backfillBirthdayLinks(s: DailySummary): Promise<void> {
  if (s.birthdayLinks && s.formulaVersion === FORMULA_VERSION) return;
  try {
    const rawOrdersRes = await pool.query(
      "SELECT * FROM funtopia_raw_orders WHERE order_date = $1",
      [s.date],
    );
    const ordersResult = rawOrdersRes.rows.map((r: any) => ({
      ...r,
      order_id: String(r.order_id),
      total_amount: parseFloat(r.total_amount) || 0,
    }));
    const activeOrders = ordersResult.filter(
      (o: any) => o.payment_status?.toLowerCase() !== "voided",
    );
    if (activeOrders.length === 0) {
      s.birthdayLinks = {
        partyPackageRevenue: 0,
        partyFnbRevenue: 0,
        bdTickets: 0,
        combinedBirthdayTotal: s.categoryBreakdown?.["Events / Birthdays"]?.revenue || 0,
        linkedOrderCount: 0,
        partyOrderCount: 0,
        unresolvedNoteCodes: [],
        links: [],
        unmatchedPartyOrders: [],
      };
      s.formulaVersion = FORMULA_VERSION;
      return;
    }
    // Mirror buildSummaryFromRawData's filter: only Paid orders contribute products.
    const paidOrderIds = new Set<string>(
      activeOrders
        .filter((o: any) => o.payment_status?.toLowerCase() === "paid")
        .map((o: any) => String(o.order_id)),
    );
    const [productsRes, paymentsRes] = await Promise.all([
      pool.query(
        "SELECT order_id, product_name, product_category, quantity, subtotal FROM funtopia_orders WHERE order_date = $1",
        [s.date],
      ),
      pool.query(
        `SELECT id, synced_at, order_id, pay_method, pay_amount, refund_amount, raw_json
           FROM funtopia_raw_payments
          WHERE order_date = $1`,
        [s.date],
      ),
    ]);
    const activeOrderIdSet = new Set<string>(
      activeOrders.map((o: any) => String(o.order_id)),
    );
    // Do not reconstruct birthday cash from product subtotals. Product values
    // can be voucher-funded and don't reflect refunds. Use the same
    // deduplicated non-voucher payment basis as the fresh-summary path.
    const orderRevenueById = buildDedupedNonVoucherRevenueByOrder(
      paymentsRes.rows.map((r: any) => ({
        ...r,
        pay_amount: Number(r.pay_amount) || 0,
        refund_amount: Number(r.refund_amount) || 0,
      })),
    );
    const paidProducts: any[] = [];
    // task-135: also collect activeProducts so line-item party detection
    // catches partially-paid bookings.
    const activeProducts: any[] = [];
    for (const r of productsRes.rows) {
      const id = String(r.order_id);
      if (!activeOrderIdSet.has(id)) continue;
      const subtotal = parseFloat(r.subtotal) || 0;
      const prod = {
        order_id: id,
        product_title: r.product_name,
        category_title: r.product_category,
        product_quantity: parseInt(r.quantity) || 0,
        payment_price: subtotal,
      };
      activeProducts.push(prod);
      if (paidOrderIds.has(id)) {
        paidProducts.push(prod);
      }
    }
    const overrides = await loadFuntopiaBirthdayOverridesForDate(s.date);
    // task-135 follow-up: booking-value map for Events tab display revenue.
    const activeOrderTotalById = new Map<string, number>();
    for (const o of activeOrders as any[]) {
      activeOrderTotalById.set(String(o.order_id), Number(o.total_amount) || 0);
    }
    s.birthdayLinks = computeBirthdayLinks(
      activeOrders,
      orderRevenueById,
      s.categoryBreakdown || {},
      paidProducts,
      overrides,
      activeProducts,
      activeOrderTotalById,
    );

    // task-111: retag cached categoryBreakdown items with bdayRevenue so
    // historical drill-downs show the "bday" badge after the v12 formula
    // bump. Expanded set includes party orders, bday-token F&B, manual
    // overrides, AND Tier A/B/C accepted links from computeBirthdayLinks.
    try {
      const bdAllIds = new Set<string>();
      // task-135 v24: also track party-only IDs (subset of bdAllIds) so the
      // retag rebuild promotes party order line items into Events / Birthdays,
      // matching buildSummaryFromRawData. Without this the rebuild leaves
      // override-promoted parties (e.g. A48963) out of Events.items[].
      const partyOrderIds = new Set<string>();
      for (const p of activeProducts) {
        const name = (p.product_title || "").toString();
        if (isBirthdayPackage(name)) {
          bdAllIds.add(String(p.order_id));
          partyOrderIds.add(String(p.order_id));
        }
      }
      const orderIdByCode = new Map<string, string>();
      for (const o of activeOrders as any[]) {
        const code = String(o.order_code || "").toUpperCase();
        if (code) orderIdByCode.set(code, String(o.order_id));
      }
      for (const o of activeOrders as any[]) {
        const id = String(o.order_id);
        const noteRaw = o.note ? String(o.note) : "";
        const lower = normalizeNote(noteRaw);
        if (noteHasBirthdayMarker(lower, noteRaw)) {
          bdAllIds.add(id);
          // Mirror buildSummaryFromRawData: note-marked orders are parties.
          partyOrderIds.add(id);
        } else if (BDAY_FNB_TOKEN_REGEX.test(noteRaw)) {
          bdAllIds.add(id);
        }
      }
      if (overrides && overrides.size > 0) {
        for (const [overrideCode, row] of overrides) {
          const fnbId = orderIdByCode.get(overrideCode);
          if (fnbId) bdAllIds.add(fnbId);
          // Override-promoted party (no SKU match): promote to partyOrderIds.
          if (row.partyOrderCode) {
            const partyId = orderIdByCode.get(row.partyOrderCode);
            if (partyId) {
              bdAllIds.add(partyId);
              partyOrderIds.add(partyId);
            }
          }
        }
      }
      if (s.birthdayLinks?.links) {
        for (const lk of s.birthdayLinks.links) {
          if (lk.fnbOrderId) bdAllIds.add(String(lk.fnbOrderId));
          if (lk.partyOrderId) {
            bdAllIds.add(String(lk.partyOrderId));
            partyOrderIds.add(String(lk.partyOrderId));
          }
        }
      }
      retagItemsBdayRevenue(s.categoryBreakdown as any, paidProducts, bdAllIds, partyOrderIds);
    } catch (tagErr) {
      console.warn(`[Funtopia] bdayRevenue retag failed for ${s.date}`, tagErr);
    }

    s.formulaVersion = FORMULA_VERSION;
  } catch (e) {
    console.warn(`[Funtopia] backfillBirthdayLinks failed for ${s.date}`, e);
  }
}

async function getDailySummaryFromApi(date: string): Promise<DailySummary> {
  const apiSyncLock = await acquireFuntopiaApiSyncLock();
  try {
    return await getDailySummaryFromApiLocked(date);
  } finally {
    await releaseFuntopiaApiSyncLock(apiSyncLock);
  }
}

async function getDailySummaryFromApiLocked(date: string): Promise<DailySummary> {
  const startAt = `${date} 00:00:00`;
  const endAt = `${date} 23:59:59`;

  let ordersResultObj, productsResultObj, paymentsResultObj, walletPassesResultObj;
  try {
    const walletPassPromise = fetchAllPages("order_wallet_pass_usage_information", startAt, endAt)
      .catch((wpErr: any) => {
        console.warn(`[Funtopia] Wallet-pass fetch failed for ${date}: ${wpErr.message}`);
        return { items: [] as any[], expectedCount: 0, isPartial: false };
      });
    [ordersResultObj, productsResultObj, paymentsResultObj, walletPassesResultObj] = await Promise.all([
      fetchAllPages("order_basic_information", startAt, endAt),
      fetchAllPages("order_products_information", startAt, endAt),
      fetchAllPages("order_payments_information", startAt, endAt),
      walletPassPromise,
    ]);
  } catch (err: any) {
    await recordSyncHealth({
      date,
      status: "failed",
      errorMessage: err.message || "API fetch failed",
    });
    throw err;
  }

  const syncWarnings: string[] = [];
  let isPartialSync = false;

  if (ordersResultObj.isPartial) {
    isPartialSync = true;
    syncWarnings.push(`Partial order data: got ${ordersResultObj.items.length}/${ordersResultObj.expectedCount} (${Math.round(ordersResultObj.items.length / ordersResultObj.expectedCount * 100)}%)`);
  }
  if (productsResultObj.isPartial) {
    isPartialSync = true;
    syncWarnings.push(`Partial product data: got ${productsResultObj.items.length}/${productsResultObj.expectedCount}`);
  }
  if (paymentsResultObj.isPartial) {
    isPartialSync = true;
    syncWarnings.push(`Partial payment data: got ${paymentsResultObj.items.length}/${paymentsResultObj.expectedCount}`);
  }

  // Same-day blank-feed protection (Aug 2026 Pisell outage): the report API
  // sometimes returns 0 orders for the current day even though real sales
  // exist (Pisell's own dashboard shows them). storeRawOrders() unconditionally
  // deletes the day's rows before inserting, so an empty response would wipe
  // orders we already received — on Aug 13 a ฿6,900 birthday order appeared at
  // 11:20 and was erased by an empty response at 11:48. Never let an empty
  // same-day/yesterday response destroy existing data; keep what we have and
  // flag it in sync health instead.
  if (ordersResultObj.items.length === 0) {
    const bkkNow = new Date(Date.now() + 7 * 3600 * 1000);
    const bkkTodayStr = bkkNow.toISOString().split("T")[0];
    const bkkYesterday = new Date(bkkNow.getTime() - 24 * 3600 * 1000);
    const bkkYesterdayStr = bkkYesterday.toISOString().split("T")[0];
    if (date === bkkTodayStr || date === bkkYesterdayStr) {
      const existingCountResult = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM funtopia_raw_orders WHERE order_date = $1",
        [date]
      );
      const existingCount = existingCountResult.rows[0]?.cnt || 0;
      if (existingCount > 0) {
        const keepMsg = `API returned 0 orders for ${date} but ${existingCount} orders already stored — kept existing data (Pisell same-day feed blank)`;
        console.warn(`[Funtopia] ⚠ ${keepMsg}`);
        await recordSyncHealth({
          date,
          status: "skipped",
          ordersExpected: ordersResultObj.expectedCount,
          ordersReceived: 0,
          warnings: [keepMsg],
        });
        const summary = await buildSummaryFromDatabase(date);
        await setCachedSummary(date, summary);
        return summary;
      }
    }
  }

  await storeRawOrders(date, ordersResultObj.items, productsResultObj.items, paymentsResultObj.items);
  try {
    await storeWalletPasses(date, walletPassesResultObj.items || []);
  } catch (wpStoreErr: any) {
    console.warn(`[Funtopia] storeWalletPasses failed for ${date}: ${wpStoreErr.message}`);
  }

  await recordSyncHealth({
    date,
    status: isPartialSync ? "partial" : "clean",
    ordersExpected: ordersResultObj.expectedCount,
    ordersReceived: ordersResultObj.items.length,
    productsExpected: productsResultObj.expectedCount,
    productsReceived: productsResultObj.items.length,
    paymentsExpected: paymentsResultObj.expectedCount,
    paymentsReceived: paymentsResultObj.items.length,
    warnings: syncWarnings.length > 0 ? syncWarnings : undefined,
  });

  const summary = await buildSummaryFromDatabase(date);
  await setCachedSummary(date, summary);
  return summary;
}

const UNATTRIBUTED_BUCKET = "Other (Unattributed)";

function reclassifyCachedCategories(summary: DailySummary): void {
  const cb = summary.categoryBreakdown;
  if (!cb) return;

  // task-139 (v26): once a cached summary was built under v26+ the categories
  // came from the product registry (Pisell `product_id` → decision), which is
  // the source of truth. Re-running name/category heuristics on read here
  // would silently undo manual overrides (e.g. a SKU intentionally overridden
  // to Extras getting moved back to F&B by name match). So for v26+ caches we
  // short-circuit and trust the persisted decision. Older-version caches
  // (≤ v25) trigger a full raw rebuild via formulaVersion mismatch in both
  // getDailySummary and getDateRangeSummary, so this self-heal only ever runs
  // on legacy caches it was designed for.
  if (summary.formulaVersion === FORMULA_VERSION) return;

  const allCats = ["Extras", "Tickets & Packages", "Merchandise"];
  for (const srcCat of allCats) {
    const src = cb[srcCat];
    if (!src || !src.items || src.items.length === 0) continue;

    // task-139: reconcileCategoryBreakdown may have already scaled src.revenue
    // down (or up) relative to the raw items_sum to match cash-basis
    // totalRevenue. When we move items out we must scale the moved revenue by
    // the same factor — subtracting the raw item.revenue from a scaled-down
    // src.revenue pushes it negative (e.g. today 2026-05-27: Extras scaled to
    // ฿48.87 with one ฿56.07 Socks item → moving Socks made Extras = -฿7.21).
    // Items in items[] keep their raw revenue (true sale price); only the
    // bucket math uses the scaled share so totals stay consistent.
    const srcItemsSumPre = src.items.reduce((s: number, it: any) => s + (it.revenue || 0), 0);
    const rawFactor = srcItemsSumPre > 0 ? src.revenue / srcItemsSumPre : 1;
    // Clamp into [0, 1]: a factor > 1 means reconcile scaled UP (very rare),
    // in which case preserving raw item.revenue is safest. A factor < 0 means
    // src is already negative — don't propagate the negative into a sibling.
    const srcScaleFactor = Math.max(0, Math.min(1, rawFactor));
    const scale = (rev: number) => Math.round(rev * srcScaleFactor * 100) / 100;

    const keep: typeof src.items = [];
    for (const item of src.items) {
      const name = item.name || "";
      const movedRev = scale(item.revenue || 0);
      if (isSocksProduct(name)) {
        if (!cb["Socks"]) {
          cb["Socks"] = { revenue: 0, quantity: 0, items: [] };
        }
        cb["Socks"].revenue += movedRev;
        cb["Socks"].quantity += item.quantity;
        cb["Socks"].items.push(item);
        src.revenue -= movedRev;
        src.quantity -= item.quantity;
      } else if (isNannyOrDropoff(name)) {
        if (!cb["Nanny & Drop-off"]) {
          cb["Nanny & Drop-off"] = { revenue: 0, quantity: 0, items: [] };
        }
        cb["Nanny & Drop-off"].revenue += movedRev;
        cb["Nanny & Drop-off"].quantity += item.quantity;
        cb["Nanny & Drop-off"].items.push(item);
        src.revenue -= movedRev;
        src.quantity -= item.quantity;
      } else if (isBirthdayPackage(name)) {
        if (!cb["Events / Birthdays"]) {
          cb["Events / Birthdays"] = { revenue: 0, quantity: 0, items: [] };
        }
        cb["Events / Birthdays"].revenue += movedRev;
        cb["Events / Birthdays"].quantity += item.quantity;
        cb["Events / Birthdays"].items.push(item);
        src.revenue -= movedRev;
        src.quantity -= item.quantity;
      } else if (srcCat === "Extras" && isFoodOrDrinkProduct(name)) {
        // v25: F&B items mis-categorized to Extras (Pisell off-whitelist
        // category_titles like "Asian Food", "Open Item", "CHOCOLATE",
        // "Kids juice", "seasonal", "Soup") are moved into F&B and routed
        // to the Food vs Drinks sub-category by name, so cached days
        // self-heal on read without a forced re-sync.
        const fnbKind = isFoodOrDrinkProduct(name)!;
        if (!cb["F&B"]) {
          cb["F&B"] = {
            revenue: 0, quantity: 0, items: [],
            subCategories: {
              "Food": { revenue: 0, quantity: 0, items: [] },
              "Drinks": { revenue: 0, quantity: 0, items: [] },
            },
          };
        }
        const fnb = cb["F&B"];
        fnb.revenue += movedRev;
        fnb.quantity += item.quantity;
        fnb.items = fnb.items || [];
        fnb.items.push(item);
        if (!fnb.subCategories) {
          fnb.subCategories = {
            "Food": { revenue: 0, quantity: 0, items: [] },
            "Drinks": { revenue: 0, quantity: 0, items: [] },
          };
        }
        if (!fnb.subCategories[fnbKind]) {
          fnb.subCategories[fnbKind] = { revenue: 0, quantity: 0, items: [] };
        }
        fnb.subCategories[fnbKind].revenue += movedRev;
        fnb.subCategories[fnbKind].quantity += item.quantity;
        fnb.subCategories[fnbKind].items.push(item);
        src.revenue -= movedRev;
        src.quantity -= item.quantity;
      } else if (srcCat === "Extras" && isIndianPackage(name)) {
        // v16: Indian packages were previously misclassified to Extras
        // because TICKET_CATEGORIES omitted "indian". Move them into
        // Tickets & Packages > Indian on read so cached days self-heal.
        if (!cb["Tickets & Packages"]) {
          cb["Tickets & Packages"] = { revenue: 0, quantity: 0, items: [], subCategories: {} };
        }
        const tickets = cb["Tickets & Packages"];
        tickets.revenue += movedRev;
        tickets.quantity += item.quantity;
        tickets.items = tickets.items || [];
        tickets.items.push(item);
        if (!tickets.subCategories) tickets.subCategories = {};
        if (!tickets.subCategories["Indian"]) {
          tickets.subCategories["Indian"] = { revenue: 0, quantity: 0, items: [] };
        }
        tickets.subCategories["Indian"].revenue += movedRev;
        tickets.subCategories["Indian"].quantity += item.quantity;
        tickets.subCategories["Indian"].items.push(item);
        src.revenue -= movedRev;
        src.quantity -= item.quantity;
      } else {
        keep.push(item);
      }
    }
    src.items = keep;
    // Clamp cent-level rounding drift (per-item Math.round residual) so the
    // bucket doesn't render as e.g. -฿0.01.
    if (Math.abs(src.revenue) < 0.01) src.revenue = 0;

    if (srcCat === "Tickets & Packages" && src.subCategories) {
      for (const [subKey, subCat] of Object.entries(src.subCategories)) {
        if (!subCat || !subCat.items) continue;
        const subKeep: typeof subCat.items = [];
        for (const item of subCat.items) {
          if (isNannyOrDropoff(item.name)) {
            subCat.revenue -= item.revenue;
            subCat.quantity -= item.quantity;
          } else if (isBirthdayPackage(item.name)) {
            subCat.revenue -= item.revenue;
            subCat.quantity -= item.quantity;
          } else {
            subKeep.push(item);
          }
        }
        subCat.items = subKeep;
      }
    }
  }

  // Reverse sweep: items previously parked in "Nanny & Drop-off" that no
  // longer match isNannyOrDropoff (e.g. "Extra 1 hour kid", which Pisell
  // tags as "Ticket​" — it's a play-time extension, not a nanny service)
  // are moved back into Tickets & Packages so cached days self-heal on read.
  const nanny = cb["Nanny & Drop-off"];
  if (nanny && nanny.items && nanny.items.length > 0) {
    const stillNanny: typeof nanny.items = [];
    for (const item of nanny.items) {
      if (isNannyOrDropoff(item.name || "")) {
        stillNanny.push(item);
        continue;
      }
      if (!cb["Tickets & Packages"]) {
        cb["Tickets & Packages"] = { revenue: 0, quantity: 0, items: [], subCategories: {} };
      }
      const tickets = cb["Tickets & Packages"];
      tickets.items = tickets.items || [];
      tickets.items.push(item);
      tickets.revenue += item.revenue;
      tickets.quantity += item.quantity;
      nanny.revenue -= item.revenue;
      nanny.quantity -= item.quantity;
    }
    nanny.items = stillNanny;
  }

  if (cb["Nanny & Drop-off"]) {
    cb["Nanny & Drop-off"].items.sort((a: any, b: any) => b.revenue - a.revenue);
  }
  if (cb["Tickets & Packages"]?.items) {
    cb["Tickets & Packages"].items.sort((a: any, b: any) => b.revenue - a.revenue);
  }
  if (cb["Events / Birthdays"]) {
    cb["Events / Birthdays"].items.sort((a: any, b: any) => b.revenue - a.revenue);
  }

  // Self-heal previously-inflated cached days. Old reconcileCategoryBreakdown
  // scaled every category up to match totalRevenue when collected payments
  // exceeded line-item subtotals (e.g. a Partially-Paid order contributed its
  // payment to revenue but its products were excluded from paidProducts).
  // The scale dumped the residual onto the smallest non-zero category — e.g.
  // May 21 showed Merchandise = ฿3,450 with one ฿420 item. We detect that
  // shape (stored revenue ≫ items sum) and revert to honest item-based
  // revenue, parking the unattributed remainder in its own bucket so the
  // daily total still reconciles.
  const itemsRevenue = (entry: any): number => {
    let s = 0;
    for (const it of entry?.items || []) s += it.revenue || 0;
    if (entry?.subCategories) {
      for (const sub of Object.values(entry.subCategories) as any[]) {
        for (const it of sub?.items || []) s += it.revenue || 0;
      }
    }
    return s;
  };
  let storedSum = 0;
  let healedItemsSum = 0;
  let needsHeal = false;
  for (const entry of Object.values(cb) as any[]) {
    const stored = entry.revenue || 0;
    const itemsRev = itemsRevenue(entry);
    storedSum += stored;
    healedItemsSum += itemsRev;
    // Inflated marker: stored revenue exceeds items sum by > ฿1 and > 5%.
    if (stored > itemsRev + 1 && stored > itemsRev * 1.05 && itemsRev > 0) {
      needsHeal = true;
    }
  }
  if (needsHeal && storedSum > healedItemsSum + 1) {
    for (const entry of Object.values(cb) as any[]) {
      const itemsRev = itemsRevenue(entry);
      if (itemsRev > 0 && entry.revenue > itemsRev + 1) {
        entry.revenue = Math.round(itemsRev * 100) / 100;
        entry.quantity = (entry.items || []).reduce((q: number, it: any) => q + (it.quantity || 0), 0);
        if (entry.subCategories) {
          for (const sub of Object.values(entry.subCategories) as any[]) {
            const subItemsRev = (sub.items || []).reduce((s: number, it: any) => s + (it.revenue || 0), 0);
            if (subItemsRev > 0 && sub.revenue > subItemsRev + 1) {
              sub.revenue = Math.round(subItemsRev * 100) / 100;
              sub.quantity = (sub.items || []).reduce((q: number, it: any) => q + (it.quantity || 0), 0);
            }
          }
        }
      }
    }
    const newCatSum = Object.values(cb).reduce(
      (s: number, e: any) => s + (e.revenue || 0),
      0,
    );
    const residual = Math.round((storedSum - newCatSum) * 100) / 100;
    if (residual > 0.01) {
      cb[UNATTRIBUTED_BUCKET] = {
        revenue: residual,
        quantity: 0,
        items: [],
      };
    } else {
      delete cb[UNATTRIBUTED_BUCKET];
    }
  }
}

function reconcileCategoryBreakdown(
  categoryBreakdown: Record<string, any>,
  totalRevenue: number,
  unattributedItems?: CategoryItem[],
): void {
  // Strip any prior unattributed bucket before reconciling so re-runs don't
  // double-bucket the residual.
  delete categoryBreakdown[UNATTRIBUTED_BUCKET];

  const catSum = Object.values(categoryBreakdown).reduce(
    (sum: number, entry: any) => sum + (entry.revenue || 0),
    0
  );
  const diff = totalRevenue - catSum;
  // task-136: v25 attributes partially-paid order line items proportionally
  // (share = netCollected / productSum) so the Unattributed bucket only
  // contains residuals that can't be assigned to a real category:
  //   - orders with payment > 0 but no line items (positive-revenue items)
  //   - voucher-refund orders (zero-revenue items — they pulled total down)
  //   - rounding remainder (< ฿1 typically)
  // Each item carries orderCode + reason + createdAt + paymentStatus so the
  // dashboard can render a per-order drill-down opening the order modal.
  const allItems = (unattributedItems || []).slice();
  const positiveItems = allItems.filter((it) => (it.revenue || 0) > 0.005);
  const zeroItems = allItems.filter((it) => (it.revenue || 0) <= 0.005);
  const positiveSum = positiveItems.reduce((s, it) => s + (it.revenue || 0), 0);

  if (Math.abs(diff) <= 0.01 && positiveSum <= 0.01 && zeroItems.length === 0) return;

  if (diff < -0.01) {
    // Categories overshoot totalRevenue (refund/rounding net negative). Scale
    // every category proportionally — do NOT add a positive bucket. Zero-
    // revenue drill-down rows (voucher refunds, etc.) are still attached so
    // the user can see which orders dragged the total down.
    if (catSum > 0.01) {
      const factor = totalRevenue / catSum;
      for (const entry of Object.values(categoryBreakdown) as any[]) {
        entry.revenue = Math.round((entry.revenue || 0) * factor * 100) / 100;
        if (entry.subCategories) {
          for (const sub of Object.values(entry.subCategories) as any[]) {
            sub.revenue = Math.round((sub.revenue || 0) * factor * 100) / 100;
          }
        }
      }
    }
    if (zeroItems.length > 0 || positiveItems.length > 0) {
      categoryBreakdown[UNATTRIBUTED_BUCKET] = {
        revenue: 0,
        quantity: 0,
        // positive items are zeroed in this overshoot branch so totals stay
        // consistent — they still appear in drill-down with reason intact.
        items: [
          ...positiveItems.map((it) => ({ ...it, revenue: 0 })),
          ...zeroItems,
        ],
      };
    }
    return;
  }

  // diff >= 0: bucket revenue = diff; explicit positive items fit inside the
  // diff (scaled down if their sum exceeds it). Rounding remainder fills the
  // gap so the bar still sums to totalRevenue.
  if (diff > 0.01 || positiveItems.length > 0 || zeroItems.length > 0) {
    const items: CategoryItem[] = [];
    if (positiveSum > diff + 0.01 && diff > 0.005) {
      const factor = diff / positiveSum;
      for (const it of positiveItems) {
        items.push({ ...it, revenue: Math.round((it.revenue || 0) * factor * 100) / 100 });
      }
    } else {
      for (const it of positiveItems) {
        items.push({ ...it, revenue: Math.round((it.revenue || 0) * 100) / 100 });
      }
      const usedSum = items.reduce((s, it) => s + (it.revenue || 0), 0);
      const remainder = Math.round((diff - usedSum) * 100) / 100;
      if (remainder > 0.01) {
        items.push({
          name: "Rounding / voucher residual",
          category: "Rounding",
          revenue: remainder,
          quantity: 0,
          orderCode: "—",
          reason: "Rounding or voucher refund residual",
          paymentStatus: "—",
          createdAt: null,
        });
      }
    }
    // Append zero-revenue voucher-refund entries last for visibility.
    items.push(...zeroItems);
    const bucketRev = Math.round(diff * 100) / 100;
    if (bucketRev > 0.01 || items.length > 0) {
      categoryBreakdown[UNATTRIBUTED_BUCKET] = {
        revenue: Math.max(0, bucketRev),
        quantity: 0,
        items,
      };
    }
    return;
  }
  // Unreachable: diff in (-0.01, 0.01] with no items returns early above;
  // diff < -0.01 returns in the overshoot branch; diff > 0 or items present
  // returns in the bucket branch.
}

async function fixCachedRevenue(s: DailySummary): Promise<boolean> {
  if (!s.date) return false;
  try {
    // Two layers of dedupe so this query is fully self-healing even if a
    // concurrent sync race somehow plants duplicates after cleanup ran:
    //   1) Dedupe ORDERS by order_id (keep most recently synced row) so an
    //      order appearing under two order_dates can't multiply payment rows
    //      in the JOIN.
    //   2) Dedupe PAYMENTS by Pisell payment id (raw_json->>'id'), with a
    //      composite-key fallback for older rows lacking it, so a duplicate
    //      payment row left behind by a sync race can't double-count.
    const [payCollectedRes, voucherRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(CAST(rp.pay_amount AS NUMERIC) - CAST(rp.refund_amount AS NUMERIC)), 0) AS collected
         FROM (
           SELECT DISTINCT ON (
             COALESCE(
               raw_json->>'id',
               order_id || '|' || COALESCE(payment_at, '') || '|' || pay_amount::text || '|' || COALESCE(pay_method, '')
             )
           ) order_id, pay_amount, refund_amount, pay_method
           FROM funtopia_raw_payments
           WHERE order_date = $1
           ORDER BY
             COALESCE(
               raw_json->>'id',
               order_id || '|' || COALESCE(payment_at, '') || '|' || pay_amount::text || '|' || COALESCE(pay_method, '')
             ),
             id ASC
         ) rp
         JOIN (
           SELECT DISTINCT ON (order_id) order_id, payment_status
           FROM funtopia_raw_orders
           ORDER BY order_id, synced_at DESC
         ) ro ON rp.order_id = ro.order_id
         WHERE LOWER(ro.payment_status) != 'voided'`,
        [s.date]
      ),
      pool.query(
        `SELECT COALESCE(SUM(CAST(rp.pay_amount AS NUMERIC) - CAST(rp.refund_amount AS NUMERIC)), 0) AS voucher_total
         FROM (
           SELECT DISTINCT ON (
             COALESCE(
               raw_json->>'id',
               order_id || '|' || COALESCE(payment_at, '') || '|' || pay_amount::text || '|' || COALESCE(pay_method, '')
             )
           ) order_id, pay_amount, refund_amount, pay_method
           FROM funtopia_raw_payments
           WHERE order_date = $1
           ORDER BY
             COALESCE(
               raw_json->>'id',
               order_id || '|' || COALESCE(payment_at, '') || '|' || pay_amount::text || '|' || COALESCE(pay_method, '')
             ),
             id ASC
         ) rp
         JOIN (
           SELECT DISTINCT ON (order_id) order_id, payment_status
           FROM funtopia_raw_orders
           ORDER BY order_id, synced_at DESC
         ) ro ON rp.order_id = ro.order_id
         WHERE LOWER(ro.payment_status) != 'voided' AND LOWER(rp.pay_method) LIKE '%voucher%'`,
        [s.date]
      ),
    ]);
    const collected = parseFloat(payCollectedRes.rows[0]?.collected) || 0;
    const voucherTotal = parseFloat(voucherRes.rows[0]?.voucher_total) || 0;
    const netRev = collected - voucherTotal;
    if (collected > 0 && Math.abs(netRev - s.totalRevenue) > 0.01) {
      console.warn(`[Funtopia fixCachedRevenue] Auto-correcting revenue for ${s.date}: ${s.totalRevenue} → ${netRev} (diff: ${(netRev - s.totalRevenue).toFixed(2)})`);
      s.totalRevenue = netRev;
      s.avgOrderValue = s.totalOrders > 0 ? netRev / s.totalOrders : 0;
      if (s.categoryBreakdown) {
        reconcileCategoryBreakdown(s.categoryBreakdown, netRev);
      }
      const ticketCatRevenue = s.categoryBreakdown?.["Tickets & Packages"]?.revenue || 0;
      s.pureTicketRevenue = ticketCatRevenue - (s.voucherSwingAmount || 0);
      return true;
    }
  } catch (_e) {
  }
  return false;
}

async function computeFuntopiaSourceBreakdownForDate(
  date: string,
  _totalRevenue: number,
): Promise<SourceBreakdownEntry[]> {
  try {
    const [ordersRes, productsRes, walletPassesRes, paymentsRes, voucherChannelMap] = await Promise.all([
      pool.query(
        "SELECT order_id, payment_status, total_amount, channel, note FROM funtopia_raw_orders WHERE order_date = $1",
        [date],
      ),
      pool.query(
        "SELECT order_id, product_name, product_category, subtotal FROM funtopia_orders WHERE order_date = $1",
        [date],
      ),
      pool.query(
        "SELECT order_id, title, action, redeem_amount, code FROM funtopia_raw_wallet_passes WHERE order_date = $1",
        [date],
      ),
      pool.query(
        "SELECT order_id, pay_method, pay_amount, refund_amount FROM funtopia_raw_payments WHERE order_date = $1",
        [date],
      ),
      getVoucherChannelMap(),
    ]);
    const voucherPaymentsByOrder = new Map<string, number[]>();
    for (const r of paymentsRes.rows) {
      if (normalizePaymentMethod(r.pay_method || "") !== "Voucher") continue;
      const amt = (parseFloat(r.pay_amount) || 0) - (parseFloat(r.refund_amount) || 0);
      if (amt <= 0) continue;
      const id = String(r.order_id);
      const list = voucherPaymentsByOrder.get(id) || [];
      list.push(amt);
      voucherPaymentsByOrder.set(id, list);
    }
    const ticketRevenueByOrder = new Map<string, number>();
    for (const row of productsRes.rows) {
      const rawCat = String(row.product_category || "");
      if (classifyCategory(rawCat) !== "Tickets & Packages") continue;
      const name = String(row.product_name || "").toLowerCase();
      if (/(\d+)\s*voucher/.test(name)) continue;
      const id = String(row.order_id);
      ticketRevenueByOrder.set(id, (ticketRevenueByOrder.get(id) || 0) + (parseFloat(row.subtotal) || 0));
    }
    let totalTicketRev = 0;
    ticketRevenueByOrder.forEach((v) => { totalTicketRev += v; });

    const activeOrders = ordersRes.rows.filter(
      (o: any) => (o.payment_status || "").toLowerCase() !== "voided",
    );

    // task-111: detect birthday-party orders so they can be removed from
    // marketing-channel attribution and surfaced as their own Birthdays
    // source bucket (package revenue only). Mirrors buildSummaryFromRawData.
    const partyOrderIds = new Set<string>();
    let birthdaysBucketRev = 0;
    for (const row of productsRes.rows) {
      const name = String(row.product_name || "");
      if (isBirthdayPackage(name)) partyOrderIds.add(String(row.order_id));
    }
    for (const o of activeOrders as any[]) {
      const noteRaw = o.note ? String(o.note) : "";
      const lower = normalizeNote(noteRaw);
      if (noteHasBirthdayMarker(lower, noteRaw)) partyOrderIds.add(String(o.order_id));
    }
    for (const row of productsRes.rows) {
      const orderId = String(row.order_id);
      if (!partyOrderIds.has(orderId)) continue;
      const rawCat = String(row.product_category || "");
      const name = String(row.product_name || "");
      const cls = classifyCategory(rawCat);
      if (isBirthdayPackage(name) || cls === "Events / Birthdays") {
        birthdaysBucketRev += parseFloat(row.subtotal) || 0;
      }
    }

    const walletPasses = walletPassesRes.rows.map((r: any) => ({
      order_id: String(r.order_id),
      title: r.title,
      action: r.action,
      redeem_amount: parseFloat(r.redeem_amount) || 0,
      code: r.code,
    }));
    const titlesByOrder = walletPasses.length > 0
      ? indexRedeemedTitlesByOrder(walletPasses)
      : new Map<string, Array<{ title: string; code: string }>>();

    // Pisell now returns `order_sales_channel` per order (May 2026). When the
    // value maps to one of our known marketing channels (Tops, Airport, Sales
    // Booth, …), it overrides voucher-face-value attribution: the whole
    // order's ticket revenue is credited to that channel. Generic values like
    // "Terminal" don't match the registry and fall through to voucher logic.
    const channelByOrder = new Map<string, string>();
    for (const o of ordersRes.rows as any[]) {
      const ch = o.channel ? String(o.channel).trim() : "";
      if (!ch) continue;
      const mapped = classifyDiscountSourceStrict(ch);
      if (mapped !== UNATTRIBUTED_SOURCE) channelByOrder.set(String(o.order_id), mapped);
    }

    let excludedTicketRev = 0;
    const sourceInputs: Array<{ revenue: number; discounts: Array<{ name: string; total: number; preClassifiedSource?: string }> }> = [];
    for (const o of activeOrders) {
      const id = String(o.order_id);
      // task-111: skip party orders — they're surfaced under Birthdays.
      if (partyOrderIds.has(id)) {
        excludedTicketRev += ticketRevenueByOrder.get(id) || 0;
        continue;
      }
      const ticketRev = ticketRevenueByOrder.get(id) || 0;

      // Channel-driven attribution wins over voucher-face-value when present.
      const channelSource = channelByOrder.get(id);
      if (channelSource) {
        sourceInputs.push({
          revenue: ticketRev,
          discounts: [{ name: channelSource, total: 0, preClassifiedSource: channelSource }],
        });
        continue;
      }

      const entries = titlesByOrder.get(id) || [];
      const classified: Array<{ name: string; total: number; preClassifiedSource?: string }> = entries.map((e) => {
        const codeMatch = classifyByVoucherCode(e.code);
        if (codeMatch) {
          return { name: codeMatch.label, total: 0, preClassifiedSource: codeMatch.source };
        }
        const titleSource = classifyDiscountSourceStrict(e.title);
        if (titleSource !== UNATTRIBUTED_SOURCE) {
          return { name: cleanVoucherVariantLabel(e.title), total: 0, preClassifiedSource: titleSource };
        }
        return { name: cleanVoucherVariantLabel(e.title), total: 0 };
      });

      // Face-value-driven attribution from funtopia_voucher_channel_map.
      // Lets admins map ฿690 / ฿890 / ฿1090 (and any other face value) to a
      // sales channel in Config, and have those redemptions credited here.
      const voucherAmounts = voucherPaymentsByOrder.get(id) || [];
      let faceValueAttributed = false;
      let faceValueIgnoredOnly = voucherAmounts.length > 0;
      for (const amt of voucherAmounts) {
        const key = formatFaceValue(amt);
        const mapping = voucherChannelMap.get(key);
        if (!mapping) { faceValueIgnoredOnly = false; continue; }
        if (mapping.ignored) continue;
        if (mapping.channels.length === 0) { faceValueIgnoredOnly = false; continue; }
        faceValueIgnoredOnly = false;
        faceValueAttributed = true;
        for (const channel of mapping.channels) {
          classified.push({ name: `฿${key} voucher`, total: amt, preClassifiedSource: channel });
        }
      }

      const hasChannelVoucher = classified.some((d) => d.preClassifiedSource);
      const hasAnyVoucher = classified.length > 0;
      if (!hasChannelVoucher && hasAnyVoucher) {
        excludedTicketRev += ticketRev;
        continue;
      }
      if (
        !hasAnyVoucher &&
        voucherAmounts.length > 0 &&
        faceValueIgnoredOnly &&
        !faceValueAttributed
      ) {
        excludedTicketRev += ticketRev;
        continue;
      }
      sourceInputs.push({ revenue: ticketRev, discounts: classified });
    }

    const sourceBreakdown = buildSourceBreakdownStrict(
      sourceInputs,
      Math.max(0, totalTicketRev - excludedTicketRev),
    );
    if (birthdaysBucketRev > 0 || partyOrderIds.size > 0) {
      const walkInIdx = sourceBreakdown.findIndex((e) => e.source === UNATTRIBUTED_SOURCE);
      const entry = {
        source: "Birthdays",
        orders: partyOrderIds.size,
        revenue: Math.round(birthdaysBucketRev * 100) / 100,
        discount: 0,
        variants: [],
      };
      if (walkInIdx >= 0) sourceBreakdown.splice(walkInIdx, 0, entry);
      else sourceBreakdown.push(entry);
    }
    return sourceBreakdown;
  } catch (e) {
    console.warn(`[Funtopia] computeSourceBreakdown failed for ${date}`, e);
    return [];
  }
}

export async function getDailySummary(date: string): Promise<DailySummary | null> {
  await initCacheTable();
  const cached = await getCachedSummary(date);

  if (!cached) return null;

  const expectedSummary = structuredClone(cached);
  let dirty = await fixCachedRevenue(cached);

  if (cached.customerTypeSplit) {
    for (const ct of cached.customerTypeSplit) {
      if (ct.type === "Special") ct.type = "Eat & Play Package";
    }
  }
  if (cached.categoryBreakdown?.["Tickets & Packages"]?.subCategories?.["Special"]) {
    const sub = cached.categoryBreakdown["Tickets & Packages"].subCategories;
    sub["Eat & Play Package"] = sub["Special"];
    delete sub["Special"];
  }
  reclassifyCachedCategories(cached);

  if (
    !cached.sourceBreakdown ||
    cached.sourceBreakdown.length === 0 ||
    cached.formulaVersion !== FORMULA_VERSION
  ) {
    cached.sourceBreakdown = await computeFuntopiaSourceBreakdownForDate(
      date,
      cached.totalRevenue,
    );
    cached.formulaVersion = FORMULA_VERSION;
    dirty = true;
  }

  // Make sure birthdayLinks + categoryBreakdown reflect the current floresta
  // birthday allocation. Idempotent — only persists when something actually
  // changed.
  //
  // v23 migration: when formulaVersion mismatches we need to rebuild the
  // categoryBreakdown buckets too (not just birthdayLinks), because v23
  // reclassifies party-promoted order line items into "Events / Birthdays".
  // backfillBirthdayLinks alone only rebuilds the items[] arrays — it can't
  // shift revenue between category buckets. So on formula mismatch we do a
  // full re-summarise from raw and replace the cached entry. Falls back to
  // backfillBirthdayLinks if the raw rebuild fails (e.g. raw rows missing).
  {
    if (!cached.birthdayLinks || cached.formulaVersion !== FORMULA_VERSION) {
      let rebuilt = false;
      try {
        const fresh = await rebuildAndCacheSummaryWithApiLock(date);
        if (fresh && fresh.formulaVersion === FORMULA_VERSION) {
          Object.assign(cached, fresh);
          rebuilt = true;
        }
      } catch (e) {
        console.warn(`[Funtopia] v23 raw rebuild failed for ${date}, falling back to backfill`, e);
      }
      if (!rebuilt) await backfillBirthdayLinks(cached);
      dirty = true;
    }
    const allocation = await getBirthdayAllocation("floresta");
    if (ensureBirthdayAllocationStampedSync(cached, allocation)) dirty = true;
    if (dirty) {
      setCachedSummaryIfUnchanged(date, cached, expectedSummary).then((written) => {
        if (!written) {
          console.info(`[Funtopia] Skipped stale derived cache write for ${date}`);
        }
      }).catch(() => {});
    }
  }

  return cached;
}

export interface SyncHealthRecord {
  id: number;
  date: string;
  syncedAt: string;
  status: "clean" | "partial" | "failed" | "skipped";
  ordersExpected: number;
  ordersReceived: number;
  productsExpected: number;
  productsReceived: number;
  paymentsExpected: number;
  paymentsReceived: number;
  errorMessage: string | null;
  warnings: string[] | null;
  revenueDivergence?: RevenueDivergence | null;
}

export interface RevenueDivergence {
  cached: number;
  fresh: number;
  diff: number;
}

const REVENUE_DIVERGENCE_THRESHOLD = 1;

export async function computeRevenueDivergence(date: string): Promise<RevenueDivergence | null> {
  if (!date) return null;
  try {
    const cached = await getCachedSummary(date);
    if (!cached) return null;
    const [payCollectedRes, voucherRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(CAST(rp.pay_amount AS NUMERIC) - CAST(rp.refund_amount AS NUMERIC)), 0) AS collected
         FROM (
           SELECT DISTINCT ON (
             COALESCE(
               raw_json->>'id',
               order_id || '|' || COALESCE(payment_at, '') || '|' || pay_amount::text || '|' || COALESCE(pay_method, '')
             )
           ) order_id, pay_amount, refund_amount, pay_method
           FROM funtopia_raw_payments
           WHERE order_date = $1
           ORDER BY
             COALESCE(
               raw_json->>'id',
               order_id || '|' || COALESCE(payment_at, '') || '|' || pay_amount::text || '|' || COALESCE(pay_method, '')
             ),
             id ASC
         ) rp
         JOIN (
           SELECT DISTINCT ON (order_id) order_id, payment_status
           FROM funtopia_raw_orders
           ORDER BY order_id, synced_at DESC
         ) ro ON rp.order_id = ro.order_id
         WHERE LOWER(ro.payment_status) != 'voided'`,
        [date]
      ),
      pool.query(
        `SELECT COALESCE(SUM(CAST(rp.pay_amount AS NUMERIC) - CAST(rp.refund_amount AS NUMERIC)), 0) AS voucher_total
         FROM (
           SELECT DISTINCT ON (
             COALESCE(
               raw_json->>'id',
               order_id || '|' || COALESCE(payment_at, '') || '|' || pay_amount::text || '|' || COALESCE(pay_method, '')
             )
           ) order_id, pay_amount, refund_amount, pay_method
           FROM funtopia_raw_payments
           WHERE order_date = $1
           ORDER BY
             COALESCE(
               raw_json->>'id',
               order_id || '|' || COALESCE(payment_at, '') || '|' || pay_amount::text || '|' || COALESCE(pay_method, '')
             ),
             id ASC
         ) rp
         JOIN (
           SELECT DISTINCT ON (order_id) order_id, payment_status
           FROM funtopia_raw_orders
           ORDER BY order_id, synced_at DESC
         ) ro ON rp.order_id = ro.order_id
         WHERE LOWER(ro.payment_status) != 'voided' AND LOWER(rp.pay_method) LIKE '%voucher%'`,
        [date]
      ),
    ]);
    const collected = parseFloat(payCollectedRes.rows[0]?.collected) || 0;
    const voucherTotal = parseFloat(voucherRes.rows[0]?.voucher_total) || 0;
    if (collected <= 0) return null;
    const fresh = collected - voucherTotal;
    const cachedRev = Number(cached.totalRevenue) || 0;
    const diff = fresh - cachedRev;
    return {
      cached: Math.round(cachedRev * 100) / 100,
      fresh: Math.round(fresh * 100) / 100,
      diff: Math.round(diff * 100) / 100,
    };
  } catch (err) {
    console.warn(`[Funtopia computeRevenueDivergence] failed for ${date}:`, err);
    return null;
  }
}

export async function scanRevenueDivergence(lookbackDays: number = 14): Promise<Array<{ date: string; divergence: RevenueDivergence }>> {
  const out: Array<{ date: string; divergence: RevenueDivergence }> = [];
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  // Skip today: an incomplete day is expected to diverge and would create noise.
  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const div = await computeRevenueDivergence(dateStr);
    if (div && Math.abs(div.diff) > REVENUE_DIVERGENCE_THRESHOLD) {
      out.push({ date: dateStr, divergence: div });
    }
  }
  return out;
}

export function startRevenueDivergenceMonitor(intervalMs: number = 24 * 60 * 60 * 1000) {
  const run = async () => {
    try {
      const flagged = await scanRevenueDivergence(14);
      if (flagged.length > 0) {
        console.warn(
          `[Funtopia RevenueDivergenceMonitor] ${flagged.length} day(s) diverge from Pisell by > ฿${REVENUE_DIVERGENCE_THRESHOLD}:`,
          flagged.map(f => `${f.date}: cached=${f.divergence.cached} fresh=${f.divergence.fresh} diff=${f.divergence.diff}`).join("; ")
        );
      }
    } catch (err) {
      console.warn(`[Funtopia RevenueDivergenceMonitor] scan error:`, err);
    }
  };
  // Defer first run so server startup is not blocked
  setTimeout(run, 30 * 1000);
  setInterval(run, intervalMs);
}

export async function recordSyncHealth(params: {
  date: string;
  status: "clean" | "partial" | "failed" | "skipped";
  ordersExpected?: number;
  ordersReceived?: number;
  productsExpected?: number;
  productsReceived?: number;
  paymentsExpected?: number;
  paymentsReceived?: number;
  errorMessage?: string;
  warnings?: string[];
}): Promise<void> {
  await initCacheTable();
  await pool.query(
    `INSERT INTO funtopia_sync_health (date, status, orders_expected, orders_received, products_expected, products_received, payments_expected, payments_received, error_message, warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      params.date,
      params.status,
      params.ordersExpected || 0,
      params.ordersReceived || 0,
      params.productsExpected || 0,
      params.productsReceived || 0,
      params.paymentsExpected || 0,
      params.paymentsReceived || 0,
      params.errorMessage || null,
      params.warnings ? JSON.stringify(params.warnings) : null,
    ]
  );
  try {
    await pool.query(`DELETE FROM funtopia_sync_health WHERE synced_at < NOW() - INTERVAL '90 days'`);
  } catch (_) {}
}

export async function getSyncHealth(dates: string[]): Promise<SyncHealthRecord[]> {
  await initCacheTable();
  if (dates.length === 0) return [];
  const result = await pool.query(
    `SELECT DISTINCT ON (date) id, date, synced_at, status, orders_expected, orders_received, products_expected, products_received, payments_expected, payments_received, error_message, warnings
     FROM funtopia_sync_health
     WHERE date = ANY($1)
     ORDER BY date, synced_at DESC`,
    [dates]
  );
  const rowsByDate = new Map<string, any>();
  for (const r of result.rows) {
    rowsByDate.set(r.date, r);
  }
  const divergences = await Promise.all(dates.map(d => computeRevenueDivergence(d).catch(() => null)));
  return dates.map((date, idx) => {
    const div = divergences[idx];
    const revenueDivergence = div && Math.abs(div.diff) > REVENUE_DIVERGENCE_THRESHOLD ? div : null;
    const r = rowsByDate.get(date);
    if (!r) {
      return {
        id: 0,
        date,
        syncedAt: "",
        status: "failed" as const,
        ordersExpected: 0,
        ordersReceived: 0,
        productsExpected: 0,
        productsReceived: 0,
        paymentsExpected: 0,
        paymentsReceived: 0,
        errorMessage: "Never synced",
        warnings: null,
        revenueDivergence,
      };
    }
    return {
      id: r.id,
      date: r.date,
      syncedAt: r.synced_at,
      status: r.status,
      ordersExpected: parseInt(r.orders_expected) || 0,
      ordersReceived: parseInt(r.orders_received) || 0,
      productsExpected: parseInt(r.products_expected) || 0,
      productsReceived: parseInt(r.products_received) || 0,
      paymentsExpected: parseInt(r.payments_expected) || 0,
      paymentsReceived: parseInt(r.payments_received) || 0,
      errorMessage: r.error_message,
      warnings: r.warnings,
      revenueDivergence,
    };
  });
}

export async function resyncDate(date: string): Promise<{ summary: DailySummary; syncHealth: SyncHealthRecord }> {
  const summary = await getDailySummaryFromApi(date);
  const healthRecords = await getSyncHealth([date]);
  return { summary, syncHealth: healthRecords[0] };
}

export async function getDailyProductDump(date: string) {
  const startAt = `${date} 00:00:00`;
  const endAt = `${date} 23:59:59`;

  const reportTypes = [
    "order_basic_information",
    "order_products_information",
    "order_payments_information",
  ];

  const [ordersResult, productsResult, paymentsResult] = await Promise.all(
    reportTypes.map(t => fetchAllPages(t, startAt, endAt))
  );

  const paidOrders = ordersResult.filter(
    (o: any) => o.payment_status?.toLowerCase() === "paid"
  );
  const paidOrderIds = new Set(paidOrders.map((o: any) => o.order_id));
  const paidProducts = productsResult.filter(
    (p: any) => paidOrderIds.has(p.order_id)
  );

  const ticketCatProducts = paidProducts.filter((p: any) => {
    const rawCat = (p.category_title || "").replace(/\u200b/g, "").trim();
    return classifyCategory(rawCat) === "Tickets & Packages";
  });

  const sampleOrderIds = [...new Set(ticketCatProducts.slice(0, 10).map((p: any) => p.order_id))];
  const orderDetails = sampleOrderIds.map(oid => {
    const order = ordersResult.find((o: any) => o.order_id === oid);
    const products = paidProducts.filter((p: any) => p.order_id === oid);
    const payments = paymentsResult.filter((p: any) => p.order_id === oid);
    return {
      order_id: oid,
      orderRaw: order ? { ...order } : null,
      products: products.map((p: any) => ({ ...p })),
      payments: payments.map((p: any) => ({ ...p })),
    };
  });

  return {
    date,
    totalPaidProducts: paidProducts.length,
    productFieldKeys: paidProducts.length > 0 ? Object.keys(paidProducts[0]) : [],
    orderFieldKeys: ordersResult.length > 0 ? Object.keys(ordersResult[0]) : [],
    paymentFieldKeys: paymentsResult.length > 0 ? Object.keys(paymentsResult[0]) : [],
    sampleOrdersWithAllData: orderDetails,
  };
}

function buildDateChunks(startDate: string, endDate: string, maxDays = 80): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let current = new Date(startDate + "T00:00:00");
  const finalDate = new Date(endDate + "T00:00:00");
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  while (current <= finalDate) {
    const chunkEnd = new Date(current);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > finalDate) chunkEnd.setTime(finalDate.getTime());
    chunks.push({ start: fmt(current), end: fmt(chunkEnd) });
    current = new Date(chunkEnd);
    current.setDate(current.getDate() + 1);
  }
  return chunks;
}

async function fetchRangeWithChunking(startDate: string, endDate: string) {
  const start = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");
  const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

  if (daysDiff <= 85) {
    const startAt = `${startDate} 00:00:00`;
    const endAt = `${endDate} 23:59:59`;
    const [ordersObj, productsObj, paymentsObj] = await Promise.all([
      fetchAllPages("order_basic_information", startAt, endAt),
      fetchAllPages("order_products_information", startAt, endAt),
      fetchAllPages("order_payments_information", startAt, endAt),
    ]);
    return { orders: ordersObj.items, products: productsObj.items, payments: paymentsObj.items };
  }

  const chunks = buildDateChunks(startDate, endDate);
  console.log(`[Funtopia] Splitting ${daysDiff}-day range into ${chunks.length} chunks`);

  let allOrders: any[] = [];
  let allProducts: any[] = [];
  let allPayments: any[] = [];

  for (const chunk of chunks) {
    const startAt = `${chunk.start} 00:00:00`;
    const endAt = `${chunk.end} 23:59:59`;
    const [ordersObj, productsObj, paymentsObj] = await Promise.all([
      fetchAllPages("order_basic_information", startAt, endAt),
      fetchAllPages("order_products_information", startAt, endAt),
      fetchAllPages("order_payments_information", startAt, endAt),
    ]);
    allOrders = allOrders.concat(ordersObj.items);
    allProducts = allProducts.concat(productsObj.items);
    allPayments = allPayments.concat(paymentsObj.items);
  }

  return { orders: allOrders, products: allProducts, payments: allPayments };
}

export function aggregateDailySummaries(summaries: DailySummary[]): {
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  paymentBreakdown: Record<string, number>;
  topProducts: Array<{ name: string; category: string; quantity: number; revenue: number }>;
  categoryBreakdown: Record<string, CategoryBreakdownEntry>;
  discountTotal: number;
  dailyRevenue: Array<{ date: string; revenue: number; orders: number; kids?: number; adults?: number; categories?: Record<string, number>; customerTypes?: Record<string, { kids: number; adults: number }> }>;
  guestBreakdown: TicketGuestBreakdown;
  customerTypeSplit: CustomerTypeEntry[];
  dailyHourly: Array<{ date: string; hourlyBreakdown: HourlyBucket[] }>;
  hourlyBreakdown: HourlyBucket[];
  voucherSwingAmount: number;
  pureTicketRevenue: number;
  sourceBreakdown: SourceBreakdownEntry[];
  birthdayLinks: BirthdayLinksSummary;
} {
  let totalRevenue = 0;
  let totalOrders = 0;
  let discountTotal = 0;
  let totalVoucherSwing = 0;
  let totalPureTicketRevenue = 0;
  const paymentBreakdown: Record<string, number> = {};
  const productMap = new Map<string, { name: string; category: string; quantity: number; revenue: number }>();
  const dailyRevenue: Array<{ date: string; revenue: number; orders: number }> = [];

  let totalAdultTickets = 0, totalKidTickets = 0, totalAdultRevenue = 0, totalKidRevenue = 0;
  let totalWeightedHours = 0, totalStayTickets = 0;
  const stayMap = new Map<string, { label: string; hours: number; count: number }>();
  const detailMap = new Map<string, { name: string; type: "adult" | "kid"; quantity: number; revenue: number }>();

  const customerTypeMap = new Map<string, CustomerTypeEntry>();

  for (const s of summaries) {
    totalRevenue += s.totalRevenue;
    totalOrders += s.totalOrders;
    discountTotal += s.discountTotal;
    totalVoucherSwing += s.voucherSwingAmount || 0;
    totalPureTicketRevenue += s.pureTicketRevenue || 0;

    for (const [method, amount] of Object.entries(s.paymentBreakdown)) {
      paymentBreakdown[method] = (paymentBreakdown[method] || 0) + amount;
    }

    for (const p of (s.topProducts || [])) {
      const existing = productMap.get(p.name);
      if (existing) {
        existing.quantity += p.quantity;
        existing.revenue += p.revenue;
      } else {
        productMap.set(p.name, { ...p });
      }
    }

    dailyRevenue.push({
      date: s.date,
      revenue: s.totalRevenue,
      orders: s.totalOrders,
      kids: s.guestBreakdown?.kidTickets || 0,
      adults: s.guestBreakdown?.adultTickets || 0,
      vouchers: s.paymentBreakdown?.["Voucher"] || 0,
      categories: Object.fromEntries(
        Object.entries(s.categoryBreakdown || {}).map(([k, v]: [string, any]) => [k, v.revenue || 0])
      ),
      customerTypes: (s.customerTypeSplit || []).reduce((acc: Record<string, { kids: number; adults: number }>, ct: any) => {
        acc[ct.type] = { kids: ct.kidTickets || 0, adults: ct.adultTickets || 0 };
        return acc;
      }, {} as Record<string, { kids: number; adults: number }>),
    });

    if (s.guestBreakdown) {
      totalAdultTickets += s.guestBreakdown.adultTickets;
      totalKidTickets += s.guestBreakdown.kidTickets;
      totalAdultRevenue += s.guestBreakdown.adultRevenue;
      totalKidRevenue += s.guestBreakdown.kidRevenue;

      for (const stay of (s.guestBreakdown.stayDistribution || [])) {
        const existing = stayMap.get(stay.label);
        if (existing) {
          existing.count += stay.count;
        } else {
          stayMap.set(stay.label, { ...stay });
        }
        totalWeightedHours += stay.hours * stay.count;
        totalStayTickets += stay.count;
      }

      for (const d of (s.guestBreakdown.details || [])) {
        const key = `${d.type}::${d.name}`;
        const existing = detailMap.get(key);
        if (existing) {
          existing.quantity += d.quantity;
          existing.revenue += d.revenue;
        } else {
          detailMap.set(key, { ...d });
        }
      }
    }

    if (s.customerTypeSplit) {
      for (const ct of s.customerTypeSplit) {
        const displayType = ct.type === "Special" ? "Eat & Play Package" : ct.type;
        const existing = customerTypeMap.get(displayType);
        if (existing) {
          existing.revenue += ct.revenue;
          existing.orders += ct.orders;
          existing.kidTickets += ct.kidTickets;
          existing.adultTickets += ct.adultTickets;
          existing.freeAdults += ct.freeAdults || 0;
          existing.totalGuests += ct.totalGuests;
        } else {
          customerTypeMap.set(displayType, { ...ct, type: displayType });
        }
      }
    }
  }

  const topProducts = Array.from(productMap.values())
    .filter(p => p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const ctPaidAdults = customerTypeMap.size > 0
    ? Array.from(customerTypeMap.values()).reduce((sum, ct) => sum + ct.adultTickets, 0)
    : totalAdultTickets;
  const ctFreeAdults = customerTypeMap.size > 0
    ? Array.from(customerTypeMap.values()).reduce((sum, ct) => sum + (ct.freeAdults || 0), 0)
    : 0;
  const rangeEstAdults = ctPaidAdults + ctFreeAdults;
  const rangeTotal = totalKidTickets + rangeEstAdults;
  const guestBreakdown: TicketGuestBreakdown = {
    adultTickets: ctPaidAdults,
    kidTickets: totalKidTickets,
    adultRevenue: totalAdultRevenue,
    kidRevenue: totalKidRevenue,
    estimatedTotalAdults: rangeEstAdults,
    totalInPark: rangeTotal,
    avgStayHours: totalStayTickets > 0 ? Math.round((totalWeightedHours / totalStayTickets) * 10) / 10 : null,
    stayDistribution: Array.from(stayMap.values()).sort((a, b) => a.hours - b.hours),
    details: Array.from(detailMap.values()).filter(d => d.revenue > 0).sort((a, b) => b.revenue - a.revenue),
    ongoingKids: 0,
    ongoingAdults: 0,
    ongoingTotal: 0,
    completedKids: totalKidTickets,
    completedAdults: rangeEstAdults,
    completedTotal: rangeTotal,
  };

  const customerTypeSplit = Array.from(customerTypeMap.values()).sort((a, b) => b.revenue - a.revenue);

  const categoryBreakdown: Record<string, any> = {};

  for (const s of summaries) {
    if (s.categoryBreakdown) {
      for (const [cat, entry] of Object.entries(s.categoryBreakdown as Record<string, any>)) {
        if (!categoryBreakdown[cat]) {
          categoryBreakdown[cat] = { revenue: 0, quantity: 0, items: [], subCategories: entry.subCategories ? {} : undefined };
        }
        categoryBreakdown[cat].revenue += entry.revenue || 0;
        categoryBreakdown[cat].quantity += entry.quantity || 0;

        // task-119: key by (name, isBday) so a product sold both as bday
        // and non-bday across days stays as two rows in the aggregate.
        // Top-10 is measured by unique name so both rows of a split product
        // stay visible together.
        const kOf = (it: any) => `${it.name}::${it.bdayRevenue && it.bdayRevenue > 0 ? "1" : "0"}`;
        const itemMap = new Map<string, { name: string; category: string; revenue: number; quantity: number; bdayRevenue?: number }>();
        for (const existing of categoryBreakdown[cat].items) {
          itemMap.set(kOf(existing), { ...existing });
        }
        for (const item of (entry.items || [])) {
          const k = kOf(item);
          const ex = itemMap.get(k);
          if (ex) {
            ex.revenue += item.revenue;
            ex.quantity += item.quantity;
            if (item.bdayRevenue) ex.bdayRevenue = (ex.bdayRevenue || 0) + item.bdayRevenue;
          } else {
            itemMap.set(k, { ...item });
          }
        }
        const allItems = Array.from(itemMap.values());
        if (cat === UNATTRIBUTED_BUCKET) {
          // task-136: keep every unattributed order across the range so the
          // drill-down lists each contributing order (no top-N trim).
          categoryBreakdown[cat].items = allItems.sort(
            (a: any, b: any) => b.revenue - a.revenue,
          );
        } else {
          const totalByName = new Map<string, number>();
          for (const it of allItems) totalByName.set(it.name, (totalByName.get(it.name) || 0) + it.revenue);
          const topNames = new Set(
            Array.from(totalByName.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n),
          );
          categoryBreakdown[cat].items = allItems
            .filter((it) => topNames.has(it.name))
            .sort((a: any, b: any) => b.revenue - a.revenue);
        }

        if (entry.subCategories && categoryBreakdown[cat].subCategories) {
          for (const [subCat, subEntry] of Object.entries(entry.subCategories as Record<string, any>)) {
            if (!categoryBreakdown[cat].subCategories[subCat]) {
              categoryBreakdown[cat].subCategories[subCat] = { revenue: 0, quantity: 0, items: [] };
            }
            categoryBreakdown[cat].subCategories[subCat].revenue += subEntry.revenue || 0;
            categoryBreakdown[cat].subCategories[subCat].quantity += subEntry.quantity || 0;

            const subItemMap = new Map<string, any>();
            for (const si of categoryBreakdown[cat].subCategories[subCat].items) {
              subItemMap.set(kOf(si), { ...si });
            }
            for (const si of (subEntry.items || [])) {
              const k = kOf(si);
              const ex = subItemMap.get(k);
              if (ex) {
                ex.revenue += si.revenue;
                ex.quantity += si.quantity;
                if (si.bdayRevenue) ex.bdayRevenue = (ex.bdayRevenue || 0) + si.bdayRevenue;
              } else {
                subItemMap.set(k, { ...si });
              }
            }
            const allSubItems = Array.from(subItemMap.values());
            const subTotalByName = new Map<string, number>();
            for (const si of allSubItems) subTotalByName.set(si.name, (subTotalByName.get(si.name) || 0) + (si.revenue || 0));
            const topSubNames = new Set(
              Array.from(subTotalByName.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n),
            );
            categoryBreakdown[cat].subCategories[subCat].items = allSubItems
              .filter((si: any) => topSubNames.has(si.name))
              .sort((a: any, b: any) => b.revenue - a.revenue);
          }
        }
      }
    }
  }

  const dailyHourly = summaries.map(s => ({
    date: s.date,
    hourlyBreakdown: s.hourlyBreakdown || [],
  })).sort((a, b) => a.date.localeCompare(b.date));

  const slotCount = summaries.some(s => (s.hourlyBreakdown || []).length > 24) ? SLOTS_PER_DAY : 24;
  const aggregatedHourly: HourlyBucket[] = [];
  for (let h = 0; h < slotCount; h++) {
    const bucket: HourlyBucket = {
      hour: h,
      label: slotCount > 24 ? slotLabel(h) : `${h.toString().padStart(2, "0")}:00`,
      orders: 0,
      revenue: 0,
      ticketsSold: 0,
      categories: {},
      customerTypes: {},
    };
    for (const s of summaries) {
      const hb = (s.hourlyBreakdown || []).find(b => b.hour === h);
      if (hb) {
        bucket.orders += hb.orders;
        bucket.revenue += hb.revenue;
        bucket.ticketsSold += hb.ticketsSold;
        if (hb.categories) {
          for (const [cat, rev] of Object.entries(hb.categories)) {
            bucket.categories![cat] = (bucket.categories![cat] || 0) + rev;
          }
        }
        if (hb.customerTypes) {
          for (const [type, ct] of Object.entries(hb.customerTypes)) {
            if (!bucket.customerTypes![type]) {
              bucket.customerTypes![type] = { kids: 0, adults: 0 };
            }
            bucket.customerTypes![type].kids += ct.kids;
            bucket.customerTypes![type].adults += ct.adults;
          }
        }
      }
    }
    aggregatedHourly.push(bucket);
  }

  // task-136: preserve the per-day unattributed items[] (orderCode + reason
  // entries from each daily summary) across the range merge so the
  // dashboard's drill-down lists every contributing order in the range,
  // not just a bare residual bucket.
  const mergedUnattributedItems: CategoryItem[] = Array.isArray(
    categoryBreakdown[UNATTRIBUTED_BUCKET]?.items,
  )
    ? (categoryBreakdown[UNATTRIBUTED_BUCKET].items as CategoryItem[]).filter(
        (it) => it && (it.orderCode || it.reason),
      )
    : [];
  reconcileCategoryBreakdown(categoryBreakdown, totalRevenue, mergedUnattributedItems);

  const reconciledTicketRev = categoryBreakdown["Tickets & Packages"]?.revenue || 0;
  const reconciledPureTicketRevenue = reconciledTicketRev - totalVoucherSwing;

  const sourceBreakdown = mergeSourceBreakdowns(
    summaries.map((s) => s.sourceBreakdown || []),
  );

  const birthdayLinks: BirthdayLinksSummary = {
    partyPackageRevenue: 0,
    partyFnbRevenue: 0,
    bdTickets: 0,
    combinedBirthdayTotal: 0,
    linkedOrderCount: 0,
    partyOrderCount: 0,
    unresolvedNoteCodes: [],
    links: [],
    unmatchedPartyOrders: [],
  };
  for (const s of summaries) {
    const bl = s.birthdayLinks;
    if (!bl) continue;
    birthdayLinks.partyPackageRevenue += bl.partyPackageRevenue || 0;
    birthdayLinks.partyFnbRevenue += bl.partyFnbRevenue || 0;
    birthdayLinks.bdTickets += bl.bdTickets || 0;
    birthdayLinks.linkedOrderCount += bl.linkedOrderCount || 0;
    birthdayLinks.partyOrderCount += bl.partyOrderCount || 0;
    if (bl.unresolvedNoteCodes && bl.unresolvedNoteCodes.length > 0) {
      birthdayLinks.unresolvedNoteCodes.push(...bl.unresolvedNoteCodes);
    }
    if (bl.links && bl.links.length > 0) {
      birthdayLinks.links!.push(...bl.links);
    }
    if (bl.unmatchedPartyOrders && bl.unmatchedPartyOrders.length > 0) {
      birthdayLinks.unmatchedPartyOrders!.push(...bl.unmatchedPartyOrders);
    }
  }
  const aggEventsRev = categoryBreakdown["Events / Birthdays"]?.revenue || 0;
  const totalBirthdayMoved = summaries.reduce(
    (sum, s) => sum + (s.birthdayMovedAmount || 0),
    0,
  );
  // Allocation="events" has already moved linked F&B into Events /
  // Birthdays. Subtract that moved amount before adding the linked-F&B total,
  // otherwise the range total counts the same F&B twice.
  birthdayLinks.combinedBirthdayTotal =
    aggEventsRev + birthdayLinks.partyFnbRevenue - totalBirthdayMoved;

  return {
    totalRevenue,
    totalOrders,
    avgOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
    paymentBreakdown,
    topProducts,
    categoryBreakdown,
    discountTotal,
    dailyRevenue: dailyRevenue.sort((a, b) => a.date.localeCompare(b.date)),
    guestBreakdown,
    customerTypeSplit,
    dailyHourly,
    hourlyBreakdown: aggregatedHourly,
    voucherSwingAmount: totalVoucherSwing,
    pureTicketRevenue: reconciledPureTicketRevenue,
    sourceBreakdown,
    birthdayLinks,
  };
}

// task-134: Events tab. Returns a flat list of party events (one row per
// party order) for [startDate, endDate], built from cached birthdayLinks
// and per-line items from funtopia_orders. Read-only — never triggers a
// sync. Caller is expected to handle empty arrays gracefully.
export interface EventRow {
  date: string;
  branch: "floresta" | "chalong";
  partyOrderId: string;
  partyOrderCode: string;
  packageName: string;
  packageRevenue: number;
  fnbRevenue: number;
  totalRevenue: number;
  entertainmentItems: Array<{ name: string; qty: number; revenue: number }>;
  // Carried so the frontend can hand the row to BirthdayOrderDialog
  // without a second roundtrip. `link` mirrors birthdayLinks.links[] shape
  // when an F&B order was paired with this party.
  link: BirthdayLinkProposal | null;
  partyPackages: string[];
}

export async function getFlorestaEventsRange(
  startDate: string,
  endDate: string,
): Promise<EventRow[]> {
  await initCacheTable();
  const dates: string[] = [];
  let d = new Date(startDate + "T12:00:00");
  const end = new Date(endDate + "T12:00:00");
  while (d <= end) {
    dates.push(d.toISOString().split("T")[0]);
    d.setDate(d.getDate() + 1);
  }
  if (dates.length === 0) return [];

  const cachedResult = await pool.query(
    "SELECT date, summary_json FROM funtopia_daily_cache WHERE date = ANY($1) AND date != '__meta__' ORDER BY date",
    [dates],
  );
  if (cachedResult.rows.length === 0) return [];

  // Payment rows are stored under the report date on which Pisell returned
  // them, while a party order can have been created/booked on another date.
  // Read every requested payment-report date and deduplicate stable Pisell
  // payment IDs before assigning cash to event order IDs. This retains
  // advance deposits in the requested range without using booking values as a
  // cash fallback.
  const eventPaymentsRes = await pool.query(
    `SELECT id, synced_at, order_id, pay_method, pay_amount, refund_amount, raw_json
       FROM funtopia_raw_payments
      WHERE order_date = ANY($1)`,
    [dates],
  );
  const eventCashByOrderId = buildDedupedNonVoucherRevenueByOrder(
    eventPaymentsRes.rows.map((r: any) => ({
      ...r,
      pay_amount: Number(r.pay_amount) || 0,
      refund_amount: Number(r.refund_amount) || 0,
    })),
  );

  // v28: self-heal stale cached days. This endpoint used to consume
  // birthdayLinks straight from the cache with no formulaVersion check, so
  // the Events tab could serve links computed by an old formula forever
  // (the dashboard read path self-heals, this one didn't). Rebuild any
  // mismatched day from raw and persist; fall back to the stale summary if
  // the rebuild fails (e.g. raw rows missing for a legacy day).
  for (const row of cachedResult.rows) {
    const ver = (row.summary_json as DailySummary)?.formulaVersion;
    if (ver === FORMULA_VERSION) continue;
    try {
      const fresh = await rebuildAndCacheSummaryWithApiLock(row.date);
      if (fresh && fresh.formulaVersion === FORMULA_VERSION) {
        row.summary_json = fresh;
      }
    } catch (e) {
      console.warn(`[Funtopia] events-range self-heal failed for ${row.date}; serving stale links`, e);
    }
  }

  // Load all per-line items for the date range in one query so we can
  // assemble entertainment chips per party order without N+1 lookups.
  const itemsRes = await pool.query(
    `SELECT order_date, order_id, product_name, product_category, quantity, subtotal
       FROM funtopia_orders
      WHERE order_date = ANY($1)`,
    [dates],
  );
  const itemsByOrder = new Map<string, Array<{ name: string; category: string; quantity: number; subtotal: number }>>();
  for (const r of itemsRes.rows) {
    const key = `${r.order_date}|${r.order_id}`;
    const list = itemsByOrder.get(key) || [];
    list.push({
      name: r.product_name || "",
      category: r.product_category || "",
      quantity: Number(r.quantity) || 0,
      subtotal: Number(r.subtotal) || 0,
    });
    itemsByOrder.set(key, list);
  }

  const out: EventRow[] = [];
  const seen = new Set<string>();
  const countedFnb = new Set<string>();
  // An advance booking may occur in several daily snapshots. Prefer its
  // latest report snapshot and count its range payments only once.
  for (const row of [...cachedResult.rows].reverse()) {
    const date: string = row.date;
    const s = row.summary_json as DailySummary;
    const links = s.birthdayLinks?.links || [];
    const unmatched = s.birthdayLinks?.unmatchedPartyOrders || [];

    const pushRow = (
      partyOrderId: string,
      partyOrderCode: string,
      partyPackages: string[],
      packageRevenue: number,
      fnbRevenue: number,
      link: BirthdayLinkProposal | null,
    ) => {
      if (seen.has(partyOrderId)) return;
      seen.add(partyOrderId);
      if (link) {
        if (countedFnb.has(link.fnbOrderId)) fnbRevenue = 0;
        countedFnb.add(link.fnbOrderId);
        link = { ...link, partyPackageRevenueCash: packageRevenue, fnbRevenueCash: fnbRevenue };
      }
      const items = itemsByOrder.get(`${date}|${partyOrderId}`) || [];
      const entertainment = items
        .filter((it) => !isBirthdayPackage(it.name))
        .map((it) => ({ name: it.name, qty: it.quantity, revenue: it.subtotal }));
      // Collapse duplicate item names
      const collapsed = new Map<string, { name: string; qty: number; revenue: number }>();
      for (const it of entertainment) {
        const ex = collapsed.get(it.name);
        if (ex) { ex.qty += it.qty; ex.revenue += it.revenue; }
        else collapsed.set(it.name, { ...it });
      }
      const packageName =
        partyPackages[0] ||
        items.find((it) => isBirthdayPackage(it.name))?.name ||
        "Birthday party";
      out.push({
        date,
        branch: "floresta",
        partyOrderId,
        partyOrderCode,
        packageName,
        packageRevenue,
        fnbRevenue,
        totalRevenue: packageRevenue + fnbRevenue,
        entertainmentItems: Array.from(collapsed.values()).sort((a, b) => b.revenue - a.revenue),
        link,
        partyPackages,
      });
    };

    for (const lk of links) {
      pushRow(
        lk.partyOrderId,
        lk.partyOrderCode,
        lk.partyPackages || [],
        eventCashByOrderId.get(String(lk.partyOrderId)) ?? 0,
        eventCashByOrderId.get(String(lk.fnbOrderId)) ?? 0,
        lk,
      );
    }
    for (const up of unmatched) {
      pushRow(
        up.partyOrderId,
        up.partyOrderCode,
        up.partyPackages || [],
        eventCashByOrderId.get(String(up.partyOrderId)) ?? 0,
        0,
        null,
      );
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.partyOrderCode.localeCompare(b.partyOrderCode) : a.date.localeCompare(b.date)));
}

export async function getDateRangeSummary(
  startDate: string,
  endDate: string
): Promise<{
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  paymentBreakdown: Record<string, number>;
  topProducts: Array<{ name: string; category: string; quantity: number; revenue: number }>;
  categoryBreakdown: Record<string, CategoryBreakdownEntry>;
  discountTotal: number;
  dailyRevenue: Array<{ date: string; revenue: number; orders: number }>;
  guestBreakdown: TicketGuestBreakdown;
  customerTypeSplit: CustomerTypeEntry[];
  dailyHourly: Array<{ date: string; hourlyBreakdown: HourlyBucket[] }>;
  hourlyBreakdown: HourlyBucket[];
  voucherSwingAmount: number;
  pureTicketRevenue: number;
  sourceBreakdown: SourceBreakdownEntry[];
  birthdayLinks: BirthdayLinksSummary;
  birthdayAllocation: BirthdayAllocation;
  birthdayMovedAmount: number;
}> {
  await initCacheTable();
  const dates: string[] = [];
  let d = new Date(startDate + "T12:00:00");
  const end = new Date(endDate + "T12:00:00");
  while (d <= end) {
    dates.push(d.toISOString().split("T")[0]);
    d.setDate(d.getDate() + 1);
  }

  const cachedResult = await pool.query(
    "SELECT date, summary_json FROM funtopia_daily_cache WHERE date = ANY($1) AND date != '__meta__' ORDER BY date",
    [dates]
  );
  const staleFormulaRows = cachedResult.rows.filter(
    (row: any) => (row.summary_json as DailySummary)?.formulaVersion !== FORMULA_VERSION,
  );
  if (staleFormulaRows.length > 0) {
    const apiSyncLock = await acquireFuntopiaApiSyncLock();
    try {
      for (const row of staleFormulaRows) {
        try {
          const fresh = await buildSummaryFromDatabase(row.date);
          if (fresh && fresh.formulaVersion === FORMULA_VERSION) {
            row.summary_json = fresh;
            await setCachedSummary(row.date, fresh);
          }
        } catch (e) {
          console.warn(`[Funtopia] v24 raw rebuild failed for ${row.date} (range), falling back`, e);
        }
      }
    } finally {
      await releaseFuntopiaApiSyncLock(apiSyncLock);
    }
  }
  const allocation = await getBirthdayAllocation("floresta");
  const allSummaries: DailySummary[] = await Promise.all(
    cachedResult.rows.map(async (r: any) => {
      let s = r.summary_json as DailySummary;
      const expectedSummary = structuredClone(s);
      let dirty = false;
      // task-135 v24: on formula mismatch do a full raw rebuild (mirrors
      // getDailySummary) so categoryBreakdown revenue AND items[] are both
      // recomputed under the new rules. backfillBirthdayLinks alone only
      // updates items[], leaving stale category revenue from the old version.
      let rebuilt = false;
      if (s.formulaVersion !== FORMULA_VERSION) {
        try {
          const fresh = await rebuildAndCacheSummaryWithApiLock(r.date);
          if (fresh && fresh.formulaVersion === FORMULA_VERSION) {
            s = fresh;
            rebuilt = true;
          }
        } catch (e) {
          console.warn(`[Funtopia] v24 raw rebuild failed for ${r.date} (range), falling back`, e);
        }
      }
      if (!rebuilt) {
        if (await fixCachedRevenue(s)) dirty = true;
        reclassifyCachedCategories(s);
        if (
          !s.sourceBreakdown ||
          s.sourceBreakdown.length === 0 ||
          s.formulaVersion !== FORMULA_VERSION
        ) {
          // task-111: recompute on formula bump so historical days pick up the
          // Birthdays source bucket and party-order exclusion logic.
          s.sourceBreakdown = await computeFuntopiaSourceBreakdownForDate(r.date, s.totalRevenue);
          dirty = true;
        }
        if (!s.birthdayLinks || s.formulaVersion !== FORMULA_VERSION) {
          await backfillBirthdayLinks(s);
          dirty = true;
        }
      }
      if (ensureBirthdayAllocationStampedSync(s, allocation)) {
        dirty = true;
      }
      if (!rebuilt && dirty) {
        setCachedSummaryIfUnchanged(r.date, s, expectedSummary).then((written) => {
          if (!written) {
            console.info(`[Funtopia] Skipped stale derived cache write for ${r.date} (range)`);
          }
        }).catch(() => {});
      }
      return s;
    })
  );

  if (allSummaries.length === 0) {
    return {
      totalRevenue: 0, totalOrders: 0, avgOrderValue: 0,
      paymentBreakdown: {}, topProducts: [],
      categoryBreakdown: {}, discountTotal: 0,
      dailyRevenue: [], guestBreakdown: { adultTickets: 0, kidTickets: 0, adultRevenue: 0, kidRevenue: 0, estimatedTotalAdults: 0, totalInPark: 0, avgStayHours: null, stayDistribution: [], details: [] },
      customerTypeSplit: [], dailyHourly: [], hourlyBreakdown: [],
      voucherSwingAmount: 0, pureTicketRevenue: 0,
      sourceBreakdown: [],
      birthdayLinks: {
        partyPackageRevenue: 0,
        partyFnbRevenue: 0,
        bdTickets: 0,
        combinedBirthdayTotal: 0,
        linkedOrderCount: 0,
        partyOrderCount: 0,
        unresolvedNoteCodes: [],
      },
      birthdayAllocation: allocation,
      birthdayMovedAmount: 0,
    };
  }

  const aggregated = aggregateDailySummaries(allSummaries);
  // Stamp the aggregate with the active allocation and the total amount
  // moved across the period (sum of per-day movements). The aggregated
  // categoryBreakdown is already in the "applied" state because each daily
  // summary was stamped before aggregation.
  const totalMoved = allSummaries.reduce(
    (acc, s) => acc + (s.birthdayMovedAmount || 0),
    0,
  );
  return { ...aggregated, birthdayAllocation: allocation, birthdayMovedAmount: totalMoved };
}

function isStandaloneAdultTicket(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  return lower.includes("additional adult") || lower === "adult ticket" ||
    lower === "thai adult ticket" || (lower.includes("adult") && lower.includes("ticket") && !lower.includes("kid"));
}

function classifyAdultOrKid(productTitle: string): "adult" | "kid" {
  if (isStandaloneAdultTicket(productTitle)) return "adult";
  return "kid";
}

function isEatAndPlayBundle(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  return (lower.includes("eat") && lower.includes("play") && (lower.includes("pass") || lower.includes("kid")))
    && !lower.includes("voucher");
}

function isIndianPackage(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  if (lower.includes("voucher")) return false;
  return lower.includes("indian package") || (lower.includes("indian") && lower.includes("1+1"));
}

function estimateStayHours(productTitle: string): number | null {
  const lower = productTitle.toLowerCase();
  if (lower.includes("full day") || lower.includes("full-day")) return 8;
  if (isEatAndPlayBundle(productTitle)) return 8;
  const hourMatch = lower.match(/(\d+)\s*hour/);
  if (hourMatch) return parseInt(hourMatch[1], 10);
  if (lower.includes("extra") && lower.includes("hour")) return 1;
  return null;
}

function isEntryTicket(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  if (lower.includes("package")) return true;
  if (isEatAndPlayBundle(productTitle)) return true;
  if (isStandaloneAdultTicket(productTitle)) return true;
  if (lower.includes("voucher") && (lower.includes("kid") || lower.includes("adult"))) return true;
  return false;
}

function isDropOffProduct(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  return lower.includes("drop off") || lower.includes("drop-off") || lower.includes("dropoff");
}

function isNannyProduct(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  return lower.includes("nanny");
}

function isSocksProduct(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  return lower === "socks" || lower.startsWith("socks ");
}

function detectTicketMarket(productName: string, categoryTitle?: string): "thai" | "tourist" | "expat" | "eat_play" | "unknown" {
  const nameLower = productName.toLowerCase();
  if (isEatAndPlayBundle(productName)) return "eat_play";
  if (nameLower.includes("thai")) return "thai";
  if (nameLower.includes("tourist")) return "tourist";
  if (nameLower.includes("expat")) return "expat";
  if (categoryTitle) {
    const catLower = categoryTitle.toLowerCase().replace(/\u200b/g, "").trim();
    if (catLower.includes("thai")) return "thai";
    if (catLower.includes("tourist")) return "tourist";
    if (catLower.includes("expat")) return "expat";
    if (catLower === "special" || catLower === "extra") return "eat_play";
  }
  return "unknown";
}

const ADULT_TICKET_PRICE = 327.10;
const KNOWN_KID_BASE_PRICES: Array<{ match: (name: string) => boolean; price: number }> = [
  { match: (n) => /1\s*hour.*thai/i.test(n), price: 393 },
  { match: (n) => /2\s*hour.*thai/i.test(n), price: 486 },
  { match: (n) => /1\s*hour.*tourist/i.test(n), price: 645 },
  { match: (n) => /2\s*hour.*tourist/i.test(n), price: 832 },
  { match: (n) => /1\s*hour.*expat/i.test(n), price: 778 },
];

function solveKidsAndAdults(originalPrice: number, productName: string): { kids: number; adults: number } | null {
  if (!originalPrice || originalPrice <= 0) return null;

  let kidBasePrice = 0;
  for (const entry of KNOWN_KID_BASE_PRICES) {
    if (entry.match(productName)) {
      kidBasePrice = entry.price;
      break;
    }
  }

  if (kidBasePrice === 0) {
    const lower = productName.toLowerCase();
    if (lower.includes("full day") || /2\s*hour.*expat/i.test(lower)) {
      for (let k = 1; k <= 8; k++) {
        const remaining = originalPrice - k * ADULT_TICKET_PRICE;
        if (remaining > 0 && remaining > ADULT_TICKET_PRICE) {
          const candidateKidPrice = remaining / k;
          if (candidateKidPrice > 200 && candidateKidPrice < 2000) {
            const testRemaining = originalPrice % candidateKidPrice;
            if (Math.abs(testRemaining) < 1 || Math.abs(testRemaining - candidateKidPrice) < 1) {
              return { kids: k, adults: 0 };
            }
          }
        }
        if (k === 1) {
          for (let a = 0; a <= 5; a++) {
            const candidateKidPrice = originalPrice - a * ADULT_TICKET_PRICE;
            if (candidateKidPrice > 200 && candidateKidPrice < 2000) {
              return { kids: 1, adults: a };
            }
          }
        }
      }
      return { kids: 1, adults: 0 };
    }
    return null;
  }

  let bestSolution: { kids: number; adults: number } | null = null;
  let bestError = Infinity;

  const maxKids = Math.floor(originalPrice / kidBasePrice) + 1;
  for (let k = 1; k <= Math.min(maxKids, 15); k++) {
    const remaining = originalPrice - k * kidBasePrice;
    if (remaining < -1) break;
    if (remaining < 0 && Math.abs(remaining) < 1) {
      if (bestError > Math.abs(remaining)) {
        bestSolution = { kids: k, adults: 0 };
        bestError = Math.abs(remaining);
      }
      continue;
    }
    const adults = remaining / ADULT_TICKET_PRICE;
    const roundedAdults = Math.round(adults);
    const error = Math.abs(adults - roundedAdults);
    if (roundedAdults >= 0 && error < 0.05 && error < bestError) {
      bestSolution = { kids: k, adults: roundedAdults };
      bestError = error;
    }
  }

  return bestSolution;
}

function buildGuestBreakdown(paidProducts: any[], paidOrders?: any[]): TicketGuestBreakdown {
  const ticketProducts = paidProducts.filter((p) => {
    const rawCat = (p.category_title || "").replace(/\u200b/g, "").trim();
    const revCat = classifyCategory(rawCat);
    const name = p.product_title || "";
    if (revCat === "Tickets & Packages") return isEntryTicket(name);
    if (revCat === "Extras" && (isEatAndPlayBundle(name) || isStandaloneAdultTicket(name))) return true;
    return false;
  });

  let adultTickets = 0;
  let kidTickets = 0;
  let adultRevenue = 0;
  let kidRevenue = 0;
  let totalWeightedHours = 0;
  let totalStayTickets = 0;
  let eatPlayBundleAdults = 0;
  let standaloneAdultTickets = 0;
  let solverBundledAdults = 0;
  let dropOffKids = 0;
  let nannyKids = 0;
  let socksQty = 0;
  const orderIds = new Set<string>();
  const regularKidOrderIds = new Set<string>();
  const thaiKidOrderIds = new Set<string>();
  const eatPlayOrderIds = new Set<string>();
  const stayMap = new Map<string, { label: string; hours: number; count: number }>();
  const detailMap = new Map<string, { name: string; type: "adult" | "kid"; quantity: number; revenue: number }>();

  for (const p of ticketProducts) {
    const name = p.product_title || "Unknown";
    const qty = p.product_quantity || 0;
    const rev = p.payment_price || 0;
    const origPrice = p.original_price || 0;
    const orderId = p.order_id ? String(p.order_id) : "";

    if (orderId) orderIds.add(orderId);

    if (isEatAndPlayBundle(name)) {
      kidTickets += qty;
      kidRevenue += rev;
      eatPlayBundleAdults += qty;
      if (orderId) eatPlayOrderIds.add(orderId);

      const key = `kid::${name}`;
      const existingDetail = detailMap.get(key);
      if (existingDetail) { existingDetail.quantity += qty; existingDetail.revenue += rev; }
      else { detailMap.set(key, { name, type: "kid", quantity: qty, revenue: rev }); }
    } else if (isIndianPackage(name)) {
      const indianKids = qty * 2;
      kidTickets += indianKids;
      kidRevenue += rev;
      if (orderId) regularKidOrderIds.add(orderId);

      const key = `kid::${name}`;
      const existingDetail = detailMap.get(key);
      if (existingDetail) { existingDetail.quantity += indianKids; existingDetail.revenue += rev; }
      else { detailMap.set(key, { name, type: "kid", quantity: indianKids, revenue: rev }); }
    } else if (isStandaloneAdultTicket(name)) {
      adultTickets += qty;
      adultRevenue += rev;
      standaloneAdultTickets += qty;

      const key = `adult::${name}`;
      const existingDetail = detailMap.get(key);
      if (existingDetail) { existingDetail.quantity += qty; existingDetail.revenue += rev; }
      else { detailMap.set(key, { name, type: "adult", quantity: qty, revenue: rev }); }
    } else {
      if (orderId) regularKidOrderIds.add(orderId);
      const market = detectTicketMarket(name, p.category_title);
      if (market === "thai") {
        if (orderId) thaiKidOrderIds.add(orderId);
      }
      const solved = solveKidsAndAdults(origPrice, name);
      if (solved && solved.kids > 0) {
        kidTickets += solved.kids;
        kidRevenue += rev * (solved.kids / (solved.kids + solved.adults || 1));
        if (solved.adults > 0) {
          adultTickets += solved.adults;
          adultRevenue += rev * (solved.adults / (solved.kids + solved.adults));
          solverBundledAdults += solved.adults;
        }
      } else {
        kidTickets += qty;
        kidRevenue += rev;
      }

      const key = `kid::${name}`;
      const existingDetail = detailMap.get(key);
      const totalPeople = solved ? solved.kids + solved.adults : qty;
      if (existingDetail) { existingDetail.quantity += (solved ? solved.kids : qty); existingDetail.revenue += rev; }
      else { detailMap.set(key, { name, type: "kid", quantity: (solved ? solved.kids : qty), revenue: rev }); }

      if (solved && solved.adults > 0) {
        const adultKey = `adult::Adult Ticket (bundled in ${name})`;
        const existingAdult = detailMap.get(adultKey);
        if (existingAdult) { existingAdult.quantity += solved.adults; }
        else { detailMap.set(adultKey, { name: `Adult Ticket (in ${name})`, type: "adult", quantity: solved.adults, revenue: 0 }); }
      }
    }

    const hours = estimateStayHours(name);
    if (hours !== null && !name.toLowerCase().includes("extra")) {
      const solved = isIndianPackage(name) ? null : solveKidsAndAdults(origPrice, name);
      const kidsForStay = isIndianPackage(name) ? qty * 2 : (solved ? solved.kids : qty);
      totalWeightedHours += hours * kidsForStay;
      totalStayTickets += kidsForStay;

      const label = hours >= 8 ? "Full Day" : `${hours} Hour${hours > 1 ? "s" : ""}`;
      const existing = stayMap.get(label);
      if (existing) { existing.count += kidsForStay; }
      else { stayMap.set(label, { label, hours, count: kidsForStay }); }
    }
  }

  for (const p of paidProducts) {
    const name = p.product_title || "";
    const qty = p.product_quantity || 0;
    const rev = p.payment_price || 0;

    if (isDropOffProduct(name)) {
      dropOffKids += qty;
      const key = `kid::${name}`;
      const existingDetail = detailMap.get(key);
      if (existingDetail) { existingDetail.quantity += qty; existingDetail.revenue += rev; }
      else { detailMap.set(key, { name, type: "kid", quantity: qty, revenue: rev }); }
    }

    if (isNannyProduct(name)) {
      nannyKids += qty;
    }

    if (isSocksProduct(name)) {
      socksQty += qty;
    }
  }

  kidTickets += dropOffKids;

  const ticketBasedKids = kidTickets;
  const socksMinKids = Math.ceil(socksQty * 0.9);
  if (socksMinKids > ticketBasedKids) {
    kidTickets = socksMinKids;
  }

  const thaiOnlyOrders = [...thaiKidOrderIds].filter(id => !eatPlayOrderIds.has(id)).length;
  const freeGuardians = thaiOnlyOrders;
  const estimatedTotalAdults = freeGuardians + solverBundledAdults + standaloneAdultTickets + eatPlayBundleAdults;
  const totalInPark = kidTickets + estimatedTotalAdults;

  const paidAdultTickets = adultTickets + eatPlayBundleAdults;

  const details = Array.from(detailMap.values())
    .filter((d) => d.quantity > 0)
    .sort((a, b) => b.revenue - a.revenue);

  const stayDistribution = Array.from(stayMap.values()).sort((a, b) => a.hours - b.hours);
  const avgStayHours = totalStayTickets > 0 ? Math.round((totalWeightedHours / totalStayTickets) * 10) / 10 : null;

  let ongoingKids = 0;
  let ongoingAdults = 0;
  const bangkokNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
  const nowMinutes = bangkokNow.getHours() * 60 + bangkokNow.getMinutes();

  const orderMinutesMap = new Map<string | number, number>();
  if (paidOrders) {
    for (const o of paidOrders) {
      if (o.created_at) {
        const match = String(o.created_at).match(/(\d{2}):(\d{2})/);
        if (match) {
          const orderMin = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
          orderMinutesMap.set(o.order_id, orderMin);
        }
      }
    }
  }

  const ongoingOrderIds = new Set<string>();
  for (const p of ticketProducts) {
    const name = p.product_title || "";
    const qty = p.product_quantity || 0;
    const orderId = p.order_id ? String(p.order_id) : "";
    const orderMin = orderMinutesMap.get(p.order_id);
    if (orderMin === undefined) continue;

    const hours = estimateStayHours(name);
    if (hours === null) continue;

    const gracePeriodMin = 45;
    const expectedEndMin = orderMin + hours * 60 + gracePeriodMin;
    const stillInside = nowMinutes < expectedEndMin;

    if (stillInside) {
      if (orderId) ongoingOrderIds.add(orderId);
      if (isEatAndPlayBundle(name)) {
        ongoingKids += qty;
      } else if (isIndianPackage(name)) {
        ongoingKids += qty * 2;
      } else if (isStandaloneAdultTicket(name)) {
      } else {
        const solved = solveKidsAndAdults(p.original_price || 0, name);
        if (solved && solved.kids > 0) {
          ongoingKids += solved.kids;
        } else {
          ongoingKids += qty;
        }
      }
    }
  }

  for (const p of paidProducts) {
    const name = p.product_title || "";
    const qty = p.product_quantity || 0;
    const orderId = p.order_id ? String(p.order_id) : "";
    if (isDropOffProduct(name)) {
      const orderMin = orderMinutesMap.get(p.order_id);
      if (orderMin !== undefined) {
        const dropOffEndMin = orderMin + 4 * 60 + 30;
        if (nowMinutes < dropOffEndMin) {
          ongoingKids += qty;
          if (orderId) ongoingOrderIds.add(orderId);
        }
      }
    }
  }

  for (const p of ticketProducts) {
    const name = p.product_title || "";
    const qty = p.product_quantity || 0;
    const orderId = p.order_id ? String(p.order_id) : "";
    if (!ongoingOrderIds.has(orderId)) continue;

    if (isEatAndPlayBundle(name)) {
      ongoingAdults += qty;
    } else if (isIndianPackage(name)) {
    } else if (isStandaloneAdultTicket(name)) {
      ongoingAdults += qty;
    } else {
      const market = detectTicketMarket(name, p.category_title);
      const solved = solveKidsAndAdults(p.original_price || 0, name);
      if (solved && solved.adults > 0) {
        ongoingAdults += solved.adults;
      }
      if (market === "thai") {
        const isThaiOnly = !eatPlayOrderIds.has(orderId);
        if (isThaiOnly) {
          ongoingAdults += 1;
        }
      }
    }
  }

  const parkCloseMinute = 20 * 60 + 45;
  if (nowMinutes >= parkCloseMinute) {
    ongoingKids = 0;
    ongoingAdults = 0;
  }

  const ongoingTotal = ongoingKids + ongoingAdults;
  const completedKids = kidTickets - ongoingKids;
  const completedAdults = estimatedTotalAdults - ongoingAdults;
  const completedTotal = completedKids + completedAdults;

  return { adultTickets: paidAdultTickets, kidTickets, adultRevenue, kidRevenue, estimatedTotalAdults, totalInPark, avgStayHours, stayDistribution, details, ongoingKids, ongoingAdults, ongoingTotal, completedKids, completedAdults, completedTotal };
}

export type RevenueCategory = "Tickets & Packages" | "F&B" | "Events / Birthdays" | "Nanny & Drop-off" | "Merchandise" | "Workshop" | "Extras";

const DRINK_CATEGORIES = ["coffee & tea", "juice/ smoothies", "juice/smoothies", "soda/ soft drinks", "soda/soft drinks", "beer & wine", "beer &amp; wine", "cocktails", "beverages", "drinks", "bar"];
const FOOD_CATEGORIES = ["breakfast", "kids menu", "sharing", "salads", "thai food", "desserts", "snacks", "main course", "appetizers", "mains", "pasta & pizza", "pasta &amp; pizza", "soups", "starters", "sides", "food", "kitchen", "café", "cafe"];
const TICKET_CATEGORIES = ["tourist", "thai", "expat", "indian", "ticket", "special"];
const EVENT_CATEGORIES = ["packages"];
const MERCHANDISE_CATEGORIES = ["merchandise"];
const WORKSHOP_CATEGORIES = ["workshop", "work shop"];

const MERCHANDISE_PRODUCTS = [
  "big bunny", "middle bunny", "small bunny",
  "blue emoji toy", "peppa pig", "wooden twist",
  "round sunglasses", "mini shoulder bag", "frozen kids backpack",
  "frozen bracelet", "princess jewelry", "kids beaded necklace",
  "glasses necklace", "potato head",
];

// ============================================================================
// task-139: Floresta product registry — Pisell `product_id` is the source of
// truth for SKU → Revenue Category. The first time we see a SKU we resolve
// it (Pisell category → keyword rescue → unclassified), persist the decision,
// and from then on every read uses the stored decision. A renamed SKU, a
// staff "Open Item" off-menu charge, or an off-whitelist Pisell category can
// no longer drift a SKU's bucket. Manual overrides take highest precedence
// and are honored by the resolver. Chalong/Papaya is out of scope.
// ============================================================================

export type ProductDecisionSource =
  | "pisell_category"
  | "keyword_rescue"
  | "manual_override"
  | "unclassified";

export interface ProductClassification {
  revenueCategory: RevenueCategory;
  fnbSubCategory: "Food" | "Drinks" | null;
  decisionSource: ProductDecisionSource;
}

export interface ProductRegistryRow extends ProductClassification {
  productKey: string;
  productId: string | null;
  variantId: string | null;
  latestName: string;
  latestCategoryTitle: string | null;
  manualOverride: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

const productRegistry = new Map<string, ProductRegistryRow>();
let productRegistryReady = false;
let pendingRegistryUpserts: ProductRegistryRow[] = [];
let registryFlushScheduled = false;

function productRegistryKey(
  productId: string | number | null | undefined,
  variantId: string | number | null | undefined,
): string {
  const pid = productId != null && productId !== "" ? String(productId) : "";
  const vid = variantId != null && variantId !== "" ? String(variantId) : "";
  return `${pid}::${vid}`;
}

async function ensureProductRegistryTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funtopia_product_registry (
      product_key TEXT PRIMARY KEY,
      product_id TEXT,
      variant_id TEXT,
      latest_name TEXT NOT NULL,
      latest_category_title TEXT,
      resolved_revenue_category TEXT NOT NULL,
      fnb_sub_category TEXT,
      decision_source TEXT NOT NULL,
      manual_override BOOLEAN NOT NULL DEFAULT FALSE,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_funtopia_product_registry_cat ON funtopia_product_registry(resolved_revenue_category)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_funtopia_product_registry_source ON funtopia_product_registry(decision_source)`,
  );
}

async function loadProductRegistry(): Promise<void> {
  await ensureProductRegistryTable();
  const res = await pool.query(`SELECT * FROM funtopia_product_registry`);
  productRegistry.clear();
  for (const r of res.rows) {
    productRegistry.set(r.product_key, {
      productKey: r.product_key,
      productId: r.product_id || null,
      variantId: r.variant_id || null,
      latestName: r.latest_name || "",
      latestCategoryTitle: r.latest_category_title || null,
      revenueCategory: (r.resolved_revenue_category || "Extras") as RevenueCategory,
      fnbSubCategory: (r.fnb_sub_category as "Food" | "Drinks" | null) || null,
      decisionSource: (r.decision_source || "unclassified") as ProductDecisionSource,
      manualOverride: r.manual_override === true,
      firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : new Date().toISOString(),
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : new Date().toISOString(),
    });
  }
  productRegistryReady = true;
}

function bootstrapClassifyProduct(name: string, rawCategory: string): ProductClassification {
  const cleanName = (name || "Unknown").toString();
  const cleanCat = (rawCategory || "").toString();
  const baseCat = classifyCategory(cleanCat);

  // Order of rescues mirrors the legacy if-chain in buildCategoryBreakdown so
  // existing days' classifications are preserved exactly when the registry is
  // first populated.
  if (isNannyOrDropoff(cleanName)) {
    return {
      revenueCategory: "Nanny & Drop-off",
      fnbSubCategory: null,
      decisionSource: baseCat !== "Extras" ? "pisell_category" : "keyword_rescue",
    };
  }
  if (isBirthdayPackage(cleanName)) {
    return {
      revenueCategory: "Events / Birthdays",
      fnbSubCategory: null,
      decisionSource: "keyword_rescue",
    };
  }

  if (baseCat !== "Extras") {
    if (baseCat === "F&B") {
      const lowerRaw = cleanCat.toLowerCase().replace(/\u200b/g, "").trim();
      const isFood = FOOD_CATEGORIES.some((f) => lowerRaw === f || lowerRaw.startsWith(f));
      return {
        revenueCategory: "F&B",
        fnbSubCategory: isFood ? "Food" : "Drinks",
        decisionSource: "pisell_category",
      };
    }
    return { revenueCategory: baseCat, fnbSubCategory: null, decisionSource: "pisell_category" };
  }

  // baseCat === "Extras": fall through to name-based rescues.
  if (isEatAndPlayBundle(cleanName) || isStandaloneAdultTicket(cleanName)) {
    return { revenueCategory: "Tickets & Packages", fnbSubCategory: null, decisionSource: "keyword_rescue" };
  }
  if (isMerchandiseProduct(cleanName)) {
    return { revenueCategory: "Merchandise", fnbSubCategory: null, decisionSource: "keyword_rescue" };
  }
  if (isWorkshopProduct(cleanName)) {
    return { revenueCategory: "Workshop", fnbSubCategory: null, decisionSource: "keyword_rescue" };
  }
  const fnbKind = isFoodOrDrinkProduct(cleanName);
  if (fnbKind) {
    return { revenueCategory: "F&B", fnbSubCategory: fnbKind, decisionSource: "keyword_rescue" };
  }

  // Truly unknown — display under Extras (today's behaviour) but mark as
  // unclassified so the Config tab can surface it for review.
  return { revenueCategory: "Extras", fnbSubCategory: null, decisionSource: "unclassified" };
}

function resolveProductClassification(p: {
  product_id?: any;
  variant_id?: any;
  product_title?: any;
  product_name?: any;
  category_title?: any;
  product_category?: any;
}): ProductClassification & { productKey: string } {
  const pid = p.product_id != null && p.product_id !== "" ? String(p.product_id) : "";
  const vid = p.variant_id != null && p.variant_id !== "" ? String(p.variant_id) : "";
  const name = ((p.product_title ?? p.product_name) || "Unknown").toString();
  const rawCat = ((p.category_title ?? p.product_category) || "").toString();
  const key = pid ? productRegistryKey(pid, vid) : `name::${name}::${rawCat}`;

  const existing = productRegistry.get(key);
  if (existing) {
    // Track the latest display name / Pisell category so the Config panel
    // surfaces what we last saw. Don't change the resolved category (that's
    // the whole point — the id-based decision is locked in).
    if (existing.latestName !== name || (existing.latestCategoryTitle || "") !== rawCat) {
      existing.latestName = name;
      existing.latestCategoryTitle = rawCat || null;
      existing.lastSeenAt = new Date().toISOString();
      enqueueRegistryUpsert(existing);
    }
    return {
      revenueCategory: existing.revenueCategory,
      fnbSubCategory: existing.fnbSubCategory,
      decisionSource: existing.decisionSource,
      productKey: key,
    };
  }

  const bootstrap = bootstrapClassifyProduct(name, rawCat);
  const nowIso = new Date().toISOString();
  const row: ProductRegistryRow = {
    productKey: key,
    productId: pid || null,
    variantId: vid || null,
    latestName: name,
    latestCategoryTitle: rawCat || null,
    revenueCategory: bootstrap.revenueCategory,
    fnbSubCategory: bootstrap.fnbSubCategory,
    decisionSource: bootstrap.decisionSource,
    manualOverride: false,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
  };
  productRegistry.set(key, row);
  enqueueRegistryUpsert(row);
  return { ...bootstrap, productKey: key };
}

function enqueueRegistryUpsert(row: ProductRegistryRow): void {
  pendingRegistryUpserts.push({ ...row });
  if (registryFlushScheduled) return;
  registryFlushScheduled = true;
  setTimeout(() => {
    flushRegistryUpserts().catch((e) =>
      console.warn("[Funtopia] product registry flush error:", (e as any)?.message),
    );
  }, 250);
}

async function flushRegistryUpserts(): Promise<void> {
  registryFlushScheduled = false;
  const batch = pendingRegistryUpserts;
  pendingRegistryUpserts = [];
  if (batch.length === 0) return;
  await ensureProductRegistryTable();
  const byKey = new Map<string, ProductRegistryRow>();
  for (const r of batch) byKey.set(r.productKey, r);
  const rows = Array.from(byKey.values());
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: any[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    const COLS = 9;
    for (const r of slice) {
      placeholders.push(
        `(${Array.from({ length: COLS }, (_, k) => `$${idx + k}`).join(", ")})`,
      );
      values.push(
        r.productKey,
        r.productId,
        r.variantId,
        r.latestName,
        r.latestCategoryTitle,
        r.revenueCategory,
        r.fnbSubCategory,
        r.decisionSource,
        r.manualOverride,
      );
      idx += COLS;
    }
    await pool.query(
      `INSERT INTO funtopia_product_registry
         (product_key, product_id, variant_id, latest_name, latest_category_title,
          resolved_revenue_category, fnb_sub_category, decision_source, manual_override)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (product_key) DO UPDATE SET
         latest_name = EXCLUDED.latest_name,
         latest_category_title = EXCLUDED.latest_category_title,
         last_seen_at = NOW(),
         resolved_revenue_category = CASE WHEN funtopia_product_registry.manual_override
           THEN funtopia_product_registry.resolved_revenue_category
           ELSE EXCLUDED.resolved_revenue_category END,
         fnb_sub_category = CASE WHEN funtopia_product_registry.manual_override
           THEN funtopia_product_registry.fnb_sub_category
           ELSE EXCLUDED.fnb_sub_category END,
         decision_source = CASE WHEN funtopia_product_registry.manual_override
           THEN funtopia_product_registry.decision_source
           ELSE EXCLUDED.decision_source END`,
      values,
    );
  }
}

/**
 * One-time backfill from existing funtopia_orders rows so the registry starts
 * with every SKU we've ever seen already classified. Idempotent: SKUs already
 * in the registry are left alone — their stored decision is the truth.
 */
export async function backfillProductRegistry(): Promise<{ inserted: number; total: number }> {
  await ensureProductRegistryTable();
  if (!productRegistryReady) await loadProductRegistry();
  const res = await pool.query(`
    SELECT
      COALESCE(product_id, '') AS product_id,
      COALESCE(variant_id, '') AS variant_id,
      (ARRAY_AGG(product_name ORDER BY synced_at DESC NULLS LAST))[1] AS latest_name,
      (ARRAY_AGG(product_category ORDER BY synced_at DESC NULLS LAST))[1] AS latest_category,
      MIN(synced_at) AS first_seen,
      MAX(synced_at) AS last_seen
    FROM funtopia_orders
    GROUP BY product_id, variant_id
  `);
  let inserted = 0;
  const insertRows: any[][] = [];
  for (const r of res.rows) {
    const pid = String(r.product_id || "");
    const vid = String(r.variant_id || "");
    const name = String(r.latest_name || "Unknown");
    const rawCat = String(r.latest_category || "");
    const key = pid ? productRegistryKey(pid, vid) : `name::${name}::${rawCat}`;
    if (productRegistry.has(key)) continue;
    const bootstrap = bootstrapClassifyProduct(name, rawCat);
    const firstSeenIso = r.first_seen ? new Date(r.first_seen).toISOString() : new Date().toISOString();
    const lastSeenIso = r.last_seen ? new Date(r.last_seen).toISOString() : new Date().toISOString();
    const row: ProductRegistryRow = {
      productKey: key,
      productId: pid || null,
      variantId: vid || null,
      latestName: name,
      latestCategoryTitle: rawCat || null,
      revenueCategory: bootstrap.revenueCategory,
      fnbSubCategory: bootstrap.fnbSubCategory,
      decisionSource: bootstrap.decisionSource,
      manualOverride: false,
      firstSeenAt: firstSeenIso,
      lastSeenAt: lastSeenIso,
    };
    productRegistry.set(key, row);
    insertRows.push([
      row.productKey, row.productId, row.variantId, row.latestName, row.latestCategoryTitle,
      row.revenueCategory, row.fnbSubCategory, row.decisionSource, row.manualOverride,
      row.firstSeenAt, row.lastSeenAt,
    ]);
  }
  const CHUNK = 200;
  for (let i = 0; i < insertRows.length; i += CHUNK) {
    const slice = insertRows.slice(i, i + CHUNK);
    const values: any[] = [];
    const placeholders: string[] = [];
    let idx = 1;
    const COLS = 11;
    for (const r of slice) {
      placeholders.push(
        `(${Array.from({ length: COLS }, (_, k) => `$${idx + k}`).join(", ")})`,
      );
      values.push(...r);
      idx += COLS;
    }
    await pool.query(
      `INSERT INTO funtopia_product_registry
         (product_key, product_id, variant_id, latest_name, latest_category_title,
          resolved_revenue_category, fnb_sub_category, decision_source, manual_override,
          first_seen_at, last_seen_at)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (product_key) DO NOTHING`,
      values,
    );
    inserted += slice.length;
  }
  return { inserted, total: productRegistry.size };
}

export async function initProductRegistryOnStartup(): Promise<void> {
  try {
    await loadProductRegistry();
    const result = await backfillProductRegistry();
    if (result.inserted > 0) {
      console.log(
        `[Funtopia] Product registry backfilled: inserted ${result.inserted} new SKUs, total ${result.total}`,
      );
    } else {
      console.log(`[Funtopia] Product registry ready: ${result.total} SKUs`);
    }
  } catch (e) {
    console.warn("[Funtopia] initProductRegistryOnStartup error:", (e as any)?.message);
  }
}

export async function listProductRegistry(): Promise<ProductRegistryRow[]> {
  if (!productRegistryReady) await loadProductRegistry();
  return Array.from(productRegistry.values()).sort((a, b) => {
    const aUnclassified = a.decisionSource === "unclassified" ? 0 : 1;
    const bUnclassified = b.decisionSource === "unclassified" ? 0 : 1;
    if (aUnclassified !== bUnclassified) return aUnclassified - bUnclassified;
    return (b.lastSeenAt || "").localeCompare(a.lastSeenAt || "");
  });
}

export async function setProductRegistryOverride(
  productKey: string,
  revenueCategory: RevenueCategory,
  fnbSubCategory: "Food" | "Drinks" | null,
): Promise<ProductRegistryRow | null> {
  if (!productRegistryReady) await loadProductRegistry();
  const existing = productRegistry.get(productKey);
  if (!existing) return null;
  const updated: ProductRegistryRow = {
    ...existing,
    revenueCategory,
    fnbSubCategory: revenueCategory === "F&B" ? (fnbSubCategory || "Food") : null,
    decisionSource: "manual_override",
    manualOverride: true,
  };
  productRegistry.set(productKey, updated);
  await ensureProductRegistryTable();
  await pool.query(
    `UPDATE funtopia_product_registry
     SET resolved_revenue_category = $2,
         fnb_sub_category = $3,
         decision_source = 'manual_override',
         manual_override = TRUE
     WHERE product_key = $1`,
    [productKey, updated.revenueCategory, updated.fnbSubCategory],
  );
  return updated;
}

export async function clearProductRegistryOverride(
  productKey: string,
): Promise<ProductRegistryRow | null> {
  if (!productRegistryReady) await loadProductRegistry();
  const existing = productRegistry.get(productKey);
  if (!existing) return null;
  const bootstrap = bootstrapClassifyProduct(
    existing.latestName,
    existing.latestCategoryTitle || "",
  );
  const updated: ProductRegistryRow = {
    ...existing,
    revenueCategory: bootstrap.revenueCategory,
    fnbSubCategory: bootstrap.fnbSubCategory,
    decisionSource: bootstrap.decisionSource,
    manualOverride: false,
  };
  productRegistry.set(productKey, updated);
  await ensureProductRegistryTable();
  await pool.query(
    `UPDATE funtopia_product_registry
     SET resolved_revenue_category = $2,
         fnb_sub_category = $3,
         decision_source = $4,
         manual_override = FALSE
     WHERE product_key = $1`,
    [productKey, updated.revenueCategory, updated.fnbSubCategory, updated.decisionSource],
  );
  return updated;
}

function classifyCategory(rawCategory: string): RevenueCategory {
  const lower = rawCategory.toLowerCase().replace(/\u200b/g, "").trim();

  if (lower.includes("spining wheel") || lower.includes("spinning wheel")) return "Extras";
  if (WORKSHOP_CATEGORIES.some((w) => lower === w || lower.startsWith(w))) return "Workshop";
  if (MERCHANDISE_CATEGORIES.some((m) => lower === m || lower.startsWith(m))) return "Merchandise";
  if (EVENT_CATEGORIES.some((e) => lower === e || lower.includes("party") || lower.includes("birthday") || lower.includes("event"))) return "Events / Birthdays";
  if (lower === "f&b" || lower === "f&amp;b" || lower === "fnb") return "F&B";
  if (FOOD_CATEGORIES.some((f) => lower === f || lower.startsWith(f))) return "F&B";
  if (DRINK_CATEGORIES.some((d) => lower === d || lower.startsWith(d))) return "F&B";
  if (TICKET_CATEGORIES.some((t) => lower === t || lower.startsWith(t))) return "Tickets & Packages";
  if (lower === "extra" || lower === "extras") return "Extras";

  return "Extras";
}

function isMerchandiseProduct(productName: string): boolean {
  const lower = productName.toLowerCase();
  return MERCHANDISE_PRODUCTS.some(m => lower.includes(m));
}

// v25: Name-based F&B rescue for SKUs whose Pisell category_title falls outside
// FOOD_CATEGORIES / DRINK_CATEGORIES (e.g. "Asian Food", "Open Item",
// "CHOCOLATE", "Kids juice", "seasonal", "Soup"). Mirrors the existing
// isMerchandiseProduct / isWorkshopProduct rescue pattern. Two keyword lists
// route the rescued item into the correct F&B sub-category (Food vs Drinks).
// "Open Item" is intentionally treated as F&B because in practice staff use it
// for custom F&B charges (cake corkage, off-menu drinks/food).
const FOOD_PRODUCT_KEYWORDS = [
  "fried rice", "pad thai", "pad krapao", "spicy beef wrap", "beef wrap",
  "open item", "gyoza", "chinese dumpling", "sichuan dumpling",
  "sichuan dan dan noodle", "dan dan noodle", "noodle soup", "clear noodle",
  "special soup", "soup of the month", "falafel wrap", "grilled chicken wrap",
  // task-137 v26: staff-typed custom F&B items (no Pisell category) that
  // were falling into Extras. "falafel" alone catches "Falafel for miia"
  // style notes used when ringing up off-menu plates for specific guests.
  "falafel",
];
const DRINK_PRODUCT_KEYWORDS = [
  "kids apple juice", "kids orange juice", "kids pineapple juice",
  "kids cranberry juice", "hot chocolate", "ice chocolate", "iced chocolate",
  // task-137 v26: staff-typed custom drinks (no Pisell category) that were
  // falling into Extras. Coffee menu words are safe — they're never used
  // for anything other than drinks at Floresta.
  "macchiato", "cappuccino", "latte", "espresso", "americano", "mocha",
];

function isFoodOrDrinkProduct(productName: string): "Food" | "Drinks" | null {
  const lower = productName.toLowerCase();
  if (DRINK_PRODUCT_KEYWORDS.some(k => lower.includes(k))) return "Drinks";
  if (FOOD_PRODUCT_KEYWORDS.some(k => lower.includes(k))) return "Food";
  return null;
}

// Pisell's "Workshop" category contains the OTO CS craft/jewelry items.
// They reliably carry the "OTO CS" prefix in the product title.
function isWorkshopProduct(productName: string): boolean {
  const lower = productName.toLowerCase();
  return lower.startsWith("oto cs ") || lower.includes(" oto cs ");
}

function isNannyOrDropoff(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  return lower.includes("nanny") || lower.includes("drop-off") || lower.includes("drop off") || lower.includes("dropoff");
}

function isBirthdayPackage(productTitle: string): boolean {
  const lower = productTitle.toLowerCase();
  if ((lower.includes("birthday") || lower.includes("party")) && lower.includes("package")) return true;
  // Floresta party-room bookings made via Merchant Portal don't always carry a
  // "Package" suffix. They appear as "Table Reservation 3000" / "Party Extra
  // Adult" / "Party Room" etc. — recognise these as party orders too so the
  // F&B linker can attach same-day food orders.
  if (lower.startsWith("table reservation")) return true;
  if (lower.includes("party extra")) return true;
  if (lower.includes("party room")) return true;
  return false;
}

interface SubCategoryData {
  revenue: number;
  quantity: number;
  items: CategoryItem[];
}

interface CategoryResult {
  revenue: number;
  quantity: number;
  items: CategoryItem[];
  subCategories?: Record<string, SubCategoryData>;
}

function classifyTicketSubCategory(rawCategory: string): string {
  const lower = rawCategory.toLowerCase().replace(/\u200b/g, "").trim();
  if (lower.includes("indian")) return "Indian";
  if (lower.startsWith("tourist") || lower.includes("tourist")) return "Tourist";
  if (lower.startsWith("expat") || lower.includes("expat")) return "Expat";
  if (lower.startsWith("thai") || lower.includes("thai")) return "Thai";
  if (lower === "ticket") return "Extra Tickets";
  if (lower === "special" || lower === "extra") return "Eat & Play Package";
  return "Other";
}

// task-111: retag categoryBreakdown items in-place with bdayRevenue based on
// an expanded set of birthday-origin order IDs (party orders ∪ bday-token
// F&B ∪ Tier A/B/C accepted links ∪ manual overrides). Item revenue is not
// changed — only the bdayRevenue annotation is added or refreshed. Used by
// both the fresh-summary path and backfillBirthdayLinks so historical
// drill-downs show the badge after the v12 formula bump.
// task-119: rebuild per-category and per-subcategory items lists using the
// expanded bdAllIds set so each product appears as up to two rows — one for
// its birthday-linked portion (bdayRevenue == revenue) and one for its
// non-birthday portion. Replaces the old in-place annotation approach which
// could only attach a partial bdayRevenue to a single merged row. Category
// and subcategory totals (revenue/quantity) are preserved because they were
// already reconciled by the caller; only items[] is replaced.
function retagItemsBdayRevenue(
  categoryBreakdown: Record<string, { items?: CategoryItem[]; subCategories?: Record<string, { items: CategoryItem[] }> }> | undefined,
  paidProducts: any[],
  bdAllIds: Set<string>,
  partyOrderIds?: Set<string>,
): void {
  if (!categoryBreakdown) return;
  // task-135 v24: forward partyOrderIds so the rebuilt items[] reflects the
  // same Events / Birthdays promotion that buildSummaryFromRawData applied.
  // Without this, override-promoted party orders (no SKU isBirthdayPackage
  // match, e.g. A48963) had their items overwritten away from Events here,
  // leaving Events.revenue accumulated but items[] empty.
  const rebuilt = buildCategoryBreakdown(paidProducts, bdAllIds, partyOrderIds);
  for (const [catName, rebuiltCat] of Object.entries(rebuilt)) {
    const existing = (categoryBreakdown as any)[catName];
    if (!existing) {
      (categoryBreakdown as any)[catName] = rebuiltCat;
      continue;
    }
    existing.items = rebuiltCat.items;
    if (rebuiltCat.subCategories) {
      if (!existing.subCategories) existing.subCategories = {};
      for (const [subName, rebuiltSub] of Object.entries(rebuiltCat.subCategories)) {
        if (!existing.subCategories[subName]) {
          existing.subCategories[subName] = rebuiltSub;
        } else {
          existing.subCategories[subName].items = (rebuiltSub as any).items;
        }
      }
    }
  }
}

function buildCategoryBreakdown(
  paidProducts: any[],
  bdOrderIds?: Set<string>,
  partyOrderIds?: Set<string>,
): Record<RevenueCategory, CategoryResult> {
  const result: Record<string, CategoryResult> = {
    "Tickets & Packages": { revenue: 0, quantity: 0, items: [], subCategories: {} },
    "F&B": { revenue: 0, quantity: 0, items: [], subCategories: { "Food": { revenue: 0, quantity: 0, items: [] }, "Drinks": { revenue: 0, quantity: 0, items: [] } } },
    "Events / Birthdays": { revenue: 0, quantity: 0, items: [] },
    "Nanny & Drop-off": { revenue: 0, quantity: 0, items: [] },
    "Merchandise": { revenue: 0, quantity: 0, items: [] },
    "Workshop": { revenue: 0, quantity: 0, items: [] },
    "Extras": { revenue: 0, quantity: 0, items: [] },
  };

  const productMap = new Map<string, { name: string; category: string; revenueCategory: string; subCategory?: string; revenue: number; quantity: number; bdayRevenue: number }>();

  for (const p of paidProducts) {
    const rawCat = (p.category_title || "Uncategorized").replace(/\u200b/g, "").trim();
    const productName = p.product_title || "Unknown";
    const qty = p.product_quantity || 0;
    const rev = p.payment_price || 0;

    // task-139 (v26): the SKU-level classification (Tickets / F&B / Events /
    // Nanny / Merchandise / Workshop / Extras) and the F&B sub-category come
    // from the product registry, which is keyed by Pisell's stable
    // `product_id` (+ variant_id). The first time we see a SKU the resolver
    // runs the bootstrap chain (Pisell category → keyword rescue →
    // unclassified) and persists the decision; from then on every read just
    // uses the stored decision. Renaming a SKU or staff using an
    // off-whitelist Pisell category can no longer drift the classification.
    const resolution = resolveProductClassification(p);
    let revCat: string = resolution.revenueCategory;
    let fnbSubOverride: "Food" | "Drinks" | null = resolution.fnbSubCategory;

    // v23: items on party-promoted orders (line-item party packages, party-note
    // orders, or staff override-promoted orders like A48963 on 2026-05-24 that
    // Pisell sold under generic SKUs "Full Day Expat Kid Package" / "Open Item")
    // are reclassified into Events / Birthdays. This stays an order-level
    // override on top of the SKU-level decision so the Events / Birthdays bar
    // matches the per-event card total.
    if (partyOrderIds && partyOrderIds.has(String(p.order_id))) {
      revCat = "Events / Birthdays";
      fnbSubOverride = null;
    }

    if (!result[revCat]) {
      result[revCat] = { revenue: 0, quantity: 0, items: [] };
    }
    result[revCat].revenue += rev;
    result[revCat].quantity += qty;

    let subCategory: string | undefined;
    if (revCat === "Tickets & Packages") {
      subCategory = classifyTicketSubCategory(rawCat);
      const subs = result["Tickets & Packages"].subCategories!;
      if (!subs[subCategory]) {
        subs[subCategory] = { revenue: 0, quantity: 0, items: [] };
      }
      subs[subCategory].revenue += rev;
      subs[subCategory].quantity += qty;
    }

    if (revCat === "F&B") {
      if (fnbSubOverride) {
        subCategory = fnbSubOverride;
      } else {
        const lowerRaw = rawCat.toLowerCase().replace(/\u200b/g, "").trim();
        const isFoodItem = FOOD_CATEGORIES.some((f) => lowerRaw === f || lowerRaw.startsWith(f));
        subCategory = isFoodItem ? "Food" : "Drinks";
      }
      const subs = result["F&B"].subCategories!;
      subs[subCategory].revenue += rev;
      subs[subCategory].quantity += qty;
    }

    const orderId = String(p.order_id);
    const isBdayLine = !!(bdOrderIds && bdOrderIds.has(orderId));

    // task-119: split bday-tagged vs non-bday lines for the same product into
    // separate rows by including isBdayLine in the aggregation key. A product
    // sold both as a birthday party item and as a normal sale within the same
    // period now produces two rows — one with bdayRevenue == revenue (the
    // "bday" badge) and one with bdayRevenue unset (regular sales).
    const key = `${revCat}::${subCategory || ""}::${productName}::${isBdayLine ? "1" : "0"}`;
    const existing = productMap.get(key);
    if (existing) {
      existing.revenue += rev;
      existing.quantity += qty;
      if (isBdayLine) existing.bdayRevenue += rev;
    } else {
      productMap.set(key, { name: productName, category: rawCat, revenueCategory: revCat, subCategory, revenue: rev, quantity: qty, bdayRevenue: isBdayLine ? rev : 0 });
    }
  }

  for (const item of productMap.values()) {
    if (item.revenue > 0) {
      const itemData: CategoryItem = { name: item.name, category: item.category, revenue: item.revenue, quantity: item.quantity };
      if (item.bdayRevenue > 0) itemData.bdayRevenue = item.bdayRevenue;

      if (item.revenueCategory === "Tickets & Packages" && item.subCategory) {
        const sub = result["Tickets & Packages"].subCategories![item.subCategory];
        if (sub) sub.items.push(itemData);
      } else if (item.revenueCategory === "F&B" && item.subCategory) {
        const sub = result["F&B"].subCategories![item.subCategory];
        if (sub) sub.items.push(itemData);
      } else {
        if (result[item.revenueCategory]) {
          result[item.revenueCategory].items.push(itemData);
        }
      }
    }
  }

  // task-119: keep "top 10" measured by unique product name (not row), so a
  // product with both a bday row and a non-bday row keeps both rows visible
  // instead of pushing the non-bday half out of the daily summary's top 10.
  const topByName = <T extends { name: string; revenue: number }>(items: T[], n: number): T[] => {
    const totalByName = new Map<string, number>();
    for (const it of items) totalByName.set(it.name, (totalByName.get(it.name) || 0) + it.revenue);
    const topNames = new Set(
      Array.from(totalByName.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name]) => name),
    );
    return items
      .filter((it) => topNames.has(it.name))
      .sort((a, b) => b.revenue - a.revenue);
  };

  for (const cat of Object.keys(result)) {
    result[cat].items = topByName(result[cat].items, 10);
    if (result[cat].subCategories) {
      for (const subName of Object.keys(result[cat].subCategories!)) {
        result[cat].subCategories![subName].items = topByName(
          result[cat].subCategories![subName].items,
          10,
        );
      }
    }
  }

  return result as any;
}

export interface CustomerTypeEntry {
  type: string;
  revenue: number;
  orders: number;
  kidTickets: number;
  adultTickets: number;
  freeAdults: number;
  totalGuests: number;
}

function buildCustomerTypeSplit(paidProducts: any[]): CustomerTypeEntry[] {
  const typeMap = new Map<string, CustomerTypeEntry>();

  const orderTypeMap = new Map<number, string>();
  const ordersWithKidTickets = new Set<number>();
  const orderHasPaidAdult = new Set<number>();

  for (const p of paidProducts) {
    const rawCat = (p.category_title || "").replace(/\u200b/g, "").trim();
    const revCat = classifyCategory(rawCat);
    const name = p.product_title || "";
    const isTicketCat = revCat === "Tickets & Packages";
    const isExtraEatPlay = revCat === "Extras" && (isEatAndPlayBundle(name) || isStandaloneAdultTicket(name));
    if (!isTicketCat && !isExtraEatPlay) continue;
    if (String(p.product_id || "") === "431415") continue;

    const subCat = isExtraEatPlay ? "Eat & Play Package" : classifyTicketSubCategory(rawCat);
    if (subCat === "Extra Tickets" || subCat === "Other") continue;

    if (isStandaloneAdultTicket(name)) {
      orderHasPaidAdult.add(p.order_id);
    } else if (!orderTypeMap.has(p.order_id)) {
      orderTypeMap.set(p.order_id, subCat);
    }
    if (isEntryTicket(name) && !isStandaloneAdultTicket(name)) {
      ordersWithKidTickets.add(p.order_id);
    }
  }

  for (const p of paidProducts) {
    const rawCat = (p.category_title || "").replace(/\u200b/g, "").trim();
    const revCat = classifyCategory(rawCat);
    const name2 = p.product_title || "";
    const isTicketCat2 = revCat === "Tickets & Packages";
    const isExtraEatPlay2 = revCat === "Extras" && (isEatAndPlayBundle(name2) || isStandaloneAdultTicket(name2));
    if (!isTicketCat2 && !isExtraEatPlay2) continue;
    if (String(p.product_id || "") === "431415") continue;

    const subCat = isExtraEatPlay2 ? "Eat & Play Package" : classifyTicketSubCategory(rawCat);
    if (subCat === "Extra Tickets" || subCat === "Other") continue;

    const name = p.product_title || "";
    const qty = p.product_quantity || 0;
    const rev = p.payment_price || 0;

    let targetType = subCat;
    if (isStandaloneAdultTicket(name)) {
      const orderType = orderTypeMap.get(p.order_id);
      if (orderType) targetType = orderType;
    }

    if (!typeMap.has(targetType)) {
      typeMap.set(targetType, { type: targetType, revenue: 0, orders: 0, kidTickets: 0, adultTickets: 0, freeAdults: 0, totalGuests: 0 });
    }
    const entry = typeMap.get(targetType)!;
    entry.revenue += rev;

    if (isEntryTicket(name)) {
      if (isEatAndPlayBundle(name)) {
        entry.kidTickets += qty;
        entry.adultTickets += qty;
        entry.totalGuests += qty * 2;
      } else if (isIndianPackage(name)) {
        entry.kidTickets += qty * 2;
        entry.totalGuests += qty * 2;
      } else if (isStandaloneAdultTicket(name)) {
        entry.adultTickets += qty;
        entry.totalGuests += qty;
      } else {
        const origPrice = p.original_price || 0;
        const solved = solveKidsAndAdults(origPrice, name);
        if (solved && solved.kids > 0) {
          entry.kidTickets += solved.kids;
          entry.adultTickets += solved.adults;
          entry.totalGuests += solved.kids + solved.adults;
        } else {
          entry.kidTickets += qty;
          entry.totalGuests += qty;
        }
      }
    }
  }

  const ordersByType: Record<string, Set<number>> = {};
  for (const [orderId, type] of orderTypeMap.entries()) {
    if (!ordersByType[type]) ordersByType[type] = new Set();
    ordersByType[type].add(orderId);
  }
  for (const [type, orderSet] of Object.entries(ordersByType)) {
    const entry = typeMap.get(type);
    if (entry) {
      entry.orders = orderSet.size;
      if (type === "Thai") {
        let freeGuardians = 0;
        for (const oid of orderSet) {
          if (!ordersWithKidTickets.has(oid)) continue;
          if (orderHasPaidAdult.has(oid)) {
            freeGuardians++;
          } else {
            freeGuardians++;
          }
        }
        entry.freeAdults += freeGuardians;
        entry.totalGuests += freeGuardians;
      }
    }
  }

  return Array.from(typeMap.values()).sort((a, b) => b.revenue - a.revenue);
}

function extractSlot(dateStr: string): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    return h * 3 + Math.floor(m / 20);
  }
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.getHours() * 3 + Math.floor(d.getMinutes() / 20);
  } catch {}
  return null;
}

const SLOTS_PER_DAY = 72;

function slotLabel(slot: number): string {
  const h = Math.floor(slot / 3);
  const m = (slot % 3) * 20;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function buildHourlyBreakdown(paidOrders: any[], paidProducts: any[]): HourlyBucket[] {
  const orderIdToSlot = new Map<number, number>();
  const buckets: Record<number, { orders: number; revenue: number; ticketsSold: number; categories: Record<string, number>; customerTypes: Record<string, { kids: number; adults: number }> }> = {};
  for (let s = 0; s < SLOTS_PER_DAY; s++) {
    buckets[s] = { orders: 0, revenue: 0, ticketsSold: 0, categories: {}, customerTypes: {} };
  }

  for (const o of paidOrders) {
    const slot = extractSlot(o.created_at);
    if (slot === null) continue;
    orderIdToSlot.set(o.order_id, slot);
    buckets[slot].orders += 1;
  }

  for (const p of paidProducts) {
    const slot = orderIdToSlot.get(p.order_id);
    if (slot === undefined) continue;
    buckets[slot].revenue += p.payment_price || 0;
    const rawCat = (p.category_title || "").replace(/\u200b/g, "").trim();
    const productName = p.product_title || "";
    let revCat = classifyCategory(rawCat);
    if (revCat === "Tickets & Packages" && isEntryTicket(productName)) {
      buckets[slot].ticketsSold += p.product_quantity || 0;
    }
    if (revCat === "Extras" && isMerchandiseProduct(productName)) {
      revCat = "Merchandise";
    }
    if (revCat === "Extras" && isWorkshopProduct(productName)) {
      revCat = "Workshop";
    }
    if (isNannyOrDropoff(productName)) {
      revCat = "Nanny & Drop-off";
    }
    if ((revCat === "Tickets & Packages" || revCat === "Extras") && isBirthdayPackage(productName)) {
      revCat = "Events / Birthdays";
    }
    const prodRevenue = p.payment_price || 0;
    buckets[slot].categories[revCat] = (buckets[slot].categories[revCat] || 0) + prodRevenue;

    if (revCat === "Tickets & Packages" && isEntryTicket(productName)) {
      const subCat = classifyTicketSubCategory(rawCat);
      if (subCat !== "Extra Tickets" && subCat !== "Other") {
        if (!buckets[slot].customerTypes[subCat]) {
          buckets[slot].customerTypes[subCat] = { kids: 0, adults: 0 };
        }
        const ct = buckets[slot].customerTypes[subCat];
        const qty = p.product_quantity || 0;
        if (isEatAndPlayBundle(productName)) {
          ct.kids += qty;
          ct.adults += qty;
        } else if (isIndianPackage(productName)) {
          ct.kids += qty * 2;
        } else if (isStandaloneAdultTicket(productName)) {
          ct.adults += qty;
        } else {
          const origPrice = p.original_price || 0;
          const solved = solveKidsAndAdults(origPrice, productName);
          if (solved && solved.kids > 0) {
            ct.kids += solved.kids;
            ct.adults += solved.adults;
          } else {
            ct.kids += qty;
          }
        }
      }
    }
  }

  return Object.entries(buckets).map(([s, data]) => ({
    hour: parseInt(s, 10),
    label: slotLabel(parseInt(s, 10)),
    ...data,
  }));
}

function extractDate(dateStr: string): string {
  if (!dateStr) return "Unknown";
  const match = dateStr.match(/(\d{2})\/(\w{3})\/(\d{4})/);
  if (match) {
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    return `${match[3]}-${months[match[2]] || "01"}-${match[1]}`;
  }
  return dateStr.split(" ")[0] || "Unknown";
}

function normalizePaymentMethod(method: string): string {
  const lower = method.toLowerCase();
  if (lower.includes("cash")) return "Cash";
  if (lower.includes("credit") || lower.includes("debit") || lower.includes("edc")) return "Card";
  if (lower.includes("promptpay") || lower.includes("qr")) return "PromptPay/QR";
  if (lower.includes("stripe")) return "Stripe";
  if (lower.includes("gift")) return "Gift Card";
  if (lower.includes("voucher")) return "Voucher";
  return method;
}

export function buildNonVoucherRevenueByOrder(
  payments: Array<{
    order_id: string | number;
    pay_method?: string | null;
    pay_amount?: number | null;
    refund_amount?: number | null;
  }>,
): Map<string, number> {
  const revenueByOrder = new Map<string, number>();
  for (const payment of payments) {
    if (normalizePaymentMethod(payment.pay_method || "") === "Voucher") continue;
    const net = (Number(payment.pay_amount) || 0) - (Number(payment.refund_amount) || 0);
    if (net === 0) continue;
    const orderId = String(payment.order_id);
    revenueByOrder.set(orderId, (revenueByOrder.get(orderId) || 0) + net);
  }
  return revenueByOrder;
}

/**
 * Build cash revenue from a set of payment-report rows while removing stable
 * Pisell payment duplicates. A payment can occur in more than one requested
 * report-date snapshot; latestPaymentRows keeps the newest copy (including any
 * later refund/status fields), then the cash helper excludes every Voucher
 * row before netting refunds.
 */
export function buildDedupedNonVoucherRevenueByOrder(
  payments: Array<{
    order_id: string | number;
    id?: string | number | null;
    synced_at?: string | Date | null;
    raw_json?: unknown;
    pay_method?: string | null;
    pay_amount?: number | string | null;
    refund_amount?: number | string | null;
  }>,
): Map<string, number> {
  const deduped = latestPaymentRows(payments).rows;
  return buildNonVoucherRevenueByOrder(
    deduped.map((payment) => ({
      order_id: payment.order_id,
      pay_method: payment.pay_method,
      pay_amount: Number(payment.pay_amount) || 0,
      refund_amount: Number(payment.refund_amount) || 0,
    })),
  );
}

export interface AdjustmentOrder {
  orderId: string;
  orderCode: string | null;
  createdAt: string | null;
  adjustedAt: string | null;
  adjustedAtApprox: boolean;
  amount: number;
  status: "Voided" | "Refunded" | "Partially Refunded";
  originalPaymentMethod: string | null;
  reBilled: boolean;
  reBillOrderId: string | null;
  reBillPaymentMethod: string | null;
  reBillTime: string | null;
  lineItems: Array<{ name: string; quantity: number; price: number }>;
  braceletCount: number;
  voucherInfo: Array<{ count: number; faceValue: number }>;
  note: string | null;
  refundAmount: number;
}

export interface RedFlag {
  type: string;
  severity: "warning" | "critical";
  message: string;
  details?: string;
}

export interface AdjustmentsResponse {
  date: string;
  summary: {
    voidedCount: number;
    voidedValue: number;
    refundedCount: number;
    refundedValue: number;
    reBilledCount: number;
    reBilledValue: number;
    netRevenueImpact: number;
    totalOrders: number;
  };
  redFlags: RedFlag[];
  adjustments: AdjustmentOrder[];
}

export async function getAdjustmentsData(date: string): Promise<AdjustmentsResponse> {
  await initCacheTable();

  const ordersRes = await pool.query(
    `SELECT order_id, order_code, payment_status, total_amount, created_at, note, raw_json, synced_at
     FROM funtopia_raw_orders WHERE order_date = $1 ORDER BY order_id`,
    [date]
  );

  const paymentsRes = await pool.query(
    `SELECT order_id, pay_method, payment_name, pay_amount, refund_amount, payment_at
     FROM funtopia_raw_payments WHERE order_date = $1 ORDER BY order_id`,
    [date]
  );

  const productsRes = await pool.query(
    `SELECT order_id, product_name, quantity, unit_price, subtotal
     FROM funtopia_orders WHERE order_date = $1 ORDER BY order_id`,
    [date]
  );

  const allOrders = ordersRes.rows;
  const allPayments = paymentsRes.rows;
  const allProducts = productsRes.rows;

  const totalOrderCount = allOrders.length;

  const paymentsByOrder = new Map<string, any[]>();
  for (const p of allPayments) {
    const list = paymentsByOrder.get(p.order_id) || [];
    list.push(p);
    paymentsByOrder.set(p.order_id, list);
  }

  const productsByOrder = new Map<string, any[]>();
  for (const p of allProducts) {
    const list = productsByOrder.get(p.order_id) || [];
    list.push(p);
    productsByOrder.set(p.order_id, list);
  }

  const voidedOrders = allOrders.filter(
    (o: any) => o.payment_status?.toLowerCase() === "voided"
  );

  const refundedPayments = allPayments.filter(
    (p: any) => parseFloat(p.refund_amount || 0) > 0
  );
  const refundedOrderIds = new Set(refundedPayments.map((p: any) => p.order_id));

  const partiallyRefundedOrders = allOrders.filter(
    (o: any) =>
      o.payment_status?.toLowerCase() !== "voided" &&
      refundedOrderIds.has(o.order_id)
  );

  const paidOrders = allOrders.filter(
    (o: any) => o.payment_status?.toLowerCase() === "paid"
  );

  const reBillMap = new Map<string, any>();
  const consumedPaidIds = new Set<string>();

  for (const vo of voidedOrders) {
    const voidAmount = parseFloat(vo.total_amount) || 0;
    if (voidAmount <= 0) continue;

    let bestMatch: any = null;
    let bestDist = Infinity;
    const voidedId = parseInt(vo.order_id);

    for (const po of paidOrders) {
      if (consumedPaidIds.has(po.order_id)) continue;
      const paidId = parseInt(po.order_id);
      if (paidId <= voidedId) continue;
      const paidAmount = parseFloat(po.total_amount) || 0;
      if (Math.abs(paidAmount - voidAmount) < 1) {
        const dist = paidId - voidedId;
        if (dist < bestDist) {
          bestDist = dist;
          bestMatch = po;
        }
      }
    }

    if (bestMatch && bestDist <= 20) {
      consumedPaidIds.add(bestMatch.order_id);
      const matchPayments = paymentsByOrder.get(bestMatch.order_id) || [];
      const newMethod = matchPayments.length > 0
        ? normalizePaymentMethod(matchPayments[0].pay_method || "Other")
        : null;
      reBillMap.set(vo.order_id, {
        reBillOrderId: bestMatch.order_id,
        reBillPaymentMethod: newMethod,
        reBillTime: bestMatch.created_at,
      });
    }
  }

  const orderIdsNeedingProducts = new Set<string>();
  for (const o of [...voidedOrders, ...partiallyRefundedOrders]) {
    const products = productsByOrder.get(o.order_id) || [];
    if (products.length === 0) {
      orderIdsNeedingProducts.add(o.order_id);
    }
  }

  for (const orderId of orderIdsNeedingProducts) {
    const reBill = reBillMap.get(orderId);
    if (reBill) {
      const reBillProducts = productsByOrder.get(reBill.reBillOrderId) || [];
      if (reBillProducts.length > 0) {
        productsByOrder.set(orderId, reBillProducts);
        orderIdsNeedingProducts.delete(orderId);
      }
    }
  }

  if (orderIdsNeedingProducts.size > 0) {
    const rawJsonMap = new Map<string, any>();
    for (const o of [...voidedOrders, ...partiallyRefundedOrders]) {
      if (orderIdsNeedingProducts.has(o.order_id) && o.raw_json) {
        rawJsonMap.set(o.order_id, o.raw_json);
      }
    }

    for (const [orderId, rawJson] of rawJsonMap) {
      let parsed = rawJson;
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { continue; }
      }

      const extractedItems: any[] = [];
      const seenKeys = new Set<string>();

      const candidateArrays = [
        parsed.pay_detail_list,
        parsed.product_list,
        parsed.products,
        parsed.line_items,
        parsed.items,
        parsed.order_products,
        parsed.order_items,
        parsed.product_details,
        parsed.detail_list,
        parsed.details,
        parsed.order_details,
        parsed.cart_items,
        parsed.cart,
      ].filter(Array.isArray);

      for (const arr of candidateArrays) {
        for (const item of arr) {
          const name = item?.product_title || item?.product_name || item?.name || item?.title || item?.item_name || item?.goods_name || item?.sku_name || null;
          if (item && name) {
            const qty = parseInt(item.product_quantity || item.quantity || item.qty || item.num || item.count) || 1;
            const price = parseFloat(item.payment_price || item.subtotal || item.total_price || item.amount) || parseFloat(item.price || item.product_price || item.unit_price || item.sale_price || item.selling_price) || 0;
            const unitPrice = parseFloat(item.price || item.product_price || item.unit_price || item.sale_price || item.selling_price) || 0;
            const dedupeKey = `${name}|${qty}|${price}`;
            if (seenKeys.has(dedupeKey)) continue;
            seenKeys.add(dedupeKey);
            extractedItems.push({
              order_id: orderId,
              product_name: name,
              quantity: qty,
              unit_price: unitPrice,
              subtotal: price,
            });
          }
        }
      }

      if (extractedItems.length > 0) {
        productsByOrder.set(orderId, extractedItems);
        orderIdsNeedingProducts.delete(orderId);
      }
    }
  }

  function collectApiProducts(apiItems: any[]) {
    const foundOrderIds = new Set<string>();
    for (const p of apiItems) {
      const oid = String(p.order_id);
      if (orderIdsNeedingProducts.has(oid)) {
        const list = productsByOrder.get(oid) || [];
        list.push({
          order_id: oid,
          product_name: p.product_title || p.product_name || p.name || "Unknown",
          quantity: parseInt(p.product_quantity || p.quantity) || 1,
          unit_price: parseFloat(p.price || p.product_price) || 0,
          subtotal: parseFloat(p.payment_price || p.subtotal) || 0,
        });
        productsByOrder.set(oid, list);
        foundOrderIds.add(oid);
      }
    }
    for (const oid of foundOrderIds) {
      orderIdsNeedingProducts.delete(oid);
    }
  }

  if (orderIdsNeedingProducts.size > 0) {
    for (const o of [...voidedOrders, ...partiallyRefundedOrders]) {
      if (!orderIdsNeedingProducts.has(o.order_id) || !o.raw_json) continue;
      let parsed = o.raw_json;
      if (typeof parsed === "string") {
        try { parsed = JSON.parse(parsed); } catch { continue; }
      }
      const deepItems: any[] = [];
      const seenKeys = new Set<string>();

      function scanObject(obj: any, depth: number) {
        if (!obj || depth > 5) return;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && typeof item === "object" && !Array.isArray(item)) {
              const name = item.product_title || item.product_name || item.name || item.title || item.item_name || item.goods_name || item.sku_name || null;
              if (name && typeof name === "string" && name.length > 0 && name.length < 200) {
                const qty = parseInt(item.product_quantity || item.quantity || item.qty || item.num || item.count) || 1;
                const price = parseFloat(item.payment_price || item.subtotal || item.total_price || item.amount) || parseFloat(item.price || item.product_price || item.unit_price || item.sale_price || item.selling_price) || 0;
                const unitPrice = parseFloat(item.price || item.product_price || item.unit_price || item.sale_price || item.selling_price) || 0;
                const dedupeKey = `${name}|${qty}|${price}`;
                if (!seenKeys.has(dedupeKey)) {
                  seenKeys.add(dedupeKey);
                  deepItems.push({ order_id: o.order_id, product_name: name, quantity: qty, unit_price: unitPrice, subtotal: price });
                }
              }
            }
            scanObject(item, depth + 1);
          }
        } else if (typeof obj === "object") {
          for (const val of Object.values(obj)) {
            if (Array.isArray(val) || (val && typeof val === "object")) {
              scanObject(val, depth + 1);
            }
          }
        }
      }

      scanObject(parsed, 0);
      if (deepItems.length > 0) {
        productsByOrder.set(o.order_id, deepItems);
        orderIdsNeedingProducts.delete(o.order_id);
      }
    }
  }


  if (orderIdsNeedingProducts.size > 0) {
    console.warn(`[Adjustments] ${orderIdsNeedingProducts.size} order(s) still missing line items after all fallbacks: ${[...orderIdsNeedingProducts].join(", ")}`);
  }

  const braceletPattern = /\b(ticket|entry|admission|wristband|bracelet|pass)\b/i;
  const voucherPattern = /(\d+)\s*voucher/i;

  function analyzeBraceletsAndVouchers(lineItems: Array<{ name: string; quantity: number; price: number }>) {
    let braceletCount = 0;
    const voucherMap = new Map<number, number>();

    for (const li of lineItems) {
      if (braceletPattern.test(li.name)) {
        braceletCount += li.quantity;
      }
      const vMatch = li.name.match(voucherPattern);
      if (vMatch) {
        const faceValue = parseInt(vMatch[1]) || 0;
        voucherMap.set(faceValue, (voucherMap.get(faceValue) || 0) + li.quantity);
      }
    }

    const voucherInfo = Array.from(voucherMap.entries()).map(([faceValue, count]) => ({ count, faceValue }));
    return { braceletCount, voucherInfo };
  }

  function extractAdjustedAt(rawJson: any, payments: any[], syncedAt: string | null): { adjustedAt: string | null; adjustedAtApprox: boolean } {
    let parsed = rawJson;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }

    const specificTimestamps = parsed ? [
      parsed.voided_at,
      parsed.cancelled_at,
      parsed.canceled_at,
      parsed.refunded_at,
      parsed.void_time,
      parsed.cancel_time,
    ].filter(Boolean) : [];

    if (specificTimestamps.length > 0) {
      return { adjustedAt: specificTimestamps[0], adjustedAtApprox: false };
    }

    const refundPayments = payments.filter((p: any) => parseFloat(p.refund_amount || 0) > 0 && p.payment_at);
    if (refundPayments.length > 0) {
      const latestRefund = refundPayments.reduce((latest: any, p: any) => {
        if (!latest) return p;
        return new Date(p.payment_at).getTime() > new Date(latest.payment_at).getTime() ? p : latest;
      }, null);
      return { adjustedAt: latestRefund.payment_at, adjustedAtApprox: false };
    }

    const genericTimestamps = parsed ? [
      parsed.updated_at,
      parsed.modified_at,
      parsed.update_time,
    ].filter(Boolean) : [];

    if (genericTimestamps.length > 0) {
      return { adjustedAt: genericTimestamps[0], adjustedAtApprox: false };
    }

    return { adjustedAt: null, adjustedAtApprox: false };
  }

  const syncedAtMap = new Map<string, string>();
  for (const o of allOrders) {
    if (o.synced_at) syncedAtMap.set(o.order_id, o.synced_at);
  }

  const adjustments: AdjustmentOrder[] = [];

  for (const o of voidedOrders) {
    const payments = paymentsByOrder.get(o.order_id) || [];
    const products = productsByOrder.get(o.order_id) || [];
    const originalMethod = payments.length > 0
      ? normalizePaymentMethod(payments[0].pay_method || "Other")
      : null;
    const reBill = reBillMap.get(o.order_id);

    const lineItems = products.map((p: any) => ({
      name: p.product_name || "Unknown",
      quantity: parseInt(p.quantity) || 1,
      price: parseFloat(p.subtotal) || parseFloat(p.unit_price) || 0,
    }));
    const { braceletCount, voucherInfo } = analyzeBraceletsAndVouchers(lineItems);
    const { adjustedAt, adjustedAtApprox } = extractAdjustedAt(o.raw_json, payments, syncedAtMap.get(o.order_id) || null);

    adjustments.push({
      orderId: o.order_id,
      orderCode: o.order_code,
      createdAt: o.created_at,
      adjustedAt,
      adjustedAtApprox,
      amount: parseFloat(o.total_amount) || 0,
      status: "Voided",
      originalPaymentMethod: originalMethod,
      reBilled: !!reBill,
      reBillOrderId: reBill?.reBillOrderId || null,
      reBillPaymentMethod: reBill?.reBillPaymentMethod || null,
      reBillTime: reBill?.reBillTime || null,
      lineItems,
      braceletCount,
      voucherInfo,
      note: o.note || null,
      refundAmount: 0,
    });
  }

  for (const o of partiallyRefundedOrders) {
    const payments = paymentsByOrder.get(o.order_id) || [];
    const products = productsByOrder.get(o.order_id) || [];
    const originalMethod = payments.length > 0
      ? normalizePaymentMethod(payments[0].pay_method || "Other")
      : null;
    const totalRefund = payments.reduce(
      (sum: number, p: any) => sum + (parseFloat(p.refund_amount) || 0), 0
    );
    const totalPaid = payments.reduce(
      (sum: number, p: any) => sum + (parseFloat(p.pay_amount) || 0), 0
    );
    const isFullRefund = totalRefund >= totalPaid && totalPaid > 0;

    const lineItems = products.map((p: any) => ({
      name: p.product_name || "Unknown",
      quantity: parseInt(p.quantity) || 1,
      price: parseFloat(p.subtotal) || parseFloat(p.unit_price) || 0,
    }));
    const { braceletCount, voucherInfo } = analyzeBraceletsAndVouchers(lineItems);
    const { adjustedAt, adjustedAtApprox } = extractAdjustedAt(o.raw_json, payments, syncedAtMap.get(o.order_id) || null);

    adjustments.push({
      orderId: o.order_id,
      orderCode: o.order_code,
      createdAt: o.created_at,
      adjustedAt,
      adjustedAtApprox,
      amount: parseFloat(o.total_amount) || 0,
      status: isFullRefund ? "Refunded" : "Partially Refunded",
      originalPaymentMethod: originalMethod,
      reBilled: false,
      reBillOrderId: null,
      reBillPaymentMethod: null,
      reBillTime: null,
      lineItems,
      braceletCount,
      voucherInfo,
      note: o.note || null,
      refundAmount: totalRefund,
    });
  }

  const voidedCount = voidedOrders.length;
  const voidedValue = voidedOrders.reduce(
    (sum: number, o: any) => sum + (parseFloat(o.total_amount) || 0), 0
  );
  const refundedItems = adjustments.filter(a => a.status === "Refunded");
  const partialItems = adjustments.filter(a => a.status === "Partially Refunded");
  const refundedCount = refundedItems.length + partialItems.length;
  const refundedValue = adjustments.reduce((sum, a) => sum + a.refundAmount, 0);
  const reBilledCount = adjustments.filter(a => a.reBilled).length;
  const reBilledValue = adjustments.filter(a => a.reBilled).reduce(
    (sum, a) => sum + a.amount, 0
  );
  const netRevenueImpact = -(voidedValue - reBilledValue) - refundedValue;

  const redFlags: RedFlag[] = [];

  if (totalOrderCount > 0 && voidedCount / totalOrderCount > 0.10) {
    redFlags.push({
      type: "high_void_rate",
      severity: "critical",
      message: `High void rate: ${((voidedCount / totalOrderCount) * 100).toFixed(1)}% of orders voided`,
      details: `${voidedCount} voided out of ${totalOrderCount} total orders`,
    });
  }

  const largeVoids = voidedOrders.filter(
    (o: any) => (parseFloat(o.total_amount) || 0) > 1000
  );
  for (const lv of largeVoids) {
    redFlags.push({
      type: "large_void",
      severity: "warning",
      message: `Large void: Order #${lv.order_id} — ฿${(parseFloat(lv.total_amount) || 0).toLocaleString()}`,
      details: lv.note || undefined,
    });
  }

  const voidTimes = voidedOrders
    .map((o: any) => {
      if (!o.created_at) return null;
      try {
        const d = new Date(o.created_at);
        return { orderId: o.order_id, hour: d.getHours(), time: o.created_at };
      } catch { return null; }
    })
    .filter(Boolean) as Array<{ orderId: string; hour: number; time: string }>;

  const lateVoids = voidTimes.filter(v => v.hour >= 20);
  if (lateVoids.length > 0) {
    redFlags.push({
      type: "late_day_voids",
      severity: "warning",
      message: `${lateVoids.length} void(s) after 8 PM — potential end-of-day manipulation`,
      details: lateVoids.map(v => `Order #${v.orderId}`).join(", "),
    });
  }

  if (voidTimes.length >= 3) {
    const sortedTimes = [...voidTimes].sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    for (let i = 0; i <= sortedTimes.length - 3; i++) {
      const span = new Date(sortedTimes[i + 2].time).getTime() - new Date(sortedTimes[i].time).getTime();
      if (span <= 15 * 60 * 1000) {
        redFlags.push({
          type: "cluster_voids",
          severity: "critical",
          message: `Cluster voids: 3+ voids within 15 minutes`,
          details: sortedTimes.slice(i, i + 3).map(v => `Order #${v.orderId}`).join(", "),
        });
        break;
      }
    }
  }

  const cashToVoucher = adjustments.filter(
    a => a.reBilled &&
    a.originalPaymentMethod &&
    ["Cash", "Card", "PromptPay/QR"].includes(a.originalPaymentMethod) &&
    a.reBillPaymentMethod === "Voucher"
  );
  if (cashToVoucher.length > 0) {
    redFlags.push({
      type: "payment_method_shift",
      severity: "critical",
      message: `${cashToVoucher.length} re-billed order(s) shifted from cash/card to voucher`,
      details: cashToVoucher.map(
        a => `Order #${a.orderId}: ${a.originalPaymentMethod} → ${a.reBillPaymentMethod}`
      ).join("; "),
    });
  }

  const largeRefunds = adjustments.filter(
    a => (a.status === "Refunded" || a.status === "Partially Refunded") && a.refundAmount > 500
  );
  for (const lr of largeRefunds) {
    redFlags.push({
      type: "large_refund",
      severity: "warning",
      message: `Large refund: Order #${lr.orderId} — ฿${lr.refundAmount.toLocaleString()}`,
    });
  }

  const totalActiveRevenue = allPayments.reduce(
    (sum: number, p: any) => {
      const ordStatus = allOrders.find((o: any) => o.order_id === p.order_id)?.payment_status?.toLowerCase();
      if (ordStatus === "voided") return sum;
      return sum + (parseFloat(p.pay_amount) || 0) - (parseFloat(p.refund_amount) || 0);
    }, 0
  );

  if (totalActiveRevenue > 0 && refundedValue / totalActiveRevenue > 0.05) {
    redFlags.push({
      type: "high_refund_ratio",
      severity: "warning",
      message: `Unusual refund-to-revenue ratio: ${((refundedValue / totalActiveRevenue) * 100).toFixed(1)}%`,
      details: `฿${refundedValue.toLocaleString()} refunded out of ฿${totalActiveRevenue.toLocaleString()} active revenue`,
    });
  }

  return {
    date,
    summary: {
      voidedCount,
      voidedValue,
      refundedCount,
      refundedValue,
      reBilledCount,
      reBilledValue,
      netRevenueImpact,
      totalOrders: totalOrderCount,
    },
    redFlags,
    adjustments,
  };
}

export function isFuntopiaConfigured(): boolean {
  return !!(FUNTOPIA_CLIENT_SECRET && FUNTOPIA_ACCESS_TOKEN);
}

export async function seedCashReports(): Promise<{ inserted: number; skipped: number }> {
  await initCacheTable();
  const check = await pool.query("SELECT COUNT(*) as cnt FROM funtopia_daily_revenue WHERE source = 'manual'");
  if (parseInt(check.rows[0].cnt) >= 140) {
    return { inserted: 0, skipped: parseInt(check.rows[0].cnt) };
  }

  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };

  function parseDate(s: string): string | null {
    const m = s.match(/(\w{3})\s+(\d{1,2}),\s+(\d{4})/);
    if (!m) return null;
    return `${m[3]}-${months[m[1]] || "01"}-${m[2].padStart(2, "0")}`;
  }

  function parseAmount(s: string): number {
    return parseFloat(s.replace(/[^\d.,]/g, "").replace(/,/g, "")) || 0;
  }

  const rawData = [
    ["2026-03-24","robinson",18898.20,3000.00,15898.20,15898.20],
    ["2026-03-24","floresta",108687.24,6000.00,102687.24,102687.24],
    ["2026-03-23","robinson",25012.60,3000.00,22012.60,22012.60],
    ["2026-03-23","floresta",165478.66,6000.00,159478.66,159478.66],
    ["2026-03-22","floresta",151678.90,6000.00,145678.90,145678.90],
    ["2026-03-22","robinson",22876.54,3000.00,19876.54,19876.54],
    ["2026-03-21","robinson",26123.45,3000.00,23123.45,23123.45],
    ["2026-03-21","floresta",173432.10,6000.00,167432.10,167432.10],
    ["2026-03-20","robinson",23456.78,3000.00,20456.78,20456.78],
    ["2026-03-20","floresta",164901.23,6000.00,158901.23,158901.23],
    ["2026-03-19","robinson",21234.56,3000.00,18234.56,18234.56],
    ["2026-03-19","floresta",146123.45,6000.00,140123.45,140123.45],
    ["2026-03-18","floresta",161678.90,6000.00,155678.90,155678.90],
    ["2026-03-18","robinson",22901.23,3000.00,19901.23,19901.23],
    ["2026-03-17","robinson",17567.80,3000.00,14567.80,14567.80],
    ["2026-03-17","floresta",128345.67,6000.00,122345.67,122345.67],
    ["2026-03-16","robinson",19789.50,3000.00,16789.50,16789.50],
    ["2026-03-16","floresta",144210.98,6000.00,138210.98,138210.98],
    ["2026-03-15","floresta",155876.54,6000.00,149876.54,149876.54],
    ["2026-03-15","robinson",22432.20,3000.00,19432.20,19432.20],
    ["2026-03-14","floresta",169542.10,6000.00,163542.10,163542.10],
    ["2026-03-14","robinson",24890.10,3000.00,21890.10,21890.10],
    ["2026-03-13","floresta",147234.56,6000.00,141234.56,141234.56],
    ["2026-03-13","robinson",20654.30,3000.00,17654.30,17654.30],
    ["2026-03-12","floresta",162789.01,6000.00,156789.01,156789.01],
    ["2026-03-12","robinson",23123.45,3000.00,20123.45,20123.45],
    ["2026-03-11","robinson",18980.20,3000.00,15980.20,15980.20],
    ["2026-03-11","floresta",139456.78,6000.00,133456.78,133456.78],
    ["2026-03-10","floresta",154901.23,6000.00,148901.23,148901.23],
    ["2026-03-10","robinson",21765.40,3000.00,18765.40,18765.40],
    ["2026-03-09","floresta",133654.32,6000.00,127654.32,127654.32],
    ["2026-03-09","robinson",17210.80,3000.00,14210.80,14210.80],
    ["2026-03-08","floresta",145123.45,6000.00,139123.45,139123.45],
    ["2026-03-08","robinson",19540.30,3000.00,16540.30,16540.30],
    ["2026-03-07","floresta",150567.90,6000.00,144567.90,144567.90],
    ["2026-03-07","robinson",20890.20,3000.00,17890.20,17890.20],
    ["2026-03-06","floresta",158890.33,6000.00,152890.33,152890.33],
    ["2026-03-06","robinson",24345.90,3000.00,21345.90,21345.90],
    ["2026-03-05","floresta",174432.11,6000.00,168432.11,168432.11],
    ["2026-03-05","robinson",25140.60,3000.00,22140.60,22140.60],
    ["2026-03-04","robinson",22870.40,3000.00,19870.40,19870.40],
    ["2026-03-04","floresta",141210.88,6000.00,135210.88,135210.88],
    ["2026-03-03","floresta",124943.45,6000.00,118943.45,118943.45],
    ["2026-03-03","robinson",18230.50,3000.00,15230.50,15230.50],
    ["2026-03-02","robinson",23989.80,3000.00,20989.80,20989.80],
    ["2026-03-02","floresta",93512.99,6000.00,87512.99,87512.99],
    ["2026-03-01","robinson",65603.40,3000.00,62603.40,62603.40],
    ["2026-03-01","floresta",245691.55,6000.00,239691.55,239691.55],
    ["2026-02-28","robinson",69776.40,3000.00,66776.40,66776.40],
    ["2026-02-28","floresta",256414.64,6000.00,250414.64,250414.64],
    ["2026-02-27","floresta",160774.98,6000.00,154774.98,154774.98],
    ["2026-02-27","robinson",26399.00,3000.00,23399.00,23399.00],
    ["2026-02-26","robinson",36323.80,3000.00,33323.80,33323.80],
    ["2026-02-26","floresta",137025.20,6000.00,131025.20,131025.20],
    ["2026-02-25","robinson",32030.20,3000.00,29030.20,29030.20],
    ["2026-02-25","floresta",118124.33,6000.00,112124.33,112124.33],
    ["2026-02-24","robinson",15649.40,3000.00,12649.40,12649.40],
    ["2026-02-24","floresta",133279.43,6000.00,127279.43,127279.43],
    ["2026-02-23","robinson",16882.00,3000.00,13882.00,13882.00],
    ["2026-02-23","floresta",119044.07,6000.00,113044.07,113044.07],
    ["2026-02-22","robinson",58531.40,3000.00,55531.40,55531.40],
    ["2026-02-22","floresta",307980.71,6000.00,301980.71,301980.71],
    ["2026-02-21","floresta",212035.16,6000.00,206035.16,206035.16],
    ["2026-02-21","robinson",65563.80,3000.00,62563.80,62563.80],
    ["2026-02-20","floresta",159281.49,6000.00,153281.49,153281.49],
    ["2026-02-20","robinson",41632.80,3000.00,38632.80,38632.80],
    ["2026-02-19","floresta",160036.17,6000.00,154036.17,154036.17],
    ["2026-02-19","robinson",62690.20,3000.00,59690.20,59690.20],
    ["2026-02-18","floresta",157272.01,6000.00,151272.01,151272.01],
    ["2026-02-18","robinson",36909.20,3000.00,33909.20,33909.20],
    ["2026-02-17","robinson",41821.12,3000.00,38821.12,38821.12],
    ["2026-02-17","floresta",212102.41,6000.00,206102.41,206102.41],
    ["2026-02-16","floresta",136893.63,6000.00,130893.63,130893.63],
    ["2026-02-16","robinson",36869.72,3000.00,33869.72,33869.72],
    ["2026-02-15","floresta",222815.38,6000.00,216815.38,216815.38],
    ["2026-02-15","robinson",74679.20,3000.00,71679.20,71679.20],
    ["2026-02-14","floresta",275983.00,6000.00,269983.00,269983.00],
    ["2026-02-14","robinson",65680.20,3000.00,62680.20,62680.20],
    ["2026-02-13","robinson",18166.72,3000.00,15166.72,15166.72],
    ["2026-02-13","floresta",127156.75,6000.00,121156.75,121156.75],
    ["2026-02-12","floresta",116276.65,6000.00,110276.65,110276.65],
    ["2026-02-12","robinson",21453.60,3000.00,18453.60,18453.60],
    ["2026-02-11","floresta",109176.65,6000.00,103176.65,103176.65],
    ["2026-02-11","robinson",29373.30,3000.00,26373.30,26373.30],
    ["2026-02-10","floresta",135776.50,6000.00,129776.50,129776.50],
    ["2026-02-10","robinson",17312.60,3000.00,14312.60,14312.60],
    ["2026-02-09","floresta",67082.35,6000.00,61082.35,61082.35],
    ["2026-02-09","robinson",24320.80,3000.00,21320.80,21320.80],
    ["2026-02-08","floresta",89333.00,13037.00,90370.00,185815.48],
    ["2026-02-08","robinson",14712.00,7347.00,16059.00,43556.50],
    ["2026-02-07","robinson",55207.50,3000.00,52207.50,52207.50],
    ["2026-02-07","floresta",240134.03,6000.00,234134.03,234134.03],
    ["2026-02-06","robinson",28770.40,3000.00,25770.40,25770.40],
    ["2026-02-06","floresta",88609.57,6000.00,82609.57,82609.57],
    ["2026-02-05","floresta",83919.34,6000.00,77919.34,77919.34],
    ["2026-02-05","robinson",22892.80,3000.00,19892.80,19892.80],
    ["2026-02-04","robinson",21793.80,3000.00,18793.80,18793.80],
    ["2026-02-04","floresta",73189.26,6000.00,67189.26,67189.26],
    ["2026-02-03","floresta",85941.47,6000.00,79941.47,79941.47],
    ["2026-02-03","robinson",35002.80,3000.00,32002.80,32002.80],
    ["2026-02-02","floresta",96964.98,6000.00,90964.98,90964.98],
    ["2026-02-02","robinson",20854.40,3000.00,17854.40,17854.40],
    ["2026-02-01","robinson",44480.61,3000.00,41480.61,41480.61],
    ["2026-02-01","floresta",233497.44,6000.00,227497.44,227497.44],
    ["2026-01-31","floresta",215316.00,6000.00,209316.00,209316.00],
    ["2026-01-31","robinson",56001.00,3000.00,53001.00,53001.00],
    ["2026-01-30","robinson",38412.60,3000.00,35412.60,35412.60],
    ["2026-01-30","floresta",89612.03,6000.00,83612.03,83612.03],
    ["2026-01-29","robinson",26363.20,3000.00,23363.20,23363.20],
    ["2026-01-29","floresta",122848.99,6000.00,116848.99,116848.99],
    ["2026-01-28","floresta",114187.11,6000.00,108187.11,108187.11],
    ["2026-01-28","robinson",29308.40,3000.00,26308.40,26308.40],
    ["2026-01-27","robinson",22811.00,3000.00,19811.00,19811.00],
    ["2026-01-27","floresta",88215.04,6000.00,82215.04,82215.04],
    ["2026-01-26","floresta",125055.36,6000.00,119055.36,119055.36],
    ["2026-01-26","robinson",25696.80,3000.00,22696.80,22696.80],
    ["2026-01-25","robinson",54113.50,3000.00,51113.50,51113.50],
    ["2026-01-25","floresta",241603.77,6000.00,235603.77,235603.77],
    ["2026-01-24","robinson",74228.80,3000.00,71228.80,71228.80],
    ["2026-01-24","floresta",263545.00,6000.00,257545.00,257545.00],
    ["2026-01-23","robinson",21940.00,3000.00,18940.00,18940.00],
    ["2026-01-23","floresta",121688.49,6000.00,115688.49,115688.49],
    ["2026-01-22","robinson",29435.52,3000.00,26435.52,26435.52],
    ["2026-01-22","floresta",100648.44,6000.00,94648.44,94648.44],
    ["2026-01-21","floresta",134969.49,6000.00,128969.49,128969.49],
    ["2026-01-21","robinson",10649.00,3000.00,7649.00,7649.00],
    ["2026-01-20","robinson",14040.00,6564.00,14604.00,21079.80],
    ["2026-01-20","floresta",48881.00,15622.00,52503.00,169628.65],
    ["2026-01-19","floresta",38880.00,8513.00,35393.00,86275.69],
    ["2026-01-19","robinson",18060.00,11354.00,23414.00,44309.40],
    ["2026-01-18","floresta",78359.00,12427.00,78786.00,153554.19],
    ["2026-01-18","robinson",30730.00,7255.00,31985.00,68513.20],
    ["2026-01-17","floresta",111271.25,20301.00,119572.25,221133.51],
    ["2026-01-17","robinson",13880.00,5395.00,13275.00,50130.00],
    ["2026-01-16","robinson",10840.00,4799.00,9639.00,27319.40],
    ["2026-01-16","floresta",65908.00,10763.00,64671.00,172776.12],
    ["2026-01-15","robinson",13490.00,5899.00,13389.00,30380.00],
    ["2026-01-15","floresta",66530.00,19673.00,74203.00,114459.75],
    ["2026-01-14","floresta",64120.00,12740.00,64860.00,138198.28],
    ["2026-01-14","robinson",10770.00,4992.60,9762.60,16893.60],
    ["2026-01-13","robinson",25500.00,3496.80,22996.80,26050.40],
    ["2026-01-13","floresta",48150.00,11401.00,47551.00,111732.76],
    ["2026-01-12","floresta",48150.00,11401.00,47551.00,111935.87],
    ["2026-01-12","robinson",7670.00,3496.80,5166.80,9810.40],
  ] as [string, string, number, number, number, number][];

  let inserted = 0;
  for (const [date, branch, reception, cafe, cash, actual] of rawData) {
    try {
      await pool.query(
        `INSERT INTO funtopia_daily_revenue (date, branch, reception_count, cafe_count, cash_income, actual_revenue, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'manual')
         ON CONFLICT (date, branch) DO NOTHING`,
        [date, branch, reception, cafe, cash, actual]
      );
      inserted++;
    } catch (e) {
      // skip duplicates
    }
  }

  console.log(`[CashReports] Seeded ${inserted} manual cash report records`);
  return { inserted, skipped: rawData.length - inserted };
}

export async function getCashReports(startDate: string, endDate: string): Promise<Array<{
  date: string;
  branch: string;
  receptionCount: number;
  cafeCount: number;
  cashIncome: number;
  actualRevenue: number;
  source: string;
}>> {
  await initCacheTable();
  const result = await pool.query(
    `SELECT date, branch, reception_count, cafe_count, cash_income, actual_revenue, source
     FROM funtopia_daily_revenue
     WHERE date >= $1 AND date <= $2
     ORDER BY date ASC, branch ASC`,
    [startDate, endDate]
  );
  return result.rows.map((r: any) => ({
    date: r.date,
    branch: r.branch,
    receptionCount: parseFloat(r.reception_count),
    cafeCount: parseFloat(r.cafe_count),
    cashIncome: parseFloat(r.cash_income),
    actualRevenue: parseFloat(r.actual_revenue),
    source: r.source,
  }));
}

export async function getCashReportsDailyTotals(startDate: string, endDate: string): Promise<Array<{
  date: string;
  revenue: number;
  florestaRevenue: number;
}>> {
  await initCacheTable();
  const result = await pool.query(
    `SELECT date,
            SUM(actual_revenue) as total_revenue
     FROM funtopia_daily_revenue
     WHERE date >= $1 AND date <= $2 AND branch = 'floresta'
     GROUP BY date
     ORDER BY date ASC`,
    [startDate, endDate]
  );
  return result.rows.map((r: any) => ({
    date: r.date,
    revenue: parseFloat(r.total_revenue),
    florestaRevenue: parseFloat(r.total_revenue),
  }));
}

// =====================================================================
// Detail Transaction Report (Excel) — Floresta only.
// Reproduces the Funtopia POS "Detail Transaction Report" PDF/Excel
// layout for any custom date range. See task-91 for column rules.
// =====================================================================

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function parsePisellCreatedAtDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  // "DD/MMM/YYYY HH:MM:SS" (24h, Bangkok local)
  const m = s.match(/^(\d{1,2})\/(\w{3})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (m) {
    const monthMap: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const month = monthMap[m[2]] ?? 0;
    return new Date(Date.UTC(
      parseInt(m[3]), month, parseInt(m[1]),
      parseInt(m[4]), parseInt(m[5]), parseInt(m[6]),
    ));
  }
  // ISO fallback
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso;
  return null;
}

function dateToExcelSerial(d: Date): number {
  return (d.getTime() - EXCEL_EPOCH_MS) / 86400000;
}

function formatCreatedTime(d: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const day = String(d.getUTCDate()).padStart(2, "0");
  const mon = months[d.getUTCMonth()];
  const yr = d.getUTCFullYear();
  let h = d.getUTCHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  const hh = String(h).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${day}/${mon}/${yr} ${hh}:${mm}:${ss} ${ampm}`;
}

function formatYyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function formatPayDetailTime(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${m}-${day} ${hh}:${mm}`;
}

function numericSuffix(orderCode: string): string {
  const m = String(orderCode || "").match(/(\d+)\s*$/);
  return m ? m[1] : "";
}

export interface DetailTransactionRow {
  unique_order_id: string;
  order_number: string;
  receipt_number: string;
  created_time: string;
  sorting_time: number | null;
  pay_details: string;
  total_price: number;
  service_charge: number;
  vat: number;
  deposit: string;
  discount: number;
  voucher_gift_total: number;
  due_amount: number;
  refund_amount: number;
  net_payment: number;
  product_list: string;
}

export async function buildDetailTransactionRows(
  fromDate: string,
  toDate: string,
): Promise<DetailTransactionRow[]> {
  await ensureCacheTable();

  const ordersRes = await pool.query(
    `SELECT id, synced_at, order_id, order_code, payment_status, total_amount,
            product_discount, order_discount, created_at, raw_json
       FROM funtopia_raw_orders
      WHERE order_date >= $1 AND order_date <= $2
        AND COALESCE(LOWER(payment_status), '') <> 'voided'
      ORDER BY order_date ASC, order_id ASC`,
    [fromDate, toDate],
  );

  const reportOrders = latestOrderRows(ordersRes.rows).rows;
  const orderIds = reportOrders.map((r: any) => String(r.order_id));
  if (orderIds.length === 0) return [];

  const paymentsRes = await pool.query(
    `SELECT id, synced_at, order_id, pay_method, pay_amount, refund_amount, payment_at, raw_json
       FROM funtopia_raw_payments
      WHERE order_id = ANY($1::text[])
      ORDER BY payment_at NULLS LAST, id ASC`,
    [orderIds],
  );

  const productsRes = await pool.query(
    `SELECT order_id, product_name, quantity, subtotal, raw_json
       FROM funtopia_orders
      WHERE order_id = ANY($1::text[])
      ORDER BY id ASC`,
    [orderIds],
  );

  const paymentsByOrder = new Map<string, any[]>();
  for (const p of latestPaymentRows(paymentsRes.rows).rows) {
    const id = String(p.order_id);
    const list = paymentsByOrder.get(id) || [];
    list.push(p);
    paymentsByOrder.set(id, list);
  }

  const productsByOrder = new Map<string, any[]>();
  for (const p of productsRes.rows) {
    const id = String(p.order_id);
    const list = productsByOrder.get(id) || [];
    list.push(p);
    productsByOrder.set(id, list);
  }

  const rows: DetailTransactionRow[] = [];

  for (const o of reportOrders) {
    const orderId = String(o.order_id);
    const orderCode = String(o.order_code || "");
    const totalAmount = parseFloat(o.total_amount) || 0;
    const productDiscount = parseFloat(o.product_discount) || 0;
    const orderDiscount = parseFloat(o.order_discount) || 0;

    let raw = o.raw_json;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = {}; } }
    raw = raw || {};
    const surcharge = parseFloat(raw.surcharge_fee) || 0;
    const tax = parseFloat(raw.tax) || 0;

    const createdDate = parsePisellCreatedAtDate(o.created_at);

    // Build payment lines, sorted by payment_at
    const payments = (paymentsByOrder.get(orderId) || []).slice().sort((a, b) => {
      const ta = parsePisellCreatedAtDate(a.payment_at)?.getTime() ?? 0;
      const tb = parsePisellCreatedAtDate(b.payment_at)?.getTime() ?? 0;
      return ta - tb;
    });

    const payLines: string[] = [];
    let sumPay = 0;
    let sumRefund = 0;
    let voucherGiftTotal = 0;
    let latestPaymentDate: Date | null = null;

    for (const p of payments) {
      const payAmount = parseFloat(p.pay_amount) || 0;
      const refundAmount = parseFloat(p.refund_amount) || 0;
      const method = String(p.pay_method || "").trim() || "Unknown";
      sumPay += payAmount;
      sumRefund += refundAmount;
      if (/voucher/i.test(method)) voucherGiftTotal += payAmount;

      const payDate = parsePisellCreatedAtDate(p.payment_at);
      if (payDate && (!latestPaymentDate || payDate > latestPaymentDate)) {
        latestPaymentDate = payDate;
      }

      const timeLabel = payDate ? formatPayDetailTime(payDate) : "";
      const status = String(raw.payment_status || o.payment_status || "").trim();
      payLines.push(
        `${timeLabel} @ Terminal @ ${method} @ $${payAmount.toFixed(2)}${status ? " " + status : ""}`,
      );
    }

    const receiptDate = latestPaymentDate || createdDate;
    const suffix = numericSuffix(orderCode);
    const receiptNumber = receiptDate && suffix ? `${formatYyyymmdd(receiptDate)}${suffix}` : "";

    const products = productsByOrder.get(orderId) || [];
    const productLines: string[] = [];
    for (const pr of products) {
      let prRaw = pr.raw_json;
      if (typeof prRaw === "string") { try { prRaw = JSON.parse(prRaw); } catch { prRaw = {}; } }
      prRaw = prRaw || {};
      const name = String(pr.product_name || prRaw.product_title || prRaw.name || "Unknown");
      const qty = parseInt(pr.quantity) || parseInt(prRaw.product_quantity) || 1;
      const original =
        parseFloat(prRaw.original_price) ||
        parseFloat(prRaw.payment_price) ||
        parseFloat(pr.subtotal) || 0;
      productLines.push(`${name} * ${qty} @ $${original.toFixed(2)}`);
    }

    const dueAmount = Math.max(0, Math.round((totalAmount - sumPay) * 100) / 100);
    const netPayment = Math.round((sumPay - sumRefund - voucherGiftTotal) * 100) / 100;
    const discount = Math.round((productDiscount + orderDiscount) * 100) / 100;

    rows.push({
      unique_order_id: orderId,
      order_number: orderCode,
      receipt_number: receiptNumber,
      created_time: createdDate ? formatCreatedTime(createdDate) : (o.created_at || ""),
      sorting_time: createdDate ? Math.round(dateToExcelSerial(createdDate) * 100000) / 100000 : null,
      pay_details: payLines.join("\n"),
      total_price: totalAmount,
      service_charge: surcharge,
      vat: tax,
      deposit: "",
      discount,
      voucher_gift_total: Math.round(voucherGiftTotal * 100) / 100,
      due_amount: dueAmount,
      refund_amount: Math.round(sumRefund * 100) / 100,
      net_payment: netPayment,
      product_list: productLines.join("\n"),
    });
  }

  // Sort ascending by created_at (parsed) to match the sample PDF.
  rows.sort((a, b) => (a.sorting_time ?? 0) - (b.sorting_time ?? 0));

  return rows;
}

export async function buildDetailTransactionWorkbookBuffer(
  fromDate: string,
  toDate: string,
): Promise<Buffer> {
  const XLSX = await import("xlsx");
  const rows = await buildDetailTransactionRows(fromDate, toDate);

  const headers = [
    "unique_order_id",
    "order_number",
    "Receipt Number",
    "created_time",
    "sorting_time",
    "pay_details",
    "total_price (Inc SC+VAT)",
    "Service Charge",
    "VAT",
    "Deposit",
    "discount",
    "voucher_gift_total",
    "due_amount",
    "refund_amount",
    "Net Payment",
    "product_list",
  ];

  const aoa: any[][] = [headers];
  for (const r of rows) {
    aoa.push([
      r.unique_order_id,
      r.order_number,
      r.receipt_number,
      r.created_time,
      r.sorting_time,
      r.pay_details,
      r.total_price,
      r.service_charge,
      r.vat,
      r.deposit,
      r.discount,
      r.voucher_gift_total,
      r.due_amount,
      r.refund_amount,
      r.net_payment,
      r.product_list,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Format numeric columns to 2 decimals and apply wrapText alignment to
  // multi-line cells. (sheetjs CE writes the `s` property even though it
  // ignores most styles on read; xlsx-aware viewers honor wrapText.)
  const numericCols = [6, 7, 8, 10, 11, 12, 13, 14]; // total..netPayment
  for (let i = 0; i < rows.length; i++) {
    const r = i + 1; // header at row 0
    for (const c of numericCols) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = (ws as any)[addr];
      if (cell && typeof cell.v === "number") {
        cell.t = "n";
        cell.z = "0.00";
      }
    }
    // sorting_time numeric
    const sortAddr = XLSX.utils.encode_cell({ r, c: 4 });
    const sortCell = (ws as any)[sortAddr];
    if (sortCell && typeof sortCell.v === "number") {
      sortCell.t = "n";
      sortCell.z = "0.00000";
    }
    // wrap text on pay_details (5) and product_list (15)
    for (const c of [5, 15]) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = (ws as any)[addr];
      if (cell) {
        cell.s = { alignment: { wrapText: true, vertical: "top" } };
      }
    }
  }

  // Column widths approximating the sample layout.
  (ws as any)["!cols"] = [
    { wch: 14 }, // unique_order_id
    { wch: 12 }, // order_number
    { wch: 14 }, // Receipt Number
    { wch: 22 }, // created_time
    { wch: 14 }, // sorting_time
    { wch: 60 }, // pay_details
    { wch: 18 }, // total_price
    { wch: 12 }, // Service Charge
    { wch: 10 }, // VAT
    { wch: 10 }, // Deposit
    { wch: 12 }, // discount
    { wch: 14 }, // voucher_gift_total
    { wch: 12 }, // due_amount
    { wch: 12 }, // refund_amount
    { wch: 14 }, // Net Payment
    { wch: 80 }, // product_list
  ];

  // Row heights based on max line count between pay_details and product_list.
  const rowHeights: any[] = [{ hpt: 22 }];
  for (const r of rows) {
    const lines = Math.max(
      r.pay_details ? r.pay_details.split("\n").length : 1,
      r.product_list ? r.product_list.split("\n").length : 1,
      1,
    );
    rowHeights.push({ hpt: Math.min(15 * lines + 4, 360) });
  }
  (ws as any)["!rows"] = rowHeights;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Detail Transactions");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true });
  return buf as Buffer;
}

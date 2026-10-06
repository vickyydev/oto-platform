/**
 * A TRADING DAY OF SALES, ACROSS EVERY TENDER (S2-10a, SCRUM-206).
 *
 * WHAT IT IS FOR. `pnpm db:seed` builds a park: two branches, a catalogue, a
 * roster, members, two card terminals. It builds no money. Every screen that
 * reads the ledger — History, the Sale detail's Attempts list, the Failures
 * page, S2-15a's cash-up, Radar — therefore opens empty on a fresh checkout
 * and on staging after a demo reset, and the only way anybody has ever seen
 * one with data in it is by ringing sales up by hand. `SPRINT_2_PLAN.md:1596`
 * said S2-09a would start this file and `SPRINT_2_PROGRESS.md:1504` still
 * lists it as missing; this is it.
 *
 * WHAT IT WRITES. Eleven sales at Demo Branch 2's Reception Till 1, one
 * trading day: cash (including a split), card on both terminals, QR, one
 * stored-value spend, a redeemed discount voucher and a partial cash refund.
 * The unresolved attempts remain. Beside them, once, the two frozen legacy
 * days (`legacy-fixtures.ts`, S2-15b round 6) that stand in for the Pisell and
 * Papaya history. The two terminals stand for the park's EDC 1
 * (NEXGO N5, `ghl_linkpos`) and EDC 3 (PAX A920Pro, `digio_tlv`) from
 * `DEVICE_INVENTORY.md:38-41`, each attempt carrying a clearly marked fixture
 * TID, so a demo of the Attempts list and End of Day shows two terminals and
 * not one.
 *
 * WHY THE UNHAPPY ROWS ARE THE POINT. A day of nine approvals proves nothing
 * about this ticket: the whole design of `payment_attempt` is that a terminal
 * can answer nothing, an inquiry can be impossible, and a QR can be paid after
 * the till gave up. Those rows exist here so the states are on somebody's
 * screen before a guest is standing at the counter in one of them.
 *
 * IDEMPOTENT, PER SALE. Existing sale ids derive from their scenario keys, the
 * business date and the branch (`demoDayRef`). The voucher sale also names its
 * receipt generation because a demo reset retains voucher history. A rerun
 * finds each action at the branch's till and writes nothing. That is per sale
 * rather than per run on
 * purpose — S2-10b, S2-13 and S2-15a are all expected to add scenarios to the
 * list below, and adding one has to write that one on the next run without
 * rewriting the sales already in the ledger.
 *
 * The added scenarios are checked as an End of Day fixture on an isolated test
 * date. The physical PAX TID is not configured in the seed, so only new demo
 * attempts carry a clearly marked fixture TID; no device setting is changed.
 *
 * WHERE IT WRITES (S2-15b round 3, plan docs/progress/plans/analytics/PLAN.md
 * §4, §9 question 12, hazard H11). Into "Demo Branch 2" and nowhere else —
 * never a live park. Until round 3 this wrote the day into Central Floresta,
 * so every press of the staging control put invented sales into the park's
 * own Today > Performance, End of Day and Radar figures. Demo Branch 2 is made
 * here, on first use, as a place that can trade: the park's tax rule and
 * ticket packages copied from Central Floresta and a till numbering its own
 * `D2` series. A request naming any other branch is refused before anything
 * is written.
 */
import { randomBytes } from 'node:crypto';
import {
  businessDate as businessDateOf,
  computeTaxBreakdown,
  newId,
  parseDayStart,
  PRICING_ENGINE_VERSION,
  satangFromBaht,
  type TaxBreakdown,
  type TaxCategoryInput,
  type TaxConfigShape,
} from '@oto/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { closeDb, getDb, type Db } from '../index';
import * as s from '../schema/index';
import { seedLegacyFixtureDays } from './legacy-fixtures';
import { stableId } from './stable-id';

const b = satangFromBaht;
type SeedWriter = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The demo branch's till, numbering its own receipt series. */
const STATION_NAME = 'Reception Till 1';
/**
 * `D2`, distinct across the operator: the prefix IS the receipt series name
 * (`allocateReceiptNumber`), so a demo receipt can never read like a park's.
 */
const STATION_PREFIX = 'D2';

/** The branch demo sales are written to — the only one. */
export const DEMO_BRANCH_CODE = 'demo-branch-2';
export const DEMO_BRANCH_NAME = 'Demo Branch 2';
/** Every branch a demo day may be written to. A live park is never on this list. */
export const DEMO_BRANCH_CODES: readonly string[] = [DEMO_BRANCH_CODE];

/**
 * The park the demo branch copies its tax rule and ticket packages from, and
 * whose operator it belongs to. Found by code: the slug is load-bearing and
 * stays put when the name is edited (seed/index.ts, the rename note).
 */
const TEMPLATE_BRANCH_CODE = 'hkt-central';

/** The TID a demo card attempt carries when its terminal has none configured. */
const DEMO_FIXTURE_TIDS: Record<'edc1' | 'edc3', string> = { edc1: 'DEMONEX1', edc3: 'DEMOPAX1' };

/** The ticket package a demo ticket line was sold under, by its duration label. */
const PACKAGE_FOR_DURATION: Record<string, string> = {
  '1 Hour': '1 Hour Play',
  '2 Hours': '2 Hours Play',
  'Full Day': 'Full Day Pass',
};

/**
 * A deterministic UUIDv7 per scenario key (`stable-id.ts`): a second run is a
 * no-op rather than a second trading day. Exported so a test can plant the
 * rows the demo control left at a live park before round 3, under the keys it
 * used then.
 */
export { stableId };

/** One unit on the receipt, priced before tax. The engine's job in the real path; here, a figure. */
interface DemoLine {
  kind: (typeof s.SALE_LINE_KINDS)[number];
  label: string;
  taxableCategory: string;
  quantity: number;
  /** Per unit, before discount, in satang. */
  unitSatang: number;
  kidCount?: number;
  adultCount?: number;
  freeAdultCount?: number;
  stayHours?: number;
  stayDurationLabel?: string;
}

/** One tender on the sale. Several of these is a split. */
interface DemoTender {
  method: (typeof s.PAYMENT_METHODS)[number];
  /** The configured tender's `code` — what the till sent. */
  methodCode: string;
  provider: (typeof s.PAYMENT_PROVIDERS)[number];
  status: (typeof s.PAYMENT_ATTEMPT_STATUSES)[number];
  /** Share of the gross. Omitted on the last tender, which takes the remainder. */
  amountSatang?: number;
  tenderedSatang?: number;
  /** `edc1` is the NEXGO on `ghl_linkpos`; `edc3` is the PAX on `digio_tlv`. */
  terminal?: 'edc1' | 'edc3';
  terminalRef?: string;
  approvalCode?: string;
  last4?: string;
  invoiceSeq?: number;
  tranRef?: string;
  /** Minutes after the sale was rung up that this tender was answered. */
  paidAfterMin?: number;
  /** A gateway notification arrived for this tender, and this is its `respCode`. */
  notifiedRespCode?: string;
  note?: string;
}

interface DemoSale {
  /** Stable, and it is what makes the run idempotent. Never renumber one. */
  key: string;
  /** Minutes after the branch's day start. The park trades 10:00-20:00. */
  atMinutes: number;
  /** Which of the seeded members bought it, by nickname. Absent = a walk-in. */
  memberNickname?: string;
  tier: 'tourist' | 'expat' | 'thai';
  lines: DemoLine[];
  /** Staff discount off the whole order, in satang. */
  discountSatang?: number;
  /** A real, seeded discount definition applied to this sale, not a tender. */
  voucherDefinitionCode?: string;
  tenders: DemoTender[];
  /** What the day looks like on the Sale list. `tendering` is a sale still owed money. */
  status: 'finalised' | 'tendering';
  note?: string;
}

const HOUR = 60;

/**
 * THE DAY. Read it top to bottom and it is a shift: a quiet morning of cash and
 * card, a busy lunch, a QR that had to be inquired for, and two rows nobody
 * wants but everybody meets.
 *
 * Later slices extend this array. They do not renumber it: `key` is half of
 * every row's primary key, so changing one orphans a sale on every database
 * this has already run against.
 */
const DAY: DemoSale[] = [
  {
    key: 'open-cash',
    atMinutes: 5 * HOUR, // 10:00
    tier: 'tourist',
    lines: [
      {
        kind: 'kids',
        label: '2 Hours Play — Kids',
        taxableCategory: 'tickets',
        quantity: 2,
        unitSatang: b(450),
        kidCount: 2,
        adultCount: 1,
        freeAdultCount: 1,
        stayHours: 2,
        stayDurationLabel: '2 Hours',
      },
    ],
    tenders: [{ method: 'cash', methodCode: 'cash', provider: 'manual', status: 'approved', tenderedSatang: b(1000) }],
    status: 'finalised',
  },
  {
    key: 'card-nexgo',
    atMinutes: 5 * HOUR + 40,
    memberNickname: 'Ploy',
    tier: 'thai',
    lines: [
      {
        kind: 'kids',
        label: '2 Hours Play — Kids',
        taxableCategory: 'tickets',
        quantity: 1,
        unitSatang: b(390),
        kidCount: 1,
        adultCount: 1,
        freeAdultCount: 1,
        stayHours: 2,
        stayDurationLabel: '2 Hours',
      },
      { kind: 'socks', label: 'Regular Socks', taxableCategory: 'addons', quantity: 1, unitSatang: b(80) },
    ],
    tenders: [
      {
        method: 'card',
        methodCode: 'card',
        provider: 'ghl',
        status: 'approved',
        terminal: 'edc1',
        terminalRef: 'T01260001AB',
        approvalCode: '481203',
        last4: '4412',
        paidAfterMin: 1,
      },
    ],
    status: 'finalised',
  },
  {
    key: 'qr-gateway',
    atMinutes: 6 * HOUR + 15,
    tier: 'tourist',
    lines: [
      {
        kind: 'kids',
        label: 'Full Day Play — Kids',
        taxableCategory: 'tickets',
        quantity: 2,
        unitSatang: b(690),
        kidCount: 2,
        adultCount: 2,
        freeAdultCount: 2,
        stayHours: 8,
        stayDurationLabel: 'Full Day',
      },
    ],
    tenders: [
      {
        method: 'qr',
        methodCode: 'promptpay',
        provider: '2c2p',
        status: 'approved',
        invoiceSeq: 1,
        tranRef: 'TR2609200001',
        paidAfterMin: 2,
        notifiedRespCode: '0000',
      },
    ],
    status: 'finalised',
  },
  {
    key: 'card-declined-then-cash',
    atMinutes: 7 * HOUR,
    tier: 'tourist',
    lines: [
      {
        kind: 'kids',
        label: '2 Hours Play — Kids',
        taxableCategory: 'tickets',
        quantity: 1,
        unitSatang: b(450),
        kidCount: 1,
        adultCount: 1,
        freeAdultCount: 1,
        stayHours: 2,
        stayDurationLabel: '2 Hours',
      },
    ],
    tenders: [
      {
        // The declined attempt stays on the ledger. A card that was refused is
        // a fact about the guest's afternoon, and a table that only kept the
        // approval cannot answer "why did this take three minutes".
        method: 'card',
        methodCode: 'card',
        provider: 'ghl',
        status: 'declined',
        amountSatang: b(450),
        terminal: 'edc1',
        terminalRef: 'T01260002CD',
        paidAfterMin: 1,
        note: 'do_not_honor',
      },
      { method: 'cash', methodCode: 'cash', provider: 'manual', status: 'approved', tenderedSatang: b(500) },
    ],
    status: 'finalised',
  },
  {
    key: 'split-cash-card',
    atMinutes: 7 * HOUR + 50,
    memberNickname: 'Nok',
    tier: 'expat',
    lines: [
      {
        kind: 'kids',
        label: 'Full Day Play — Kids',
        taxableCategory: 'tickets',
        quantity: 3,
        unitSatang: b(552),
        kidCount: 3,
        adultCount: 2,
        freeAdultCount: 2,
        stayHours: 8,
        stayDurationLabel: 'Full Day',
      },
      { kind: 'socks', label: 'Regular Socks', taxableCategory: 'addons', quantity: 3, unitSatang: b(80) },
    ],
    discountSatang: b(100),
    tenders: [
      // The split this ticket exists to allow: two approved attempts on one
      // sale, which the finalise path refused before S2-10a.
      { method: 'cash', methodCode: 'cash', provider: 'manual', status: 'approved', amountSatang: b(1000), tenderedSatang: b(1000) },
      {
        method: 'card',
        methodCode: 'card',
        provider: 'digio',
        status: 'approved',
        terminal: 'edc3',
        terminalRef: '000118',
        approvalCode: '902117',
        last4: '8830',
        paidAfterMin: 2,
      },
    ],
    status: 'finalised',
  },
  {
    key: 'card-pax',
    atMinutes: 8 * HOUR + 30,
    tier: 'tourist',
    lines: [
      {
        kind: 'kids',
        label: '2 Hours Play — Kids',
        taxableCategory: 'tickets',
        quantity: 2,
        unitSatang: b(450),
        kidCount: 2,
        adultCount: 3,
        freeAdultCount: 2,
        stayHours: 2,
        stayDurationLabel: '2 Hours',
      },
      { kind: 'adults_paid', label: 'Adult Admission', taxableCategory: 'tickets', quantity: 1, unitSatang: b(350), adultCount: 1 },
    ],
    tenders: [
      {
        method: 'card',
        methodCode: 'card',
        provider: 'digio',
        status: 'approved',
        terminal: 'edc3',
        terminalRef: '000119',
        approvalCode: '774510',
        last4: '1199',
        paidAfterMin: 1,
      },
    ],
    status: 'finalised',
  },
  {
    key: 'merch-wallet',
    atMinutes: 8 * HOUR + 40,
    tier: 'tourist',
    lines: [{ kind: 'socks', label: 'Regular Socks', taxableCategory: 'addons', quantity: 1, unitSatang: b(80) }],
    tenders: [{ method: 'wallet', methodCode: 'wallet_credit', provider: 'manual', status: 'approved' }],
    status: 'finalised',
    note: 'Paid from credit granted on the earlier paid-adult ticket.',
  },
  {
    key: 'voucher-discount',
    atMinutes: 8 * HOUR + 55,
    tier: 'tourist',
    lines: [{ kind: 'kids', label: '2 Hours Play — Kids', taxableCategory: 'tickets', quantity: 1,
      unitSatang: b(450), kidCount: 1, adultCount: 1, freeAdultCount: 1,
      stayHours: 2, stayDurationLabel: '2 Hours' }],
    discountSatang: b(100),
    voucherDefinitionCode: 'spin-voucher-100',
    tenders: [{ method: 'cash', methodCode: 'cash', provider: 'manual', status: 'approved' }],
    status: 'finalised',
  },
  {
    key: 'card-staff-confirmed',
    atMinutes: 9 * HOUR + 10,
    tier: 'tourist',
    lines: [
      {
        kind: 'kids',
        label: '2 Hours Play — Kids',
        taxableCategory: 'tickets',
        quantity: 1,
        unitSatang: b(450),
        kidCount: 1,
        adultCount: 1,
        freeAdultCount: 1,
        stayHours: 2,
        stayDurationLabel: '2 Hours',
      },
    ],
    tenders: [
      {
        // The NEXGO answered nothing and its dialect has no card QUERY, so the
        // only answer available was a person reading the terminal's own screen.
        // `staff_confirmed_by` carries who, and an audit row is written beside
        // it by the service that does this for real (Slice C2).
        method: 'card',
        methodCode: 'card',
        provider: 'ghl',
        status: 'approved',
        terminal: 'edc1',
        terminalRef: 'T01260003EF',
        approvalCode: '556201',
        last4: '0027',
        paidAfterMin: 4,
        note: 'staff_confirmed',
      },
    ],
    status: 'finalised',
  },
  {
    key: 'qr-unresolved',
    atMinutes: 9 * HOUR + 45,
    tier: 'tourist',
    lines: [
      {
        kind: 'kids',
        label: '2 Hours Play — Kids',
        taxableCategory: 'tickets',
        quantity: 1,
        unitSatang: b(450),
        kidCount: 1,
        adultCount: 1,
        freeAdultCount: 1,
        stayHours: 2,
        stayDurationLabel: '2 Hours',
      },
    ],
    tenders: [
      {
        // A QR shown and never paid, on a sale still owed money. This is the
        // row `job:payments.pending` flags on Failures and the one S2-15a's
        // end of day has to have an answer for, so it is left exactly as the
        // day would leave it: no receipt number, and the sale still open.
        method: 'qr',
        methodCode: 'promptpay',
        provider: '2c2p',
        status: 'sent_to_terminal',
        invoiceSeq: 2,
      },
    ],
    status: 'tendering',
  },
  {
    key: 'qr-terminal-offline',
    atMinutes: 10 * HOUR,
    tier: 'tourist',
    lines: [
      {
        kind: 'kids',
        label: 'Full Day Play — Kids',
        taxableCategory: 'tickets',
        quantity: 1,
        unitSatang: b(690),
        kidCount: 1,
        adultCount: 1,
        freeAdultCount: 1,
        stayHours: 8,
        stayDurationLabel: 'Full Day',
      },
    ],
    tenders: [
      {
        // Taken on the PAX's own 4G while the box could not reach the cloud.
        // Real money — the guest's bank has moved it — but not yet matched to
        // a settlement file, which is the whole difference between
        // `awaiting_settlement` and `approved`.
        method: 'qr',
        methodCode: 'promptpay',
        provider: 'digio',
        status: 'awaiting_settlement',
        terminal: 'edc3',
        terminalRef: '000120',
        paidAfterMin: 1,
      },
    ],
    status: 'finalised',
    note: 'Taken on the terminal while the box was offline.',
  },
];

export interface DemoDayCounts {
  /** Where the day was written: always a demo branch. */
  branchName: string;
  branchCode: string;
  businessDate: string;
  sales: number;
  lines: number;
  attempts: number;
  notifications: number;
  /** Sales already in the ledger for this day, which the run left alone. */
  skipped: number;
  /**
   * The frozen legacy days (`legacy-fixtures.ts`, S2-15b round 6) this run
   * loaded at the demo branch: two the first time, none after.
   */
  legacyFixtureDays: number;
}

/** Refused before anything is written: demo sales never reach a live park. */
export class DemoBranchRefusedError extends Error {
  constructor(code: string) {
    super(`Demo sales are written to ${DEMO_BRANCH_NAME} only; "${code}" is not a demo branch.`);
    this.name = 'DemoBranchRefusedError';
  }
}

/**
 * Seed one trading day, into the demo branch.
 *
 * `on` is the business date to write, defaulting to the branch's own today —
 * so a demo has sales dated today, and a second run the same day writes
 * nothing. Naming an explicit date is how a later ticket fills a week.
 * `branchCode` may only name a demo branch (`DEMO_BRANCH_CODES`); anything
 * else, a live park above all, is refused with nothing written.
 */
export async function seedDemoDay(
  db: Db = getDb(),
  options: { on?: string; branchCode?: string } = {},
): Promise<DemoDayCounts> {
  const branchCode = options.branchCode ?? DEMO_BRANCH_CODE;
  if (!DEMO_BRANCH_CODES.includes(branchCode)) throw new DemoBranchRefusedError(branchCode);
  const branch = await ensureDemoBranch(db);
  const { id: branchId, operatorId, timezone } = branch;
  const dayStart = branch.businessDayStart;
  const branchName = branch.name;
  // The frozen legacy days live at the demo branch too (round 6): loaded once,
  // never rewritten by this or any later run.
  const legacyFixtureDays = await seedLegacyFixtureDays(db, branch);

  const [station] = await db
    .select({ id: s.station.id, codePrefix: s.station.codePrefix })
    .from(s.station)
    .where(and(eq(s.station.branchId, branchId), eq(s.station.name, STATION_NAME)))
    .limit(1);
  if (!station?.codePrefix) {
    throw new Error(`No station "${STATION_NAME}" with a code prefix at ${branchName}.`);
  }
  const stationCodePrefix = station.codePrefix;

  const [taxRow] = await db
    .select({ config: s.branchTaxConfig.config })
    .from(s.branchTaxConfig)
    .where(eq(s.branchTaxConfig.branchId, branchId))
    .limit(1);
  if (!taxRow) throw new Error(`No tax config for ${branchName}.`);
  const taxConfig = taxRow.config as TaxConfigShape;

  const packages = new Map<string, string>();
  for (const row of await db
    .select({ id: s.ticketPackage.id, name: s.ticketPackage.name })
    .from(s.ticketPackage)
    .where(eq(s.ticketPackage.branchId, branchId))) {
    packages.set(row.name, row.id);
  }
  /** The demo branch's own package a ticket line was sold under; null for a line that is not a stay. */
  const packageIdOf = (line: DemoLine): string | null => {
    const name = line.stayDurationLabel ? PACKAGE_FOR_DURATION[line.stayDurationLabel] : undefined;
    return name ? (packages.get(name) ?? null) : null;
  };

  // Whoever rings a sale up has to be a real account: `sale.created_by_account_id`
  // is NOT NULL precisely so an unattributable money row cannot exist.
  const [cashier] = await db
    .select({ id: s.account.id })
    .from(s.account)
    .innerJoin(s.employee, eq(s.employee.id, s.account.employeeId))
    .where(and(eq(s.account.operatorId, operatorId), eq(s.employee.name, 'Som (Reception)')))
    .limit(1);
  if (!cashier) throw new Error('No reception account to attribute the day to. Run `pnpm db:seed` first.');

  const terminals: Record<'edc1' | 'edc3', string | null> = { edc1: null, edc3: null };
  for (const [slot, label] of [
    ['edc1', 'EDC 1'],
    ['edc3', 'EDC 3'],
  ] as const) {
    const [row] = await db
      .select({ id: s.device.id })
      .from(s.device)
      .where(and(eq(s.device.branchId, branchId), eq(s.device.label, label)))
      .limit(1);
    terminals[slot] = row?.id ?? null;
  }

  const members = new Map<string, string>();
  for (const row of await db
    .select({ id: s.member.id, nickname: s.member.nickname })
    .from(s.member)
    .where(eq(s.member.operatorId, operatorId))) {
    if (row.nickname) members.set(row.nickname, row.id);
  }

  const dayStartMinutes = parseDayStart(dayStart);
  const on = options.on ?? businessDateOf(new Date(), timezone, dayStartMinutes);
  // The day's wall clock, as an instant. The offset is read from the zone at
  // that date rather than assumed, so this stays right if a branch is ever
  // opened somewhere with a different one.
  const midnightUtc = Date.parse(`${on}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(new Date(midnightUtc), timezone);
  const instantAt = (minutesIntoDay: number): Date =>
    new Date(midnightUtc + (dayStartMinutes + minutesIntoDay - offsetMin) * 60_000);

  const counts: DemoDayCounts = {
    branchName,
    branchCode,
    businessDate: on,
    sales: 0,
    lines: 0,
    attempts: 0,
    notifications: 0,
    skipped: 0,
    legacyFixtureDays,
  };
  const ref = demoDayRef(on, branchCode);

  for (const scenario of DAY) {
    await db.transaction(async (writer) => {
      const occurredAt = instantAt(scenario.atMinutes);
      const actionId = ref.action(scenario.key);
      await writer.execute(sql`select pg_advisory_xact_lock(hashtext(${operatorId}), hashtext(${actionId}))`);
      const baseSaleId = stableId(ref.key(scenario.key), occurredAt);

      // Already written HERE: at this branch's till, under this branch's key
      // or the one the demo branch's first days were written under. A row the
      // pre-round-3 control left at a live park on the same date is not this
      // branch's sale, and never stops this one being written.
      if (await demoSaleAt(writer, station.id, ref, scenario.key)) {
        counts.skipped += 1;
        return;
      }

      const money = priceScenario(scenario, taxConfig);

      // The receipt number comes out of the station's own series, bumped in the
      // same statement that reads it — the demo must not leave the high-water
      // mark behind the numbers it has printed, or the next real sale reuses one.
      let receipt: { series: string; seq: number; number: string } | null = null;
      if (scenario.status === 'finalised') {
        receipt = await allocateReceipt(writer, {
          operatorId,
          branchId,
          stationId: station.id,
          series: stationCodePrefix,
          at: occurredAt,
        });
      }
      // A demo reset keeps voucher redemption history. Give a new voucher sale
      // a new identity when its old sale was removed, while a normal rerun above
      // still finds this day's existing action and writes nothing.
      const saleId = scenario.voucherDefinitionCode
        ? stableId(`${ref.key(scenario.key)}/${receipt!.number}`, occurredAt)
        : baseSaleId;

      await writer.insert(s.sale).values({
        id: saleId,
        operatorId,
        branchId,
        stationId: station.id,
        businessDate: on,
        businessDayStart: dayStart,
        timezone,
        occurredAt,
        receivedAt: occurredAt,
        origin: 'cloud',
        salesChannel: 'till',
        actionId,
        createdByAccountId: cashier.id,
        memberId: scenario.memberNickname ? (members.get(scenario.memberNickname) ?? null) : null,
        pricingMode: 'weekday',
        pricingModeReason: 'Weekday pricing',
        customerTier: scenario.tier,
        engineVersion: PRICING_ENGINE_VERSION,
        taxConfig,
        taxBreakdown: money.breakdown,
        subtotalSatang: money.subtotal,
        manualDiscountSatang: scenario.voucherDefinitionCode ? 0 : money.discount,
        promoDiscountSatang: scenario.voucherDefinitionCode ? money.discount : 0,
        discountSatang: money.discount,
        netSatang: money.net,
        serviceChargeSatang: money.serviceCharge,
        taxInclusiveSatang: money.taxInclusive,
        taxExclusiveSatang: money.taxExclusive,
        grossSatang: money.gross,
        unappliedDiscountSatang: money.breakdown.unappliedDiscount,
        status: scenario.status,
        receiptSeries: receipt?.series ?? null,
        receiptSeq: receipt?.seq ?? null,
        receiptNumber: receipt?.number ?? null,
        finalisedAt: receipt ? occurredAt : null,
        note: scenario.note ?? null,
      });
      counts.sales += 1;

      let lineNo = 0;
      for (const line of money.lines) {
        lineNo += 1;
        await writer.insert(s.saleLine).values({
          id: newId(),
          saleId,
          operatorId,
          branchId,
          businessDate: on,
          lineNo,
          cartLineId: newId(),
          kind: line.kind,
          label: line.label,
          taxableCategory: line.taxableCategory,
          quantity: line.quantity,
          unitSatang: line.unitSatang,
          baseSatang: line.base,
          discountSatang: line.discount,
          netSatang: line.net,
          serviceChargeSatang: line.serviceCharge,
          taxSatang: line.tax,
          taxMode: line.taxMode,
          taxRateBp: line.taxRateBp,
          taxRateId: line.taxRateId ?? null,
          taxName: line.taxName ?? null,
          grossSatang: line.gross,
          customerTier: scenario.tier,
          kidCount: line.kidCount ?? 0,
          adultCount: line.adultCount ?? 0,
          freeAdultCount: line.freeAdultCount ?? 0,
          stayHours: line.stayHours ?? null,
          stayDurationLabel: line.stayDurationLabel ?? null,
          // The package the stay was sold under, so the day's ticket mix is
          // read from it as a real sale's would be.
          ticketPackageId: packageIdOf(line),
        });
        counts.lines += 1;
      }

      // What is left to cover once every tender before this one has taken its
      // share. The last tender takes the remainder, which is how a split adds up
      // to the gross exactly rather than to the gross plus a rounding.
      let outstanding = money.gross;
      for (const [i, tender] of scenario.tenders.entries()) {
        const takes = tender.status === 'approved' || tender.status === 'awaiting_settlement';
        const amount = tender.amountSatang ?? outstanding;
        if (takes) outstanding -= amount;

        const attemptAt = new Date(occurredAt.getTime() + i * 30_000);
        const attemptId = stableId(`${ref.key(scenario.key)}/tender/${i}`, attemptAt);
        const deviceId = tender.terminal ? terminals[tender.terminal] : null;
        const configuredTid = deviceId ? await terminalIdOf(writer, deviceId) : null;
        // A terminal with no configured TID — the demo branch has no devices at
        // all — gets an unmistakable demo TID, so the two-terminal End of Day
        // view can be tried without inventing a real device setting.
        const fixtureTid = tender.terminal && !configuredTid ? DEMO_FIXTURE_TIDS[tender.terminal] : null;
        const invoiceNo = tender.invoiceSeq
          ? `DEMO${stationCodePrefix.replace(/[^A-Z0-9]/g, '')}${on.slice(2).replace(/-/g, '')}${String(tender.invoiceSeq).padStart(4, '0')}`
          : null;
        const paidAt =
          takes && tender.paidAfterMin !== undefined
            ? new Date(attemptAt.getTime() + tender.paidAfterMin * 60_000)
            : takes
              ? attemptAt
              : null;

        await writer.insert(s.paymentAttempt).values({
          id: attemptId,
          operatorId,
          branchId,
          saleId,
          stationId: station.id,
          deviceId,
          businessDate: on,
          method: tender.method,
          methodCode: tender.methodCode,
          provider: tender.provider,
          status: tender.status,
          amountSatang: amount,
          tenderedSatang: tender.tenderedSatang ?? null,
          changeSatang: tender.tenderedSatang !== undefined ? tender.tenderedSatang - amount : null,
          terminalRef: tender.terminalRef ?? null,
          // GHL's card wire carries neither TID nor MID, so they are read off the
          // device row — which is exactly what the real adapter does.
          tid: configuredTid ?? fixtureTid,
          mid: deviceId ? await merchantIdOf(writer, deviceId) : null,
          approvalCode: tender.approvalCode ?? null,
          last4: tender.last4 ?? null,
          invoiceNo,
          tranRef: tender.tranRef ?? null,
          qrPayload: null,
          expiresAt:
            tender.method === 'qr' && tender.provider === '2c2p'
              ? new Date(attemptAt.getTime() + 20 * 60_000)
              : null,
          paidAt,
          staffConfirmedByAccountId: tender.note === 'staff_confirmed' ? cashier.id : null,
          offline: scenario.key === 'qr-terminal-offline',
          actionId: `${actionId}/${i}`,
          payload: tender.note || fixtureTid ? { ...(tender.note ? { note: tender.note } : {}),
            ...(fixtureTid ? { fixtureTid: true } : {}) } : null,
          createdAt: attemptAt,
          updatedAt: paidAt ?? attemptAt,
        });
        counts.attempts += 1;

        if (tender.notifiedRespCode && invoiceNo) {
          await writer.insert(s.paymentNotification).values({
            id: newId(),
            operatorId,
            attemptId,
            invoiceNo,
            tranRef: tender.tranRef ?? null,
            paymentId: null,
            respCode: tender.notifiedRespCode,
            receivedAt: paidAt ?? attemptAt,
            raw: {
              invoiceNo,
              tranRef: tender.tranRef,
              respCode: tender.notifiedRespCode,
              amount: (amount / 100).toFixed(2),
              currencyCode: 'THB',
              note: 'Seeded by seed:demo-day — not a delivery from the gateway.',
            },
          });
          counts.notifications += 1;
        }
      }
      if (scenario.key === 'merch-wallet') {
        await seedDemoWalletSpend(writer, { on, ref, saleId, operatorId, branchId, stationId: station.id,
          occurredAt,
          sourceSaleId: (await demoSaleAt(writer, station.id, ref, 'card-pax'))
            ?? stableId(ref.key('card-pax'), instantAt(8 * HOUR + 30)),
          expiresAt: instantAt(24 * HOUR), spentSatang: money.gross });
      }
      if (scenario.voucherDefinitionCode) {
        await seedDemoVoucherDiscount(writer, { on, saleId, operatorId, branchId,
          stationId: station.id, accountId: cashier.id, occurredAt,
          definitionCode: scenario.voucherDefinitionCode, discountSatang: money.discount });
      }
    });
  }

  await seedDemoCashRefund(db, { ref, operatorId, branchId, stationId: station.id,
    series: stationCodePrefix, occurredAt: instantAt(10 * HOUR + 30), createdByAccountId: cashier.id });

  return counts;
}

export interface DemoBranch {
  id: string;
  name: string;
  operatorId: string;
  timezone: string;
  businessDayStart: string;
}

/**
 * DEMO BRANCH 2, MADE ONCE, AS A PLACE THAT CAN TRADE.
 *
 * Found by its code inside the park's operator, and made on first use: the
 * branch (the park's timezone, country and opening hours), the park's tax
 * rule and ticket packages copied from Central Floresta, and a Reception Till
 * 1 numbering the `D2` series. No box and no device: its card attempts carry
 * clearly marked fixture TIDs instead (`DEMO_FIXTURE_TIDS`).
 *
 * Everything is find-or-create, under one lock per operator, so two presses
 * at once make one branch and a branch somebody has since edited stays as
 * they left it.
 */
export async function ensureDemoBranch(db: Db): Promise<DemoBranch> {
  const [operator] = await db.select({ id: s.operator.id }).from(s.operator).where(eq(s.operator.name, 'OTO')).limit(1);
  const [template] = operator
    ? await db
        .select({
          id: s.branch.id,
          timezone: s.branch.timezone,
          country: s.branch.country,
          openingHours: s.branch.openingHours,
        })
        .from(s.branch)
        .where(and(eq(s.branch.operatorId, operator.id), eq(s.branch.code, TEMPLATE_BRANCH_CODE)))
        .limit(1)
    : [];
  if (!operator || !template) {
    throw new Error('No park to model the demo branch on. Run `pnpm db:seed` first — this seeds on top of it.');
  }
  const operatorId = operator.id;

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${operatorId}), hashtext('demo-day/branch'))`);
    const pick = {
      id: s.branch.id,
      name: s.branch.name,
      operatorId: s.branch.operatorId,
      timezone: s.branch.timezone,
      businessDayStart: s.branch.businessDayStart,
    };
    const where = and(eq(s.branch.operatorId, operatorId), eq(s.branch.code, DEMO_BRANCH_CODE));
    let [found] = await tx.select(pick).from(s.branch).where(where).limit(1);
    if (!found) {
      await tx.insert(s.branch).values({
        id: newId(),
        operatorId,
        name: DEMO_BRANCH_NAME,
        code: DEMO_BRANCH_CODE,
        timezone: template.timezone,
        country: template.country,
        openingHours: template.openingHours,
      });
      [found] = await tx.select(pick).from(s.branch).where(where).limit(1);
    }
    const branch = found!;

    // The park's tax rule: a branch without one cannot total a sale.
    const [taxRow] = await tx
      .select({ config: s.branchTaxConfig.config })
      .from(s.branchTaxConfig)
      .where(eq(s.branchTaxConfig.branchId, template.id))
      .limit(1);
    if (taxRow) {
      await tx
        .insert(s.branchTaxConfig)
        .values({ id: newId(), branchId: branch.id, config: taxRow.config })
        .onConflictDoNothing({ target: s.branchTaxConfig.branchId });
    }

    // The park's ticket packages, under the demo branch's own ids.
    for (const pkg of await tx.select().from(s.ticketPackage).where(eq(s.ticketPackage.branchId, template.id))) {
      const { id: _id, branchId: _branchId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = pkg;
      await tx
        .insert(s.ticketPackage)
        .values({ ...rest, id: newId(), branchId: branch.id })
        .onConflictDoNothing({ target: [s.ticketPackage.branchId, s.ticketPackage.name] });
    }

    // A till and nothing on a wall: no box and no device, so the demo branch
    // never appears in Health's fleet as a box waiting to be claimed.
    const [till] = await tx
      .select({ id: s.station.id })
      .from(s.station)
      .where(and(eq(s.station.branchId, branch.id), eq(s.station.name, STATION_NAME)))
      .limit(1);
    if (!till) {
      await tx.insert(s.station).values({
        id: newId(),
        operatorId,
        branchId: branch.id,
        name: STATION_NAME,
        kind: 'till',
        codePrefix: STATION_PREFIX,
        capabilities: ['tickets', 'fnb'],
        accessScope: 'all_staff',
      });
    }
    return branch;
  });
}

/**
 * THE KEYS OF ONE DEMO DAY AT ONE BRANCH (S2-15b round 3 fix). Every derived
 * id and every action id names the branch as well as the date: before round 3
 * the control wrote the same date's scenarios at Central Floresta under
 * `demo-day/<date>/<scenario>` and ids hashed from `<date>/<scenario>`, and a
 * press at Demo Branch 2 on such a date found those rows, skipped all eleven
 * and reported "11 already present" at Demo Branch 2. The ids and action ids
 * here can no longer meet the park's, and `legacyAction` is the shape the
 * demo branch's own first days used, so a rerun still finds them.
 */
interface DemoDayRef {
  /** The input to `stableId` for a scenario's rows. */
  key: (scenario: string) => string;
  /** A scenario's sale action id; its tenders, grant and refund extend it. */
  action: (scenario: string) => string;
  /** The un-namespaced action id the demo branch's first days used. */
  legacyAction: (scenario: string) => string;
}

function demoDayRef(on: string, branchCode: string): DemoDayRef {
  return {
    key: (scenario) => `${branchCode}/${on}/${scenario}`,
    action: (scenario) => `demo-day/${on}/${branchCode}/${scenario}`,
    legacyAction: (scenario) => `demo-day/${on}/${scenario}`,
  };
}

/** The id of a scenario's sale already written at this till (under either key), or null. */
async function demoSaleAt(writer: SeedWriter, stationId: string, ref: DemoDayRef, scenario: string): Promise<string | null> {
  const [found] = await writer
    .select({ id: s.sale.id })
    .from(s.sale)
    .where(and(eq(s.sale.stationId, stationId), inArray(s.sale.actionId, [ref.action(scenario), ref.legacyAction(scenario)])))
    .limit(1);
  return found?.id ?? null;
}

async function seedDemoWalletSpend(writer: SeedWriter, input: {
  on: string; ref: DemoDayRef; saleId: string; sourceSaleId: string; operatorId: string; branchId: string;
  stationId: string; occurredAt: Date; expiresAt: Date; spentSatang: number;
}): Promise<void> {
  // The earlier card-pax sale has one paid adult ticket at the list price of
  // THB 350. The seeded adult full-price credit is spent on this socks sale.
  const grantSatang = b(350);
  if (input.spentSatang > grantSatang) throw new Error('Demo wallet spend exceeds its grant');
  const walletId = stableId(`${input.ref.key('card-pax')}/wallet`, input.occurredAt);
  // The merch-wallet sale's first tender, as the scenario loop wrote it.
  const attemptId = stableId(`${input.ref.key('merch-wallet')}/tender/0`, input.occurredAt);
  await writer.insert(s.wallet).values({ id: walletId, operatorId: input.operatorId,
    branchId: input.branchId, holderName: 'Demo admission credit',
    balanceSatang: grantSatang - input.spentSatang });
  await writer.insert(s.walletKey).values({ id: stableId(`${walletId}/key`, input.occurredAt),
    operatorId: input.operatorId, walletId, kind: 'voucher_qr', value: `QR-${walletId}` });
  await writer.insert(s.walletEntry).values([
    { id: stableId(`${walletId}/grant`, input.occurredAt), walletId, operatorId: input.operatorId,
      actionId: `${input.ref.action('card-pax')}/wallet-grant`, amountSatang: grantSatang,
      kind: 'grant', source: 'ticket_sale', saleId: input.sourceSaleId, branchId: input.branchId,
      stationId: input.stationId, businessDate: input.on, expiresAt: input.expiresAt,
      balanceAfter: grantSatang, createdAt: new Date(input.occurredAt.getTime() - 10 * 60_000) },
    { id: stableId(`${walletId}/spend`, input.occurredAt), walletId, operatorId: input.operatorId,
      actionId: `wallet:spend:${attemptId}`, amountSatang: -input.spentSatang,
      kind: 'spend', source: 'merch_order', saleId: input.saleId, paymentAttemptId: attemptId,
      branchId: input.branchId, stationId: input.stationId, businessDate: input.on,
      balanceAfter: grantSatang - input.spentSatang, createdAt: input.occurredAt },
  ]);
}

async function seedDemoVoucherDiscount(writer: SeedWriter, input: {
  on: string; saleId: string; operatorId: string; branchId: string; stationId: string;
  accountId: string; occurredAt: Date; definitionCode: string; discountSatang: number;
}): Promise<void> {
  const [definition] = await writer.select({ id: s.voucherDefinition.id, name: s.voucherDefinition.nameEn,
    kind: s.voucherDefinition.kind, valueSatang: s.voucherDefinition.valueSatang,
    costSatang: s.voucherDefinition.costSatang, expiryDays: s.voucherDefinition.expiryDays })
    .from(s.voucherDefinition).where(and(eq(s.voucherDefinition.operatorId, input.operatorId),
      eq(s.voucherDefinition.code, input.definitionCode))).limit(1);
  if (!definition || definition.kind !== 'discount' || definition.valueSatang !== input.discountSatang) {
    throw new Error('The seeded demo discount voucher definition is missing or has changed');
  }
  const voucherId = stableId(`${input.saleId}/voucher`, input.occurredAt);
  const code = `DEMO${randomBytes(10).toString('hex').toUpperCase()}`;
  await writer.insert(s.voucher).values({ id: voucherId, operatorId: input.operatorId,
    branchId: input.branchId, voucherDefinitionId: definition.id, code, source: 'manual',
    status: 'redeemed', costSatang: definition.costSatang, issuedByAccountId: input.accountId,
    issuedAt: input.occurredAt,
    expiresAt: definition.expiryDays ? new Date(input.occurredAt.getTime() + definition.expiryDays * 86_400_000) : null,
    redeemedAt: input.occurredAt, redeemedByAccountId: input.accountId,
    redeemedBranchId: input.branchId, redeemedStationId: input.stationId, saleId: input.saleId });
  await writer.insert(s.voucherRedemption).values(['applied', 'consumed'].map((kind) => ({
    id: stableId(`${voucherId}/${kind}`, input.occurredAt), operatorId: input.operatorId,
    voucherId, kind: kind as 'applied' | 'consumed', saleId: input.saleId,
    branchId: input.branchId, stationId: input.stationId, accountId: input.accountId,
    occurredAt: input.occurredAt,
  })));
  await writer.insert(s.saleDiscount).values({ id: stableId(`${input.saleId}/discount`, input.occurredAt),
    saleId: input.saleId, operatorId: input.operatorId, branchId: input.branchId,
    businessDate: input.on, sequence: 1, kind: 'promo', discountType: 'fixed',
    valueSatang: input.discountSatang, amountSatang: input.discountSatang,
    scope: 'order', code, label: definition.name, appliedByAccountId: input.accountId,
    appliedAt: input.occurredAt });
}

async function seedDemoCashRefund(db: Db, input: {
  ref: DemoDayRef; operatorId: string; branchId: string; stationId: string; series: string;
  occurredAt: Date; createdByAccountId: string;
}): Promise<void> {
  await db.transaction(async (writer) => {
    const actionId = `${input.ref.action('open-cash')}/refund`;
    await writer.execute(sql`select pg_advisory_xact_lock(hashtext(${input.operatorId}), hashtext(${actionId}))`);
    // Already refunded HERE, under either key: a live park's refund of the
    // same date is not this branch's.
    const [prior] = await writer.select({ id: s.refund.id }).from(s.refund)
      .where(and(eq(s.refund.operatorId, input.operatorId), eq(s.refund.branchId, input.branchId),
        inArray(s.refund.actionId, [actionId, `${input.ref.legacyAction('open-cash')}/refund`]))).limit(1);
    if (prior) return;
    const sourceSaleId = await demoSaleAt(writer, input.stationId, input.ref, 'open-cash');
    const [sale] = sourceSaleId
      ? await writer.select({ id: s.sale.id }).from(s.sale)
          .where(and(eq(s.sale.id, sourceSaleId), eq(s.sale.branchId, input.branchId))).limit(1)
      : [];
    const [cashAttempt] = sourceSaleId
      ? await writer.select({ id: s.paymentAttempt.id }).from(s.paymentAttempt)
          .where(and(eq(s.paymentAttempt.saleId, sourceSaleId), eq(s.paymentAttempt.method, 'cash'),
            eq(s.paymentAttempt.status, 'approved'))).limit(1)
      : [];
    const [manager] = await writer.select({ id: s.account.id }).from(s.account)
      .innerJoin(s.employee, eq(s.employee.id, s.account.employeeId))
      .where(and(eq(s.account.operatorId, input.operatorId), eq(s.employee.name, 'Khun Lek (Manager)'))).limit(1);
    if (!sale || !cashAttempt || !manager) throw new Error('The demo cash refund needs its original sale, cash tender and branch manager');
    const number = await allocateReceipt(writer, { operatorId: input.operatorId, branchId: input.branchId,
      stationId: input.stationId, series: `${input.series}-R`, at: input.occurredAt }, 'refund');
    const amountSatang = b(100);
    await writer.insert(s.refund).values({ id: stableId(actionId, input.occurredAt),
      operatorId: input.operatorId, branchId: input.branchId, saleId: sale.id,
      stationId: input.stationId, number: number.number, amountSatang, mode: 'custom',
      reason: 'Demo partial cash refund', approvedByAccountId: manager.id,
      createdByAccountId: input.createdByAccountId, actionId,
      tenderAllocation: [{ attemptId: cashAttempt.id, method: 'cash', methodCode: 'cash',
        provider: 'manual', route: 'cash', amountSatang, status: 'done',
        settledAt: input.occurredAt.toISOString() }],
      createdAt: input.occurredAt, updatedAt: input.occurredAt });
    await writer.update(s.sale).set({ refundedSatang: sql`${s.sale.refundedSatang} + ${amountSatang}` })
      .where(eq(s.sale.id, sale.id));
  });
}

// --- The arithmetic ---------------------------------------------------------

interface PricedLine extends DemoLine {
  /** Where this line sat on the receipt, kept because the category walk below reorders them. */
  order: number;
  base: number;
  discount: number;
  net: number;
  serviceCharge: number;
  tax: number;
  gross: number;
  taxMode: string;
  taxRateBp: number;
  taxRateId?: string;
  taxName?: string;
}

interface PricedSale {
  lines: PricedLine[];
  subtotal: number;
  discount: number;
  net: number;
  serviceCharge: number;
  taxInclusive: number;
  taxExclusive: number;
  gross: number;
  breakdown: TaxBreakdown;
}

/**
 * Price one scenario through the REAL tax engine.
 *
 * `computeTaxBreakdown` from `@oto/shared` is what the till and the api both
 * total a cart with, so the sale's `tax_breakdown` and its nine money columns
 * are the same arithmetic a real sale would have written — which is the only
 * reason `sale_totals_check` passes by construction here rather than by a
 * hand-balanced fixture somebody has to keep balanced.
 *
 * The per-line split is an apportionment of the category figures, the same
 * relationship `sale_line`'s own comment describes: the authoritative numbers
 * are the sale's, and these are that split. The remainder lands on the last
 * line of each category so the lines sum to the category exactly.
 */
function priceScenario(scenario: DemoSale, config: TaxConfigShape): PricedSale {
  const inputs: TaxCategoryInput[] = [];
  for (const line of scenario.lines) {
    inputs.push({
      category: line.taxableCategory as TaxCategoryInput['category'],
      base: line.quantity * line.unitSatang,
    });
  }
  const discount = scenario.discountSatang ?? 0;
  const breakdown = computeTaxBreakdown(inputs, discount, config);

  const subtotal = inputs.reduce((sum, i) => sum + i.base, 0);
  const lines: PricedLine[] = [];
  for (const category of new Set(scenario.lines.map((l) => l.taxableCategory))) {
    const inCategory = scenario.lines
      .map((line, order) => ({ line, order }))
      .filter((entry) => entry.line.taxableCategory === category);
    const row = breakdown.categories.find((c) => c.category === category);
    const categoryBase = inCategory.reduce(
      (sum, e) => sum + e.line.quantity * e.line.unitSatang,
      0,
    );
    // Three running remainders, each handed whole to the LAST line of the
    // category, so the lines sum to the category figure to the satang instead
    // of to the category figure plus however the rounding fell.
    let taxLeft = (row?.tax ?? 0) + (row?.secondaryTax ?? 0);
    let serviceLeft = row?.serviceCharge ?? 0;
    let grossLeft = row ? row.gross : categoryBase;
    for (const [i, entry] of inCategory.entries()) {
      const { line, order } = entry;
      const base = line.quantity * line.unitSatang;
      const last = i === inCategory.length - 1;
      const share = (value: number) =>
        categoryBase === 0 ? 0 : Math.round((value * base) / categoryBase);
      const tax = last ? taxLeft : share(taxLeft);
      const serviceCharge = last ? serviceLeft : share(serviceLeft);
      const gross = last ? grossLeft : share(row ? row.gross : base);
      taxLeft -= tax;
      serviceLeft -= serviceCharge;
      grossLeft -= gross;
      // `sale_line_totals_check`: gross = net + tax + service. Net is therefore
      // what is left of the gross once both are taken out, whichever mode the
      // category is in — an inclusive tax comes out of the price and an
      // exclusive one was added to it, and either way it is not revenue.
      const net = gross - tax - serviceCharge;
      lines.push({
        ...line,
        order,
        base,
        // What the sale's discount took off this line. Never negative: a
        // service charge can make the gross exceed the base, and a line
        // carrying a negative discount would fail the non-negative check for
        // a reason that has nothing to do with a discount.
        discount: Math.max(0, base - (gross - serviceCharge)),
        net,
        serviceCharge,
        tax,
        gross,
        taxMode: row?.taxMode ?? 'none',
        taxRateBp: Math.round((row?.taxPercent ?? 0) * 100),
        taxRateId: row?.taxRateId,
        taxName: row?.taxName,
      });
    }
  }
  // Restore the receipt's own order, which the category walk above lost.
  lines.sort((a, other) => a.order - other.order);

  return {
    lines,
    subtotal,
    discount,
    net: breakdown.grandTotal - breakdown.serviceChargeTotal - breakdown.inclusiveTaxTotal - breakdown.exclusiveTaxTotal,
    serviceCharge: breakdown.serviceChargeTotal,
    taxInclusive: breakdown.inclusiveTaxTotal,
    taxExclusive: breakdown.exclusiveTaxTotal,
    gross: breakdown.grandTotal,
    breakdown,
  };
}

/**
 * Take the next number out of the station's series and leave the mark advanced.
 *
 * One statement, `returning` the value it wrote, so two runs of this seed
 * against one database cannot hand the same number to two sales. The real path
 * (`allocateReceipt`, `services/sale.ts`) does the same thing under
 * `SELECT … FOR UPDATE` inside the finalise transaction.
 */
async function allocateReceipt(
  db: SeedWriter,
  at: { operatorId: string; branchId: string; stationId: string; series: string; at: Date },
  kind: 'sale' | 'refund' = 'sale',
): Promise<{ series: string; seq: number; number: string }> {
  await db
    .insert(s.receiptSeries)
    .values({
      id: newId(),
      operatorId: at.operatorId,
      branchId: at.branchId,
      stationId: at.stationId,
      series: at.series,
      kind,
    })
    .onConflictDoNothing({
      target: [s.receiptSeries.stationId, s.receiptSeries.series, s.receiptSeries.kind],
    });
  const [row] = await db
    .update(s.receiptSeries)
    .set({ nextSeq: sql`${s.receiptSeries.nextSeq} + 1`, lastIssuedAt: at.at })
    .where(
      and(
        eq(s.receiptSeries.stationId, at.stationId),
        eq(s.receiptSeries.series, at.series),
        eq(s.receiptSeries.kind, kind),
      ),
    )
    .returning({ nextSeq: s.receiptSeries.nextSeq, padding: s.receiptSeries.seqPadding });
  if (!row) throw new Error(`Could not allocate a receipt number in series ${at.series}`);
  const seq = row.nextSeq - 1;
  return { series: at.series, seq, number: `${at.series}-${String(seq).padStart(row.padding, '0')}` };
}

async function terminalIdOf(db: SeedWriter, deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: s.device.terminalId })
    .from(s.device)
    .where(eq(s.device.id, deviceId))
    .limit(1);
  return row?.value ?? null;
}

async function merchantIdOf(db: SeedWriter, deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ value: s.device.merchantId })
    .from(s.device)
    .where(eq(s.device.id, deviceId))
    .limit(1);
  return row?.value ?? null;
}

/** The zone's offset from UTC at an instant, in minutes. Read, not assumed. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * Run directly: `pnpm --filter @oto/db seed:demo-day`, or `--on 2026-09-20` for
 * a named day. It writes only to Demo Branch 2, which it makes on first use,
 * and refuses to run before `pnpm db:seed` has, so there is no profile switch
 * here.
 */
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('seed/demo-day.ts');
if (isMain) {
  const flag = process.argv.indexOf('--on');
  const on = flag >= 0 ? process.argv[flag + 1] : undefined;
  seedDemoDay(getDb(), on ? { on } : {})
    .then((counts) => {
      console.log(
        counts.sales === 0
          ? `Demo day ${counts.businessDate} at ${counts.branchName}: already seeded (${counts.skipped} sales), nothing written.`
          : `Demo day ${counts.businessDate} at ${counts.branchName}: ${counts.sales} sales, ${counts.lines} lines, ${counts.attempts} payment attempts, ${counts.notifications} gateway notifications${counts.skipped ? `, ${counts.skipped} already present` : ''}.`,
      );
      if (counts.legacyFixtureDays > 0) {
        console.log(`Frozen legacy fixture days loaded at ${counts.branchName}: ${counts.legacyFixtureDays}.`);
      }
      return closeDb();
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}

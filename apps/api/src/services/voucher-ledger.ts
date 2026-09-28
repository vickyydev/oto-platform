import { sql, type SQL } from 'drizzle-orm';
import type { branch, Db } from '@oto/db';
import { addDaysToIsoDate, boothStaffCode, businessDate, formatTHB, parseDayStart } from '@oto/shared';
import { AppError } from '../lib/errors';
import type { BoothStationRow } from './booth';

/**
 * Every voucher in one place, for the Console (owner, 28 September).
 *
 * Two reads, both built from rows the platform already keeps — no table of
 * their own:
 *
 *   - **the voucher ledger** (`GET /vouchers`, `GET /vouchers/export`): every
 *     voucher issued at a branch, whatever made it — a booth spin, the legacy
 *     import, a counter issue — with what it was worth, who issued it, where
 *     it stands and, once used, where, when, by whom and on which sale; and a
 *     line of totals per voucher type;
 *   - **a booth's spins** (`GET /booths/:id/spins`): every press of one
 *     booth's button on one trading day, whether it won, whose session it was,
 *     and whether its slip reached paper and a till.
 *
 * **What a voucher's status is, here.** `promo.voucher.status` holds four
 * words, and only two of them are written today — `issued` by the booth's
 * sync, `redeemed` by the sale that uses it up; nothing sweeps `expired`, and
 * nothing voids. The ledger's status is read from the whole row instead, in
 * this order: `redeemed`, `void` and `expired` as stored; `held` while a till
 * has it on a cart; `expired` once its `expires_at` has passed; `printed` once
 * paper exists for it (`print_count`, which only a print that produced paper
 * moves); `issued` otherwise — minted and not yet on paper, or a print that
 * failed. `VOUCHER_LEDGER_STATUSES` is that list.
 *
 * **Which day a voucher belongs to** is the branch's trading day, as every
 * booth figure is: a booth voucher takes the `business_date` its spin was
 * filed under (the box resolved it when the button was pressed), and any
 * other voucher is placed by its `issued_at` on the branch's clock, less the
 * branch's day start — the same arithmetic as `businessDate` in `@oto/shared`.
 *
 * **Never the whole code.** A code is what a till redeems, and anybody who
 * may read a report is not thereby somebody who may hand a family a prize, so
 * both reads carry its last four characters — enough to match a row to the
 * slip in a guest's hand, not enough to redeem it (`maskVoucherCode` in
 * `services/vouchers.ts` makes the same cut).
 */

/** The statuses the ledger shows and filters on — see the note above for how each is read. */
export const VOUCHER_LEDGER_STATUSES = [
  'issued',
  'printed',
  'held',
  'redeemed',
  'expired',
  'void',
] as const;
export type VoucherLedgerStatus = (typeof VOUCHER_LEDGER_STATUSES)[number];

/** What a voucher hands over, in words, and — once used — what the till took off for it. */
export interface VoucherValue {
  /**
   * `money` an amount off or a wallet credit, `percent` a percentage off,
   * `item` a free product, `ticket` a free kids ticket (1+1), `gift` a prize
   * handed over at reception.
   */
  kind: 'money' | 'percent' | 'item' | 'ticket' | 'gift';
  /** "฿100 off", "15% off", "Free item: Kids Pizza", "Gift: Bracelet workshop". */
  text: string;
  /**
   * The satang the sale that used it took off for it (`pos.sale_discount`,
   * the row named by its code): what an amount or a percentage came to on
   * that bill, or a free item's shelf price. Null until it is used, and for a
   * gift, which is handed over at a ฿0 sale.
   */
  redeemedSatang: number | null;
}

export interface LedgerPerson {
  accountId: string;
  /** The employee's nickname, else their name; null for an account with no employee. */
  name: string | null;
  /** The staff code a slip prints beside the name (`boothStaffCode`). */
  code: string;
}

export interface VoucherLedgerRow {
  id: string;
  issuedAt: string;
  /** The branch trading day it was issued on. */
  businessDate: string;
  type: { id: string; code: string; nameEn: string; nameTh: string | null; kind: string };
  /** The booth prize a spin won it as; null for a voucher no spin minted. */
  prize: { id: string; nameEn: string } | null;
  value: VoucherValue;
  /**
   * Where it came from: the booth whose spin minted it, or — for a voucher
   * with no spin behind it — the counter (`manual`) or the import of the old
   * system's codes (`legacy`).
   */
  place: { kind: 'booth' | 'counter' | 'import'; stationId: string | null; name: string };
  /** Signed in when it was issued; null is unattributed — nobody was. */
  issuedBy: LedgerPerson | null;
  /** The code's last four characters. Never the whole code. */
  codeLast4: string;
  source: string;
  status: VoucherLedgerStatus;
  /** Copies on paper. */
  printCount: number;
  expiresAt: string | null;
  redeemed: {
    at: string;
    branchName: string | null;
    stationName: string | null;
    by: LedgerPerson | null;
    saleId: string | null;
    receiptNumber: string | null;
  } | null;
}

export interface VoucherTypeTotals {
  type: { id: string; code: string; nameEn: string; kind: string };
  /** How its value is expressed, so a reader knows whether the money total is the whole story. */
  valueKind: VoucherValue['kind'];
  issued: number;
  redeemed: number;
  /** Redeemed over issued, 0 to 1. Null when none was issued. */
  redemptionRate: number | null;
  expired: number;
  /** The satang the tills took off for the redeemed ones — see `VoucherValue.redeemedSatang`. */
  handedOverSatang: number;
}

export interface VoucherLedgerFilters {
  /** Trading days, inclusive. Absent: today at the branch, for both. */
  from?: string;
  to?: string;
  definitionId?: string;
  /** The booth whose spins minted them. */
  stationId?: string;
  /** Who was signed in when they were issued, or `unattributed` for nobody. */
  issuedBy?: string;
  status?: VoucherLedgerStatus;
}

export interface VoucherLedger {
  range: { from: string; to: string };
  /** Every voucher the filters match, before paging. */
  total: number;
  rows: VoucherLedgerRow[];
  /** One line per voucher type, over every filter but `status` — the whole range, not the page. */
  totals: VoucherTypeTotals[];
}

/** A range longer than this is refused: a year of vouchers is a report, not a screen. */
export const VOUCHER_LEDGER_MAX_DAYS = 366;

/** The CSV's ceiling. Far above a year of one park's booths; a bound, not a target. */
const CSV_ROW_CEILING = 100_000;

type BranchRow = typeof branch.$inferSelect;

// --- The shared FROM ---------------------------------------------------------

/**
 * Everything a ledger row names, joined once.
 *
 * `rd` is the discount the redeeming sale recorded under this voucher's code —
 * the platform's own figure, written when the sale was priced
 * (`services/sale.ts`), never the till's. Lateral and `limit 1` so a sale can
 * never make one voucher two rows.
 */
const LEDGER_FROM = sql`
  from promo.voucher v
  join promo.voucher_definition d on d.id = v.voucher_definition_id
  left join booth.spin s on s.voucher_id = v.id
  left join booth.booth_prize bp on bp.id = s.prize_id
  left join core.station bs on bs.id = s.station_id
  left join core.account ia on ia.id = v.issued_by_account_id
  left join core.employee ie on ie.id = ia.employee_id
  left join core.account ra on ra.id = v.redeemed_by_account_id
  left join core.employee re on re.id = ra.employee_id
  left join core.branch rb on rb.id = v.redeemed_branch_id
  left join core.station rs on rs.id = v.redeemed_station_id
  left join pos.sale sa on sa.id = v.sale_id
  left join pos.product p on p.id = d.product_id
  left join pos.ticket_package tp on tp.id = d.ticket_package_id
  left join lateral (
    select sd.amount_satang
      from pos.sale_discount sd
     where sd.sale_id = v.sale_id and sd.kind = 'promo' and sd.code = v.code
     order by sd.sequence
     limit 1
  ) rd on true`;

/** The ledger's status, read from the whole row. The order is the note at the top of the file. */
const STATUS = sql`(case
  when v.status = 'redeemed' then 'redeemed'
  when v.status = 'void' then 'void'
  when v.status = 'expired' then 'expired'
  when v.held_sale_id is not null then 'held'
  when v.expires_at is not null and v.expires_at <= now() then 'expired'
  when v.print_count > 0 then 'printed'
  else 'issued'
end)`;

/** The trading day a voucher was issued on, at this branch. */
function issuedDay(br: BranchRow): SQL {
  return sql`coalesce(s.business_date, ((v.issued_at at time zone ${br.timezone}::text) - ${br.businessDayStart}::interval)::date)`;
}

function todayAt(br: BranchRow): string {
  return businessDate(new Date(), br.timezone, parseDayStart(br.businessDayStart));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The inclusive range the filters ask for, checked. */
function rangeOf(br: BranchRow, filters: VoucherLedgerFilters): { from: string; to: string } {
  const to = filters.to ?? filters.from ?? todayAt(br);
  const from = filters.from ?? to;
  for (const day of [from, to]) {
    if (!ISO_DATE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      throw new AppError(400, 'VOUCHER_LEDGER_DATE', `"${day}" is not a date (YYYY-MM-DD)`);
    }
  }
  if (from > to) {
    throw new AppError(400, 'VOUCHER_LEDGER_RANGE', 'The range starts after it ends');
  }
  if (daysBetween(from, to) + 1 > VOUCHER_LEDGER_MAX_DAYS) {
    throw new AppError(
      400,
      'VOUCHER_LEDGER_RANGE',
      `A range is at most ${VOUCHER_LEDGER_MAX_DAYS} days; narrow it and download it in parts`,
    );
  }
  return { from, to };
}

/**
 * The WHERE for a ledger read. `withStatus` false is the totals' version: a
 * total per type is over every voucher of the range, whatever the status
 * filter narrows the list to.
 *
 * The `issued_at` window around the trading days is there for the index
 * (`voucher_branch_issued_idx`) and is wider than any trading day can be —
 * two days either side covers every timezone and day start — so the exact
 * test is the one on the trading day beside it.
 */
function whereOf(
  operatorId: string,
  br: BranchRow,
  range: { from: string; to: string },
  filters: VoucherLedgerFilters,
  withStatus: boolean,
): SQL {
  const low = new Date(Date.parse(`${addDaysToIsoDate(range.from, -2)}T00:00:00Z`));
  const high = new Date(Date.parse(`${addDaysToIsoDate(range.to, 3)}T00:00:00Z`));
  const day = issuedDay(br);
  const conditions: SQL[] = [
    sql`v.operator_id = ${operatorId}::uuid`,
    sql`v.branch_id = ${br.id}::uuid`,
    sql`v.issued_at >= ${low} and v.issued_at < ${high}`,
    sql`${day} between ${range.from}::date and ${range.to}::date`,
  ];
  if (filters.definitionId) conditions.push(sql`v.voucher_definition_id = ${filters.definitionId}::uuid`);
  if (filters.stationId) conditions.push(sql`s.station_id = ${filters.stationId}::uuid`);
  if (filters.issuedBy === 'unattributed') conditions.push(sql`v.issued_by_account_id is null`);
  else if (filters.issuedBy) conditions.push(sql`v.issued_by_account_id = ${filters.issuedBy}::uuid`);
  if (withStatus && filters.status) conditions.push(sql`${STATUS} = ${filters.status}`);
  return sql`where ${sql.join(conditions, sql` and `)}`;
}

// --- Rows --------------------------------------------------------------------

interface RawLedgerRow extends Record<string, unknown> {
  id: string;
  code: string;
  source: string;
  issued_at: Date;
  business_date: string;
  expires_at: Date | null;
  print_count: number;
  redeemed_at: Date | null;
  sale_id: string | null;
  status: VoucherLedgerStatus;
  def_id: string;
  def_code: string;
  def_name_en: string;
  def_name_th: string | null;
  def_kind: string;
  value_type: string;
  value_satang: number | null;
  value_bp: number | null;
  product_name: string | null;
  package_name: string | null;
  prize_id: string | null;
  prize_name_en: string | null;
  booth_id: string | null;
  booth_name: string | null;
  issued_by: string | null;
  issuer_name: string | null;
  redeemed_by: string | null;
  redeemer_name: string | null;
  redeemed_branch_name: string | null;
  redeemed_station_name: string | null;
  receipt_number: string | null;
  redeemed_amount: string | null;
}

const ROW_COLUMNS = sql`
  v.id, v.code, v.source, v.issued_at, v.expires_at, v.print_count, v.redeemed_at, v.sale_id,
  d.id as def_id, d.code as def_code, d.name_en as def_name_en, d.name_th as def_name_th,
  d.kind as def_kind, d.value_type, d.value_satang, d.value_bp,
  p.name as product_name, tp.name as package_name,
  bp.id as prize_id, bp.name_en as prize_name_en, bs.id as booth_id, bs.name as booth_name,
  v.issued_by_account_id as issued_by, coalesce(ie.nickname, ie.name) as issuer_name,
  v.redeemed_by_account_id as redeemed_by, coalesce(re.nickname, re.name) as redeemer_name,
  rb.name as redeemed_branch_name, rs.name as redeemed_station_name, sa.receipt_number,
  rd.amount_satang::text as redeemed_amount`;

/** "12.5" for 1250 basis points; no trailing zeros. */
function percentText(bp: number): string {
  return String(bp / 100);
}

/** How a voucher type's value is expressed, from its kind and value type. */
function valueKindOf(kind: string, valueType: string): VoucherValue['kind'] {
  switch (kind) {
    case 'discount':
      return valueType === 'percent' ? 'percent' : 'money';
    case 'wallet_credit':
      return 'money';
    case 'free_item':
      return 'item';
    case 'free_ticket':
      return 'ticket';
    default:
      // `manual`: handed over at reception, rung up as a ฿0 sale.
      return 'gift';
  }
}

function valueOf(
  def: { kind: string; valueType: string; valueSatang: number | null; valueBp: number | null; nameEn: string },
  names: { product: string | null; package: string | null; prize: string | null },
  redeemedSatang: number | null,
): VoucherValue {
  const kind = valueKindOf(def.kind, def.valueType);
  switch (kind) {
    case 'percent':
      return { kind, text: `${percentText(def.valueBp ?? 0)}% off`, redeemedSatang };
    case 'money':
      return {
        kind,
        text:
          def.kind === 'wallet_credit'
            ? `${formatTHB(def.valueSatang ?? 0)} wallet credit`
            : `${formatTHB(def.valueSatang ?? 0)} off`,
        redeemedSatang,
      };
    case 'item':
      return { kind, text: names.product ? `Free item: ${names.product}` : 'Free item', redeemedSatang };
    case 'ticket':
      return {
        kind,
        text: names.package ? `Free kids ticket (1+1): ${names.package}` : 'Free kids ticket (1+1)',
        redeemedSatang,
      };
    case 'gift':
      return { kind, text: `Gift: ${names.prize ?? def.nameEn}`, redeemedSatang: null };
  }
}

function personOf(accountId: string | null, name: string | null): LedgerPerson | null {
  return accountId ? { accountId, name, code: boothStaffCode(accountId) } : null;
}

function placeOf(r: RawLedgerRow): VoucherLedgerRow['place'] {
  if (r.booth_id) return { kind: 'booth', stationId: r.booth_id, name: r.booth_name ?? 'Booth' };
  if (r.source === 'legacy') return { kind: 'import', stationId: null, name: 'Imported (old system)' };
  if (r.source === 'booth') {
    // A booth voucher whose spin has not reached the platform yet: the box
    // sends the press and the voucher together, so this is a moment, not a state.
    return { kind: 'booth', stationId: null, name: 'Booth (spin not synced yet)' };
  }
  return { kind: 'counter', stationId: null, name: 'Counter' };
}

function rowOf(r: RawLedgerRow): VoucherLedgerRow {
  const redeemedSatang =
    r.status === 'redeemed' && r.redeemed_amount !== null ? Number(r.redeemed_amount) : null;
  return {
    id: r.id,
    issuedAt: new Date(r.issued_at).toISOString(),
    businessDate: r.business_date,
    type: {
      id: r.def_id,
      code: r.def_code,
      nameEn: r.def_name_en,
      nameTh: r.def_name_th,
      kind: r.def_kind,
    },
    prize: r.prize_id ? { id: r.prize_id, nameEn: r.prize_name_en ?? '' } : null,
    value: valueOf(
      {
        kind: r.def_kind,
        valueType: r.value_type,
        valueSatang: r.value_satang,
        valueBp: r.value_bp,
        nameEn: r.def_name_en,
      },
      { product: r.product_name, package: r.package_name, prize: r.prize_name_en },
      redeemedSatang,
    ),
    place: placeOf(r),
    issuedBy: personOf(r.issued_by, r.issuer_name),
    codeLast4: r.code.slice(-4),
    source: r.source,
    status: r.status,
    printCount: Number(r.print_count),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    redeemed: r.redeemed_at
      ? {
          at: new Date(r.redeemed_at).toISOString(),
          branchName: r.redeemed_branch_name,
          stationName: r.redeemed_station_name,
          by: personOf(r.redeemed_by, r.redeemer_name),
          saleId: r.sale_id,
          receiptNumber: r.receipt_number,
        }
      : null,
  };
}

async function readRows(
  db: Db,
  operatorId: string,
  br: BranchRow,
  range: { from: string; to: string },
  filters: VoucherLedgerFilters,
  page: { limit: number; offset: number },
): Promise<VoucherLedgerRow[]> {
  const { rows } = await db.execute<RawLedgerRow>(sql`
    select ${ROW_COLUMNS}, ${issuedDay(br)}::text as business_date, ${STATUS} as status
    ${LEDGER_FROM}
    ${whereOf(operatorId, br, range, filters, true)}
    order by v.issued_at desc, v.id desc
    limit ${page.limit} offset ${page.offset}`);
  return rows.map(rowOf);
}

// --- The ledger --------------------------------------------------------------

/**
 * One page of a branch's vouchers, the number the filters match, and the
 * totals per type over the whole range.
 *
 * The branch is the caller's, loaded inside the caller's operator by the
 * route (`loadBranchForOperator`); the operator is named again in the WHERE
 * so that no filter can reach another tenant's row.
 */
export async function listVoucherLedger(
  db: Db,
  operatorId: string,
  br: BranchRow,
  filters: VoucherLedgerFilters,
  page: { limit: number; offset: number },
): Promise<VoucherLedger> {
  const range = rangeOf(br, filters);
  const rows = await readRows(db, operatorId, br, range, filters, page);

  const { rows: counted } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    ${LEDGER_FROM}
    ${whereOf(operatorId, br, range, filters, true)}`);

  const { rows: grouped } = await db.execute<{
    def_id: string;
    def_code: string;
    def_name_en: string;
    def_kind: string;
    value_type: string;
    issued: number;
    redeemed: number;
    expired: number;
    handed_over: string;
  }>(sql`
    select d.id as def_id, d.code as def_code, d.name_en as def_name_en, d.kind as def_kind,
           d.value_type,
           count(*)::int as issued,
           (count(*) filter (where v.status = 'redeemed'))::int as redeemed,
           (count(*) filter (where ${STATUS} = 'expired'))::int as expired,
           coalesce(sum(rd.amount_satang) filter (where v.status = 'redeemed'), 0)::text as handed_over
    ${LEDGER_FROM}
    ${whereOf(operatorId, br, range, filters, false)}
    group by d.id, d.code, d.name_en, d.kind, d.value_type
    order by d.name_en, d.id`);

  const totals: VoucherTypeTotals[] = grouped.map((g) => {
    const issued = Number(g.issued);
    const redeemed = Number(g.redeemed);
    return {
      type: { id: g.def_id, code: g.def_code, nameEn: g.def_name_en, kind: g.def_kind },
      valueKind: valueKindOf(g.def_kind, g.value_type),
      issued,
      redeemed,
      redemptionRate: issued > 0 ? redeemed / issued : null,
      expired: Number(g.expired),
      handedOverSatang: g.def_kind === 'manual' ? 0 : Number(g.handed_over),
    };
  });

  return { range, total: Number(counted[0]?.n ?? 0), rows, totals };
}

// --- The download ------------------------------------------------------------

/** "2026-09-28 14:03" on the branch's clock. */
function localDateTime(instant: string | null, timeZone: string): string {
  if (!instant) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    numberingSystem: 'latn',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/**
 * One CSV cell. Quoted when it has to be, and a cell that a spreadsheet would
 * run as a formula — a staff name or a prize typed as "=…" — is prefixed with
 * an apostrophe, so opening the file never executes anything somebody typed.
 */
function cell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const STATUS_WORDS: Record<VoucherLedgerStatus, string> = {
  issued: 'Issued, not printed',
  printed: 'Printed',
  held: 'On a till’s cart',
  redeemed: 'Redeemed',
  expired: 'Expired',
  void: 'Void',
};

/**
 * Every voucher the filters match — not a page — as a CSV a spreadsheet opens.
 * Times are on the branch's clock, money in baht, the code its last four.
 */
export async function voucherLedgerCsv(
  db: Db,
  operatorId: string,
  br: BranchRow,
  filters: VoucherLedgerFilters,
): Promise<{ filename: string; csv: string }> {
  const range = rangeOf(br, filters);
  const rows = await readRows(db, operatorId, br, range, filters, {
    limit: CSV_ROW_CEILING,
    offset: 0,
  });
  const header = [
    'Issued at',
    'Trading day',
    'Voucher type',
    'Prize',
    'Value',
    'Taken off at the till (THB)',
    'Booth or counter',
    'Issued by',
    'Staff code',
    'Code (last 4)',
    'Status',
    'Copies printed',
    'Expires',
    'Redeemed at',
    'Redeemed at branch',
    'Redeemed at till',
    'Redeemed by',
    'Receipt',
  ];
  const lines = [header.map(cell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        localDateTime(r.issuedAt, br.timezone),
        r.businessDate,
        r.type.nameEn,
        r.prize?.nameEn ?? '',
        r.value.text,
        r.value.redeemedSatang === null ? '' : (r.value.redeemedSatang / 100).toFixed(2),
        r.place.name,
        r.issuedBy ? (r.issuedBy.name ?? 'Unnamed account') : 'Unattributed',
        r.issuedBy?.code ?? '',
        r.codeLast4,
        STATUS_WORDS[r.status],
        r.printCount,
        localDateTime(r.expiresAt, br.timezone),
        localDateTime(r.redeemed?.at ?? null, br.timezone),
        r.redeemed?.branchName ?? '',
        r.redeemed?.stationName ?? '',
        r.redeemed ? (r.redeemed.by?.name ?? '') : '',
        r.redeemed?.receiptNumber ?? '',
      ]
        .map(cell)
        .join(','),
    );
  }
  const span = range.from === range.to ? range.from : `${range.from}_to_${range.to}`;
  const slug = br.code.replace(/[^A-Za-z0-9-]/g, '-');
  // A byte-order mark, so a spreadsheet opens the Thai names and ฿ as UTF-8.
  return { filename: `vouchers_${slug}_${span}.csv`, csv: `﻿${lines.join('\r\n')}\r\n` };
}

// --- One booth's spins ---------------------------------------------------------

export interface BoothSpinRow {
  id: string;
  occurredAt: string;
  /** Whose session was open at the booth; null is unattributed. */
  staff: LedgerPerson | null;
  outcome: 'prize' | 'no_prize';
  prize: { id: string; nameEn: string } | null;
  /** The voucher's code, last four; null for no prize, or a voucher not synced yet. */
  codeLast4: string | null;
  /**
   * `printed` — paper exists; `failed` — the box reported an attempt that
   * produced none; `not_reported` — no print outcome has reached the platform
   * yet (a box offline, or a print still queued); null — no voucher.
   */
  print: 'printed' | 'failed' | 'not_reported' | null;
  redeemed: boolean;
  redeemedAt: string | null;
  /** The box could not vouch for its clock when it stamped the time. */
  clockSuspect: boolean;
}

export interface BoothSpins {
  businessDate: string;
  total: number;
  summary: { spins: number; unattributed: number; printed: number; redeemed: number };
  spins: BoothSpinRow[];
}

/**
 * One booth's presses on one trading day, newest first. The `#debug`
 * overlay's simulated spins are left out, as every booth figure leaves them.
 * What has not synced from the box yet is not here: a booth offline since
 * lunchtime shows the morning.
 */
export async function listBoothSpins(
  db: Db,
  row: BoothStationRow,
  br: BranchRow,
  query: { date?: string; limit: number; offset: number },
): Promise<BoothSpins> {
  const day = query.date ?? todayAt(br);
  if (!ISO_DATE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new AppError(400, 'BOOTH_SPINS_DATE', `"${day}" is not a date (YYYY-MM-DD)`);
  }
  const { rows } = await db.execute<{
    id: string;
    occurred_at: Date;
    outcome: 'prize' | 'no_prize';
    clock_suspect: boolean;
    staff_account_id: string | null;
    staff_name: string | null;
    prize_id: string | null;
    prize_name: string | null;
    voucher_id: string | null;
    code: string | null;
    print_count: number | null;
    voucher_status: string | null;
    redeemed_at: Date | null;
    print_attempted: boolean;
  }>(sql`
    select s.id, s.occurred_at, s.outcome, s.clock_suspect, s.staff_account_id,
           coalesce(e.nickname, e.name) as staff_name,
           bp.id as prize_id, bp.name_en as prize_name,
           v.id as voucher_id, v.code, v.print_count, v.status as voucher_status, v.redeemed_at,
           exists (select 1 from booth.voucher_print vp where vp.voucher_id = v.id) as print_attempted
      from booth.spin s
      left join promo.voucher v on v.id = s.voucher_id
      left join booth.booth_prize bp on bp.id = s.prize_id
      left join core.account a on a.id = s.staff_account_id
      left join core.employee e on e.id = a.employee_id
     where s.station_id = ${row.stationId}::uuid
       and s.business_date = ${day}::date
       and s.simulated = false
     order by s.occurred_at desc, s.id desc
     limit ${query.limit} offset ${query.offset}`);

  const { rows: summed } = await db.execute<{
    spins: number;
    unattributed: number;
    printed: number;
    redeemed: number;
  }>(sql`
    select count(*)::int as spins,
           (count(*) filter (where s.staff_account_id is null))::int as unattributed,
           (count(*) filter (where v.print_count > 0))::int as printed,
           (count(*) filter (where v.status = 'redeemed'))::int as redeemed
      from booth.spin s
      left join promo.voucher v on v.id = s.voucher_id
     where s.station_id = ${row.stationId}::uuid
       and s.business_date = ${day}::date
       and s.simulated = false`);
  const summary = summed[0] ?? { spins: 0, unattributed: 0, printed: 0, redeemed: 0 };

  return {
    businessDate: day,
    total: Number(summary.spins),
    summary: {
      spins: Number(summary.spins),
      unattributed: Number(summary.unattributed),
      printed: Number(summary.printed),
      redeemed: Number(summary.redeemed),
    },
    spins: rows.map((r) => ({
      id: r.id,
      occurredAt: new Date(r.occurred_at).toISOString(),
      staff: personOf(r.staff_account_id, r.staff_name),
      outcome: r.outcome,
      prize: r.prize_id ? { id: r.prize_id, nameEn: r.prize_name ?? '' } : null,
      codeLast4: r.code ? r.code.slice(-4) : null,
      print: !r.voucher_id
        ? null
        : Number(r.print_count ?? 0) > 0
          ? 'printed'
          : r.print_attempted
            ? 'failed'
            : 'not_reported',
      redeemed: r.voucher_status === 'redeemed',
      redeemedAt: r.redeemed_at ? new Date(r.redeemed_at).toISOString() : null,
      clockSuspect: r.clock_suspect,
    })),
  };
}

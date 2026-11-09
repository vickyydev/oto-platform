import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { branch, type Db } from '@oto/db';
import {
  hasBoothCodeShape, isLegacyBoothCode, normaliseBoothCode, normalizePhone, parseBandCode, parseBandShortCode, type Permission,
} from '@oto/shared';
import { audit } from './audit';
import { maskPersonal } from './audit-mask';
import { SESSION_PAGE_MAX } from './account-sessions';
import { branchReach } from './access-control';
import { callPlatform, type GetRouteTemplate, type PlatformResponse } from './assistant/call-platform';
import { GATE_EVENTS_LIMIT } from './gate-events';
import type { EffectivePermission } from './permissions';
import { withTx, type OpContext } from './tx';

/**
 * SCRUM-648 (S2-23 P5-6) — THE CROSS-APP SUPPORT LOOKUP.
 *
 * One box, "a customer is standing at the desk and something is wrong": a
 * phone, a band, a receipt, a booking reference, a voucher code, an account id
 * or an action id, and everything the suite knows about it, each answer
 * labelled with the app that owns it.
 *
 * NOTHING HERE READS A DOMAIN'S TABLES. Every section is that domain's own GET
 * route, run in process through `callPlatform` with the caller's own session
 * cookie — the same sanctioned seam the internal assistant uses, so the
 * route's declared guard, its handler's checks, its scope and its own masking
 * all apply exactly as they do on the screen that owns them. The OTO App is a
 * separate service, so its section is that app's own route, reached as the
 * caller through the suite hand-off (`support-otoapp.ts`). A section the
 * caller may not read answers `denied` (never silently missing); one whose
 * domain has no safe reader for this kind of key answers `not_built` and says
 * why; an app that failed answers `unavailable`. Member, child and OTO App
 * records are additionally passed through the audit read's mask unless the
 * caller holds `admin:audit:read_sensitive` operator-wide.
 *
 * A ROW LEADS WITH WHAT THE PERSON AT THE DESK ASKS. The Console lists the first
 * eight scalar facts of a row (`rowFacts`), so the readers added for this lookup
 * have their rows ordered for it, and a nested answer flattened, here (`deskFirst`).
 *
 * Every lookup writes ONE audit row in the data_access category naming the
 * kinds searched and which sections answered with how many rows — never the
 * searched value and never a returned value — and the answer is handed over
 * only once that row is committed.
 */

export const SUPPORT_QUERY_KINDS = ['phone', 'band', 'receipt', 'booking', 'voucher', 'account', 'action'] as const;
export type SupportQueryKind = typeof SUPPORT_QUERY_KINDS[number];
export const SUPPORT_SECTION_APPS = ['crm', 'pos', 'inbox', 'oto_app', 'platform'] as const;
export type SupportSectionApp = typeof SUPPORT_SECTION_APPS[number];
export const SUPPORT_SECTION_STATUSES = ['found', 'empty', 'denied', 'unavailable', 'not_built'] as const;
export type SupportSectionStatus = typeof SUPPORT_SECTION_STATUSES[number];

export interface SupportSection {
  key: string;
  app: SupportSectionApp;
  kind: SupportQueryKind;
  label: string;
  status: SupportSectionStatus;
  /** The permission the owning route asks for; null where no route was called, or where the owning app itself refused and `note` is its own reason. */
  permission: string | null;
  rowCount: number;
  masked: boolean;
  rows: Record<string, unknown>[];
  note: string | null;
}

export interface SupportLookupAnswer {
  generatedAt: string;
  kinds: SupportQueryKind[];
  detected: boolean;
  masked: boolean;
  sections: SupportSection[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;
const RECEIPT = /^[A-Z0-9]{1,12}-\d{3,10}$/i;
const SHORT_KEY = /^[A-Z0-9]{4,24}$/i;

/** Which kinds of key a typed value could be. More than one is searched when it is ambiguous. */
export function detectQueryKinds(raw: string): SupportQueryKind[] {
  const q = raw.trim();
  if (!q) return [];
  if (UUID.test(q)) return ['account', 'action'];
  // A phone is digits and the punctuation people type around them, nothing else.
  if (/^\+?[\d\s().-]{8,24}$/.test(q) && (q.match(/\d/g)?.length ?? 0) >= 8 && normalizePhone(q)) return ['phone'];
  const kinds: SupportQueryKind[] = [];
  if (parseBandCode(q) || parseBandShortCode(q)) kinds.push('band');
  if (RECEIPT.test(q)) kinds.push('receipt');
  if (SHORT_KEY.test(q)) kinds.push('booking', 'voucher');
  // A booth code as people read it off the screen: `B1 RT7K MQ4X Z`. A check character that does not add up is still a voucher search, which then finds nothing.
  else if (hasBoothCodeShape(normaliseBoothCode(q)) || isLegacyBoothCode(q)) kinds.push('voucher');
  if (ACTION_ID.test(q) && !kinds.includes('band')) kinds.push('action');
  return kinds;
}

// --- Calling a domain's own route -------------------------------------------------

interface Caller {
  app: FastifyInstance;
  token: string;
  requestId: string;
  seq: number;
}

async function get(caller: Caller, url: string, route: GetRouteTemplate): Promise<PlatformResponse> {
  caller.seq += 1;
  return callPlatform(caller.app, { token: caller.token, requestId: caller.requestId, seq: caller.seq, url, routes: [route] });
}

type Rows = Record<string, unknown>[];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const listAt = (body: unknown, key: string): Rows => {
  const value = isRecord(body) ? body[key] : undefined;
  return Array.isArray(value) ? value.filter(isRecord) : [];
};

interface Outcome { status: SupportSectionStatus; rows: Rows; note: string | null }

/** What one domain call says: 200 rows, 404 nothing, 403 denied, anything else unavailable. */
function outcomeOf(res: PlatformResponse, rowsOf: (body: unknown) => Rows): Outcome {
  if (res.status === 200) {
    const rows = rowsOf(res.body);
    return { status: rows.length > 0 ? 'found' : 'empty', rows, note: null };
  }
  if (res.status === 404) return { status: 'empty', rows: [], note: null };
  if (res.status === 403) return { status: 'denied', rows: [], note: errorMessage(res.body) };
  return { status: 'unavailable', rows: [], note: `The owning service answered ${res.status}${errorCode(res.body)}.` };
}
function errorMessage(body: unknown): string | null {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  return typeof error?.message === 'string' ? error.message : null;
}
function errorCode(body: unknown): string {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  return typeof error?.code === 'string' ? ` (${error.code})` : '';
}

/**
 * One call per live park, for the readers that answer one park at a time.
 * `limited` names the bound of a reader that says `truncated` when it cut its
 * answer, so the note names only the parks where something was left out.
 */
async function perBranch(caller: Caller, branches: readonly { id: string; name: string }[],
  urlOf: (branchId: string) => string, route: GetRouteTemplate, rowsOf: (body: unknown) => Rows, limited?: number): Promise<Outcome> {
  const answers = await Promise.all(branches.map(async b => {
    const res = await get(caller, urlOf(b.id), route);
    return { b, out: outcomeOf(res, rowsOf), cut: res.status === 200 && isRecord(res.body) && res.body.truncated === true };
  }));
  const rows = answers.flatMap(({ b, out }) => out.rows.map(row => ({ ...row, park: b.name })));
  const denied = answers.filter(a => a.out.status === 'denied').map(a => a.b.name);
  const failed = answers.filter(a => a.out.status === 'unavailable').map(a => a.b.name);
  const cut = answers.filter(a => a.cut).map(a => a.b.name);
  const notes = [
    ...(denied.length > 0 ? [`Not readable at ${denied.join(', ')}.`] : []),
    ...(failed.length > 0 ? [`Could not be read at ${failed.join(', ')}.`] : []),
    ...(limited !== undefined && cut.length > 0 ? [`Showing the newest ${limited} at ${cut.join(', ')}.`] : []),
  ];
  const status: SupportSectionStatus = rows.length > 0 ? 'found'
    : denied.length === answers.length && answers.length > 0 ? 'denied'
      : failed.length > 0 ? 'unavailable' : 'empty';
  return { status, rows, note: notes.length > 0 ? notes.join(' ') : null };
}

function section(input: Omit<SupportSection, 'rowCount' | 'masked'> & { masked?: boolean }): SupportSection {
  return { ...input, masked: input.masked ?? false, rowCount: input.rows.length };
}

// --- A row as the Console lists it ------------------------------------------------

/**
 * The row with the facts named in `order` at its front, those with a value and
 * in that order; every other fact stays behind them. Nothing is dropped, so the
 * order alone decides what reaches the Console's compact list.
 */
function deskFirst(row: Rows[number], order: readonly string[]): Rows[number] {
  const first = order.filter(key => row[key] !== null && row[key] !== undefined);
  const rest = Object.keys(row).filter(key => !first.includes(key));
  return Object.fromEntries([...first, ...rest].map(key => [key, row[key]]));
}

/** One passage: when, which way, through which lane at which park, what the reader said of it, and a clock it could not trust. */
function gateRow(row: Rows[number]): Rows[number] {
  const clock = row.clockTrusted === false ? ['clockTrusted'] : [];
  const flags = ['exitWithoutEntry', 'revoked', 'offline'].filter(key => row[key] === true);
  return deskFirst(row, ['at', 'kind', 'direction', 'stationName', 'park', 'reason', 'alarm', ...clock, ...flags, 'bandShortCode', 'bandKind']);
}

/**
 * One code: what it is, what it is worth, whether it was used and where. The
 * reader's nested type, value and redemption are flat here because the compact
 * list shows scalars.
 */
function voucherRow(row: Rows[number]): Rows[number] {
  const field = (object: unknown, key: string): unknown => (isRecord(object) ? object[key] ?? null : null);
  const common = {
    record: row.record, id: row.id, codeLast4: row.codeLast4,
    type: field(row.type, 'nameEn'), typeKind: field(row.type, 'kind'), value: field(row.value, 'text'),
  };
  if (row.record === 'voucher_type') return deskFirst({ ...common, state: row.state }, ['record', 'state', 'type', 'value', 'codeLast4']);
  const where = [field(row.redeemed, 'branchName'), field(row.redeemed, 'stationName')].filter(Boolean).join(', ');
  return deskFirst({
    ...common, status: row.status, park: row.branchName, branchId: row.branchId, businessDate: row.businessDate,
    redeemedAt: field(row.redeemed, 'at'), redeemedWhere: where || null, receiptNumber: field(row.redeemed, 'receiptNumber'),
    saleId: field(row.redeemed, 'saleId'), redeemedSatang: field(row.value, 'redeemedSatang'),
    expiresAt: row.expiresAt, prize: field(row.prize, 'nameEn'), issuedAt: row.issuedAt, issuedFrom: field(row.place, 'name'),
    printCount: row.printCount, source: row.source,
  }, ['status', 'type', 'value', 'codeLast4', 'park', 'redeemedAt', 'redeemedWhere', 'receiptNumber', 'expiresAt', 'prize', 'issuedAt', 'issuedFrom']);
}

/** One sign-in: whether it is still in use or when it ended, then when it was last used and when it runs out. */
function sessionRow(row: Rows[number]): Rows[number] {
  return deskFirst(row, ['status', 'endedAt', 'lastSeenAt', 'expiresAt', 'createdAt', 'lockedAt', 'stationId', 'branchId']);
}

/** What tells a person which of the OTO App's records this is, by the kind of record it says it is. */
const OTO_APP_DESK: Readonly<Record<string, readonly string[]>> = {
  person: ['personKind', 'name', 'nickname', 'status', 'park'],
  event: ['eventType', 'name', 'guardianName', 'date', 'startTime', 'status', 'park'],
  event_registration: ['registrationKind', 'eventType', 'name', 'guardianName', 'date', 'park'],
  checkin: ['checkinKind', 'serviceType', 'status', 'name', 'guardianName', 'children', 'park', 'date', 'checkedInAt', 'checkedOutAt', 'createdAt', 'pickedUpAt'],
};
function otoAppRow(row: Rows[number]): Rows[number] {
  const order = typeof row.record === 'string' ? OTO_APP_DESK[row.record] : undefined;
  return order ? deskFirst(row, order) : row;
}

/** Said only when nothing was found, where "nothing" would otherwise read as "no such code". */
const PROMO_CODES_NOT_SEARCHED = 'Searches voucher codes and shared voucher-type codes. A park promo code that a till takes as a discount is not searched here.';

// --- The lookup -----------------------------------------------------------------------

export interface SupportLookupInput {
  q: string;
  kind?: SupportQueryKind;
  operatorId: string;
  effective: EffectivePermission[];
  token: string;
  requestId: string;
  /** Resolves an action id to the trace's anchor, or answers why it cannot (permission, nothing found). */
  traceAnchor: (actionId: string) => Promise<{ status: 'found' | 'empty' | 'denied'; rows: Rows; note: string | null }>;
  /** What the OTO App's own reader says this caller may see for one E.164 phone (`support-otoapp.ts`). */
  otoAppRecords: (phone: string) => Promise<{ status: SupportSectionStatus; rows: Rows; note: string | null; refusedByApp?: boolean }>;
}

export async function supportLookup(app: FastifyInstance, input: SupportLookupInput): Promise<SupportLookupAnswer> {
  const q = input.q.trim();
  const kinds = input.kind ? [input.kind] : detectQueryKinds(q);
  const caller: Caller = { app, token: input.token, requestId: input.requestId, seq: 0 };
  const sensitive = branchReach(input.effective, 'admin:audit:read_sensitive', input.operatorId).kind === 'operator';
  const shield = (rows: Rows): Rows => sensitive ? rows : rows.map(row => maskPersonal(row) as Record<string, unknown>);
  const branches = await liveBranches(app, input.operatorId);
  const enc = encodeURIComponent(q);
  const sections: SupportSection[] = [];

  for (const kind of kinds) {
    if (kind === 'phone') {
      const phone = normalizePhone(q);
      const member = outcomeOf(await get(caller, `/members/lookup?phone=${enc}`, 'GET /members/lookup'),
        body => isRecord(body) && isRecord(body.member) ? [body.member] : []);
      const memberIds = new Set(member.rows.map(row => row.id).filter((id): id is string => typeof id === 'string'));
      sections.push(section({ key: 'crm.member', app: 'crm', kind, label: 'Member and children', ...member,
        permission: 'pos:member:read', rows: shield(member.rows), masked: !sensitive && member.rows.length > 0 }));

      const stays = await perBranch(caller, branches, id => `/checkin/board?branchId=${id}`, 'GET /checkin/board',
        body => listAt(body, 'families').filter(f => (typeof f.memberId === 'string' && memberIds.has(f.memberId))
          || (phone !== null && f.guardianPhone === phone)));
      sections.push(section({ key: 'pos.checkins', app: 'pos', kind, label: 'Check-ins in the park today', ...stays,
        permission: 'pos:checkin:read', rows: shield(stays.rows), masked: !sensitive && stays.rows.length > 0 }));

      const sales = outcomeOf(await get(caller, `/sales/lookup?phone=${enc}`, 'GET /sales/lookup'), body => listAt(body, 'sales'));
      sections.push(section({ key: 'pos.sales', app: 'pos', kind, label: 'Sales and payments', ...sales, permission: 'pos:sale:read' }));

      const bookings = await perBranch(caller, branches, id => `/bookings?branchId=${id}&phone=${enc}`, 'GET /bookings',
        body => listAt(body, 'bookings'));
      sections.push(section({ key: 'pos.bookings', app: 'pos', kind, label: 'Bookings waiting at the counter', ...bookings,
        permission: 'pos:booking:read' }));

      const inbox = outcomeOf(await get(caller, `/inbox/conversations?phone=${enc}`, 'GET /inbox/conversations'),
        body => listAt(body, 'conversations'));
      sections.push(section({ key: 'inbox.conversations', app: 'inbox', kind, label: 'Inbox conversations', ...inbox,
        permission: 'inbox:conversation:read' }));

      const accounts = phone === null ? { status: 'empty' as const, rows: [], note: null }
        : outcomeOf(await get(caller, `/accounts?q=${encodeURIComponent(phone)}`, 'GET /accounts'),
          body => listAt(body, 'accounts').filter(a => a.phone === phone));
      sections.push(section({ key: 'platform.accounts', app: 'platform', kind, label: 'Staff sign-in accounts', ...accounts,
        permission: 'admin:account:read' }));

      const records = phone === null ? { status: 'empty' as const, rows: [], note: null, refusedByApp: false } : await input.otoAppRecords(phone);
      sections.push(section({ key: 'oto_app.records', app: 'oto_app', kind, label: 'OTO App records', status: records.status, note: records.note,
        // A person the app itself refused does hold the permission: what is missing is in the app's own sentence.
        permission: records.refusedByApp ? null : 'app:oto_app:access',
        rows: shield(records.rows).map(otoAppRow), masked: !sensitive && records.rows.length > 0 }));
    } else if (kind === 'band') {
      const sales = outcomeOf(await get(caller, `/sales/lookup?band=${enc}`, 'GET /sales/lookup'), body => listAt(body, 'sales'));
      sections.push(section({ key: 'pos.sales', app: 'pos', kind, label: 'Sales and payments', ...sales, permission: 'pos:sale:read' }));
      const wallet = outcomeOf(await get(caller, `/wallets/lookup?key=${enc}`, 'GET /wallets/lookup'), walletRows);
      sections.push(section({ key: 'pos.wallet', app: 'pos', kind, label: 'Wallet', ...wallet, permission: 'pos:wallet:read' }));
      const gate = await perBranch(caller, branches, id => `/branches/${id}/gate-events?band=${enc}`, 'GET /branches/:id/gate-events',
        body => listAt(body, 'events'), GATE_EVENTS_LIMIT);
      sections.push(section({ key: 'pos.gate_events', app: 'pos', kind, label: 'Gate events', ...gate, permission: 'pos:checkin:read',
        rows: gate.rows.map(gateRow) }));
    } else if (kind === 'receipt') {
      const sales = outcomeOf(await get(caller, `/sales/lookup?receipt=${enc}`, 'GET /sales/lookup'), body => listAt(body, 'sales'));
      sections.push(section({ key: 'pos.sales', app: 'pos', kind, label: 'Sales and payments', ...sales, permission: 'pos:sale:read' }));
    } else if (kind === 'booking') {
      const bookings = await perBranch(caller, branches, id => `/bookings/by-reference/${enc}?branchId=${id}`,
        'GET /bookings/by-reference/:reference', body => isRecord(body) ? [body] : []);
      sections.push(section({ key: 'pos.bookings', app: 'pos', kind, label: 'Booking', ...bookings, permission: 'pos:booking:read' }));
    } else if (kind === 'voucher') {
      const wallet = outcomeOf(await get(caller, `/wallets/lookup?key=${enc}`, 'GET /wallets/lookup'), walletRows);
      sections.push(section({ key: 'pos.wallet', app: 'pos', kind, label: 'Wallet voucher', ...wallet, permission: 'pos:wallet:read' }));
      // Never `GET /vouchers/lookup`: that one counts a wrong code against a till and can lock it.
      const promo = outcomeOf(await get(caller, `/vouchers/by-code?code=${enc}`, 'GET /vouchers/by-code'), body => listAt(body, 'vouchers'));
      sections.push(section({ key: 'pos.promo_voucher', app: 'pos', kind, label: 'Promotion voucher', ...promo, permission: 'admin:booth:read',
        rows: promo.rows.map(voucherRow), note: promo.status === 'empty' ? PROMO_CODES_NOT_SEARCHED : promo.note }));
    } else if (kind === 'account') {
      // The reader answers a page, newest sign-in first, with the total (SCRUM-793): the most one page holds, and a note when that is not all of them.
      const read = await get(caller, `/accounts/${q}/sessions?limit=${SESSION_PAGE_MAX}`, 'GET /accounts/:id/sessions');
      const sessions = outcomeOf(read, body => listAt(body, 'sessions'));
      const total = read.status === 200 && isRecord(read.body) && typeof read.body.total === 'number' ? read.body.total : sessions.rows.length;
      sections.push(section({ key: 'platform.account_sessions', app: 'platform', kind, label: 'Account sessions', ...sessions,
        permission: 'admin:account:read', rows: sessions.rows.map(sessionRow),
        note: total > sessions.rows.length ? `Showing the newest ${sessions.rows.length} of ${total}.` : sessions.note }));
      const grants = outcomeOf(await get(caller, `/accounts/${q}/permissions`, 'GET /accounts/:id/permissions'), body => listAt(body, 'assignments'));
      sections.push(section({ key: 'platform.account_roles', app: 'platform', kind, label: 'Roles held', ...grants,
        permission: 'admin:role:read' }));
      const identities = outcomeOf(await get(caller, `/admin/apps/users/${q}`, 'GET /admin/apps/users/:accountId'),
        body => listAt(body, 'identities'));
      sections.push(section({ key: 'oto_app.identity', app: 'oto_app', kind, label: 'App identities (OTO App and others)', ...identities,
        permission: 'admin:role:read' }));
    } else {
      const anchor = await input.traceAnchor(q);
      sections.push(section({ key: 'platform.trace', app: 'platform', kind, label: 'Action trace', ...anchor,
        permission: 'console:support:trace' }));
    }
  }

  return { generatedAt: new Date().toISOString(), kinds, detected: !input.kind,
    masked: !sensitive && sections.some(s => s.masked), sections };
}

/** A wallet answer as one row: the wallet with how many ledger entries it carries. */
function walletRows(body: unknown): Rows {
  if (!isRecord(body) || !isRecord(body.wallet)) return [];
  return [{ ...body.wallet, ledgerEntries: Array.isArray(body.ledger) ? body.ledger.length : 0 }];
}

async function liveBranches(app: FastifyInstance, operatorId: string) {
  return app.db.select({ id: branch.id, name: branch.name }).from(branch)
    .where(and(eq(branch.operatorId, operatorId), isNull(branch.archivedAt))).orderBy(asc(branch.name));
}

/**
 * The data_access row: which kinds were searched and which sections answered
 * with how many rows. Never the searched value and never a returned one.
 */
export async function recordSupportRead(db: Db, ctx: OpContext & { requestId: string; actorAccountId: string },
  input: { action: 'console.support.lookup' | 'console.support.trace'; after: Record<string, unknown>; branchId?: string | null }) {
  await withTx(db, ctx, input.action, async tx => {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId, operatorId: ctx.operatorId ?? null, branchId: input.branchId ?? null,
      action: input.action, entityType: 'data_access', entityId: ctx.requestId, requestId: ctx.requestId,
      after: { category: 'data_access', ...input.after }, targetApp: 'console', origin: 'console',
    });
  });
}

export const SUPPORT_LOOKUP_PERMISSION: Permission = 'console:support:lookup';

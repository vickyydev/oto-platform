import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { branch, type Db } from '@oto/db';
import { normalizePhone, parseBandCode, parseBandShortCode, type Permission } from '@oto/shared';
import { audit } from './audit';
import { maskPersonal } from './audit-mask';
import { branchReach } from './access-control';
import { callPlatform, type GetRouteTemplate, type PlatformResponse } from './assistant/call-platform';
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
 * all apply exactly as they do on the screen that owns them. A section the
 * caller may not read answers `denied` (never silently missing); one whose
 * domain has no safe reader for this kind of key answers `not_built` and says
 * why; an app that failed answers `unavailable`. Member and child records are
 * additionally passed through the audit read's mask unless the caller holds
 * `admin:audit:read_sensitive` operator-wide.
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
  /** The permission the owning route asks for; null where no route was called. */
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

/** One call per live park, for the readers that answer one park at a time. */
async function perBranch(caller: Caller, branches: readonly { id: string; name: string }[],
  urlOf: (branchId: string) => string, route: GetRouteTemplate, rowsOf: (body: unknown) => Rows): Promise<Outcome> {
  const answers = await Promise.all(branches.map(async b => ({ b, out: outcomeOf(await get(caller, urlOf(b.id), route), rowsOf) })));
  const rows = answers.flatMap(({ b, out }) => out.rows.map(row => ({ ...row, park: b.name })));
  const denied = answers.filter(a => a.out.status === 'denied').map(a => a.b.name);
  const failed = answers.filter(a => a.out.status === 'unavailable').map(a => a.b.name);
  const notes = [
    ...(denied.length > 0 ? [`Not readable at ${denied.join(', ')}.`] : []),
    ...(failed.length > 0 ? [`Could not be read at ${failed.join(', ')}.`] : []),
  ];
  const status: SupportSectionStatus = rows.length > 0 ? 'found'
    : denied.length === answers.length && answers.length > 0 ? 'denied'
      : failed.length > 0 ? 'unavailable' : 'empty';
  return { status, rows, note: notes.length > 0 ? notes.join(' ') : null };
}

function section(input: Omit<SupportSection, 'rowCount' | 'masked'> & { masked?: boolean }): SupportSection {
  return { ...input, masked: input.masked ?? false, rowCount: input.rows.length };
}

function notBuilt(key: string, app: SupportSectionApp, kind: SupportQueryKind, label: string, note: string): SupportSection {
  return section({ key, app, kind, label, status: 'not_built', permission: null, rows: [], note });
}

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

      sections.push(notBuilt('oto_app.records', 'oto_app', kind, 'OTO App records',
        'The OTO App offers no reader that finds a person, an event or a check-in by phone. Search the staff account id to see its OTO App identity.'));
    } else if (kind === 'band') {
      const sales = outcomeOf(await get(caller, `/sales/lookup?band=${enc}`, 'GET /sales/lookup'), body => listAt(body, 'sales'));
      sections.push(section({ key: 'pos.sales', app: 'pos', kind, label: 'Sales and payments', ...sales, permission: 'pos:sale:read' }));
      const wallet = outcomeOf(await get(caller, `/wallets/lookup?key=${enc}`, 'GET /wallets/lookup'), walletRows);
      sections.push(section({ key: 'pos.wallet', app: 'pos', kind, label: 'Wallet', ...wallet, permission: 'pos:wallet:read' }));
      sections.push(notBuilt('pos.gate_events', 'pos', kind, 'Gate events',
        'No reader lists one band’s gate entries and exits yet; its sale and wallet are shown above.'));
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
      sections.push(notBuilt('pos.promo_voucher', 'pos', kind, 'Promotion voucher',
        'The only voucher-code reader records every miss against the till and can lock it out, so the support lookup does not call it.'));
    } else if (kind === 'account') {
      const sessions = outcomeOf(await get(caller, `/accounts/${q}/sessions`, 'GET /accounts/:id/sessions'), body => listAt(body, 'sessions'));
      sections.push(section({ key: 'platform.account_sessions', app: 'platform', kind, label: 'Account sessions', ...sessions,
        permission: 'admin:account:read' }));
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

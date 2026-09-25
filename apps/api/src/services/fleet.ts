import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  account,
  box,
  boxCommand,
  boxHeartbeat,
  branch,
  device,
  deviceCredential,
  employee,
  session as sessionTable,
  station,
  stationDevice,
  stationStaff,
  BOX_COMMAND_KINDS,
  type BoxCommandKind,
  type BoxRole,
  type BoxStatus,
  type Db,
  type DeviceCredentialKind,
  type DeviceKind,
  type DeviceTransport,
  type StationAccessScope,
  type StationCapability,
  type StationDeviceRole,
  type StationKind,
} from '@oto/db';
import {
  SIMULATOR_ACTIONS_WITH_SECRETS,
  SimulatorActionSchema,
  newId,
  type DeviceSettings,
} from '@oto/shared';
import { TerminalCommandPayloadSchema } from '@oto/box-agent';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { holdsGrantAt } from './access-control';
import { resolveEffectivePermissions } from './permissions';
import { audit } from './audit';
import { BOOTH_CODE_PREFIX_RULE, isBoothCodePrefix } from './booth-admin';
import { boxSettings, issueClaimCode, mintClaimCode, normaliseClaimCode, sha256Hex } from './box';
import { atBranch } from '../lib/staff-scope';
import { mintStaffToken, staffTokenSettings, type MintedStaffToken } from './staff-token';
import { withTx, type Exec, type OpContext } from './tx';
import type { Env } from '../env';

/**
 * The ordinary HTTP surface of the fleet (S2-04): the estate an administrator
 * configures, and the one question a member of staff asks of it.
 *
 * `services/box.ts` is the other half — what a box says to the cloud, carrying
 * a machine credential. This file is everything a PERSON does: register a box,
 * declare the devices bolted to it, build a station out of the two, say who may
 * work at it, and — the only route here that is not administrative — list the
 * stations the caller may actually take.
 *
 * **The rule the whole ticket exists for lives in `listPickableStations` and
 * `pickStation`, and nowhere else.** A station whose `access_scope` is
 * `selected_staff` and whose `station_staff` list does not name this account is
 * ABSENT from the picker — not greyed out, not returned with a flag, not
 * refused on press. Somebody who cannot use a till should not be standing in
 * front of it wondering why it says no. The refusal on a direct pick by id
 * still exists beside it, because a list that hides something is not a
 * permission check; the two share a predicate, never an implementation, so a
 * later change to the list cannot quietly widen the check.
 *
 * **Every route keyed by a child id resolves its own scope.** The permission
 * guard defaults an unstated branch to the caller's session
 * (`plugins/session.ts`), so `PATCH /stations/:id` declared with a plain
 * permission would check the caller's branch and then edit whatever station the
 * id names — a branch manager editing another branch's till. Hence the `load…`
 * helpers below: they read the row inside the caller's operator, and the route
 * then asks for the permission AT THAT ROW'S BRANCH.
 */

// --- What the API answers with ----------------------------------------------

/**
 * One tile in the station picker, and deliberately less than a `Station`.
 *
 * The picker is drawn before a station is taken. An iPad on the counter has no
 * business holding another till's payment routing or its staff list in order to
 * draw a tile, so this carries the name, the box's health — a till whose box is
 * not answering prints nothing, and the person about to stand at it should know
 * that before the first sale — and nothing else.
 */
export interface PickableStation {
  id: string;
  name: string;
  kind: StationKind;
  accessScope: StationAccessScope;
  boxId: string | null;
  boxName: string | null;
  boxStatus: BoxStatus | null;
  deviceCount: number;
}

/**
 * A device doing a job for a station, denormalised.
 *
 * The label, kind, transport and address are copied onto the assignment rather
 * than nested under a device object because the POS builds its station profile
 * straight off this list (`apps/pos/src/station/fleet.ts`) and would otherwise
 * need a second request to draw a till it has just picked.
 */
export interface StationDeviceView {
  role: StationDeviceRole;
  deviceId: string;
  label: string;
  kind: DeviceKind;
  transport: DeviceTransport;
  address: string | null;
}

export interface StationView {
  id: string;
  branchId: string;
  name: string;
  kind: StationKind;
  codePrefix: string | null;
  boxId: string | null;
  boxName: string | null;
  boxStatus: BoxStatus | null;
  capabilities: StationCapability[];
  accessScope: StationAccessScope;
  configVersion: number;
  paymentRouting: Record<string, unknown> | null;
  offlineWalletCapSatang: number | null;
  devices: StationDeviceView[];
  /** Empty unless the scope is `selected_staff` — there is no list to show otherwise. */
  staff: Array<{ accountId: string; name: string | null }>;
  lastSeenAt: string | null;
  archived: boolean;
}

export interface BoxView {
  id: string;
  branchId: string;
  name: string;
  slot: string;
  role: BoxRole;
  status: BoxStatus;
  hostname: string | null;
  agentVersion: string | null;
  currentEpoch: number;
  registeredAt: string | null;
  lastHeartbeatAt: string | null;
  /**
   * Computed here rather than in the browser: both front ends want "how long
   * has this box been quiet" and a clock skew on the machine reading the page
   * would answer it differently on every desk.
   */
  heartbeatAgeSeconds: number | null;
  lastStatus: Record<string, unknown> | null;
  deviceCount: number;
  stationCount: number;
  claimCodeOutstanding: boolean;
  claimCodeExpiresAt: string | null;
  archived: boolean;
}

export interface DeviceView {
  id: string;
  boxId: string;
  kind: DeviceKind;
  label: string;
  transport: DeviceTransport;
  address: string | null;
  model: string | null;
  protocol: string | null;
  reachability: string;
  paperStatus: string;
  serialNumber: string | null;
  terminalId: string | null;
  merchantId: string | null;
  /**
   * The unit's own facts (S2-06) — an ESC/POS printer's 576 or 512 dots per
   * line as its self-test page says. Null means the model's profile stands.
   */
  settings: DeviceSettings | null;
  lastError: string | null;
  lastSeenAt: string | null;
  archived: boolean;
}

export interface CredentialView {
  id: string;
  kind: DeviceCredentialKind;
  stationId: string | null;
  boxId: string | null;
  label: string | null;
  pairingOutstanding: boolean;
  pairingCodeExpiresAt: string | null;
  pairedAt: string | null;
  pairedByAccountId: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  scopes: string[];
}

/** Somebody who may be put on a station's list: the staff of that branch. */
export interface StaffCandidate {
  accountId: string;
  name: string | null;
  phone: string;
  status: 'active' | 'invited';
}

export interface BoxCommandView {
  id: string;
  kind: BoxCommandKind;
  state: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  actionId: string | null;
  requestedByAccountId: string | null;
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BoxHeartbeatView {
  id: string;
  receivedAt: string;
  reportedAt: string | null;
  clockOffsetMs: number | null;
  agentVersion: string | null;
  uptimeS: number | null;
  tempC: number | null;
  outboxDepth: number | null;
}

export interface StationWriteInput {
  name: string;
  kind: StationKind;
  boxId: string | null;
  codePrefix?: string | null;
  capabilities: StationCapability[];
  accessScope: StationAccessScope;
  /** The WHOLE list, never a delta. */
  staffAccountIds: string[];
  /** The WHOLE set, never a delta. */
  devices: Array<{ role: StationDeviceRole; deviceId: string }>;
  paymentRouting?: Record<string, unknown> | null;
  offlineWalletCapSatang?: number | null;
}

// --- Vocabulary the service enforces ----------------------------------------

/**
 * Which kinds of device can take each job.
 *
 * A kitchen ticket and a bar ticket both come off an 80 mm receipt printer at
 * the park (DEVICE_INVENTORY §2), so those two roles accept a plain receipt
 * printer as well as a dedicated one. Everything else is exact: a band comes
 * off a band printer or it does not come off at all. The Console holds the same
 * table client-side to grey out the impossible choices; this is the one that
 * decides, because a client-side table is a hint.
 */
const ROLE_ACCEPTS: Record<StationDeviceRole, DeviceKind[]> = {
  receipt: ['receipt_printer'],
  kids_band: ['band_printer'],
  adult_band: ['band_printer'],
  kitchen: ['kitchen_printer', 'receipt_printer'],
  bar: ['bar_printer', 'receipt_printer'],
  scanner: ['scanner'],
  card_terminal: ['terminal'],
  qr_terminal: ['terminal'],
  gate: ['gate', 'gate_reader'],
  cash_drawer: ['cash_drawer'],
};

/**
 * A unique violation on one of the fleet's partial indexes, as the business
 * conflict it is.
 *
 * Read from the constraint rather than pre-checked: two administrators naming
 * two tills "Reception Till 2" at the same moment both pass a pre-check and one
 * of them still has to be told. The value is never echoed back — the caller
 * knows what it sent, and Postgres puts it somewhere we do not repeat.
 */
const FLEET_CONFLICTS: Record<string, { code: string; message: string }> = {
  station_name_unique: {
    code: 'STATION_NAME_TAKEN',
    message: 'A live station at this branch already has that name',
  },
  station_code_prefix_unique: {
    code: 'STATION_CODE_PREFIX_TAKEN',
    message: 'A live station at this branch already uses that code prefix',
  },
  box_slot_unique: {
    code: 'BOX_SLOT_TAKEN',
    message: 'A live box already occupies that slot at this branch',
  },
  device_address_unique: {
    code: 'DEVICE_ADDRESS_TAKEN',
    message: 'This box already has a device at that address',
  },
};

function rethrowFleetConflict(err: unknown): never {
  // Unwrapped: Drizzle raises its own error with the database's as `cause`.
  const pg = pgErrorOf(err);
  if (pg && pg.code === '23505' && typeof pg.constraint === 'string') {
    const known = FLEET_CONFLICTS[pg.constraint];
    if (known) throw new AppError(409, known.code, known.message, { constraint: pg.constraint });
  }
  throw err;
}

/**
 * A booth's code prefix, checked on the station AS IT WILL STAND (H2).
 *
 * A booth's box mints every voucher code from this prefix and cannot mint
 * one from a prefix that is not two letters or digits, so such a booth
 * refuses every press. Lower case is refused too, although the box would
 * upper-case it and print: the reason is the "Capitals only" note beside
 * `BOOTH_CODE_PREFIX_RULE` in `services/booth-admin.ts`, the rule this
 * checks. The caller passes the kind and prefix the row will have
 * after the write, not only the fields in the request: a till saved with `T10`
 * and then switched to kind `booth` by a PATCH naming only the kind is as
 * dead a booth as a new one with the field left empty.
 *
 * Every other kind keeps the looser rule the route declares, one to eight
 * characters or none: a till's prefix is the series its receipt numbers are
 * issued under (`services/sale.ts`), and nothing prints it as a booth code.
 */
function assertStationCodePrefix(kind: StationKind, codePrefix: string | null): void {
  if (kind === 'booth' && !isBoothCodePrefix(codePrefix)) {
    throw new AppError(400, 'BOOTH_CODE_PREFIX_INVALID', BOOTH_CODE_PREFIX_RULE, {
      field: 'codePrefix',
    });
  }
}

/**
 * A booth's code prefix is unique across the OPERATOR, not only its branch
 * (closing audit L15, SCRUM-414).
 *
 * The prefix is the code space a booth's box mints from, so two live booths
 * with one prefix — "B1" at each park — mint from one space and clash about
 * three times a decade, with the second family's slip redeeming as the first
 * voucher. The database's `station_code_prefix_unique` is per branch; this is
 * the operator-wide rule, checked on the station as it will stand after the
 * write, and it names the booth holding the prefix so an administrator can
 * pick another without a search. Booths only: a till's prefix is the series
 * its receipt numbers are issued under and never reaches a voucher.
 *
 * Pre-checked rather than read from a constraint — the opposite of
 * `FLEET_CONFLICTS` — because the other booth's name is the point of the
 * message, and a constraint cannot carry it. Two administrators creating two
 * booths with one prefix at two branches in the same instant would both pass;
 * the cloud's collision quarantine (`services/sync-booth.ts`) still stands
 * behind that.
 */
async function assertBoothCodePrefixFree(
  db: Db,
  input: {
    operatorId: string;
    kind: StationKind;
    codePrefix: string | null;
    /** The station being edited, which does not count against itself. */
    exceptStationId?: string;
  },
): Promise<void> {
  if (input.kind !== 'booth' || !input.codePrefix) return;
  const [other] = await db
    .select({ id: station.id, name: station.name, branchName: branch.name })
    .from(station)
    .innerJoin(branch, eq(branch.id, station.branchId))
    .where(
      and(
        eq(station.operatorId, input.operatorId),
        eq(station.kind, 'booth'),
        eq(station.codePrefix, input.codePrefix),
        isNull(station.archivedAt),
        ...(input.exceptStationId ? [ne(station.id, input.exceptStationId)] : []),
      ),
    )
    .limit(1);
  if (other) {
    throw new AppError(
      409,
      'BOOTH_CODE_PREFIX_TAKEN',
      `Code prefix ${input.codePrefix} is already used by ${other.name} at ${other.branchName}. Every booth needs a prefix of its own, because it starts every voucher code the booth prints.`,
      {
        field: 'codePrefix',
        stationId: other.id,
        stationName: other.name,
        branchName: other.branchName,
      },
    );
  }
}

// --- Loading a row, scoped, before anybody is allowed to touch it -----------

export async function loadBranchForOperator(
  db: Db,
  operatorId: string,
  branchId: string,
): Promise<typeof branch.$inferSelect> {
  const [row] = await db
    .select()
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw new AppError(404, 'BRANCH_NOT_FOUND', 'No such branch');
  return row;
}

/**
 * Every by-id loader is scoped to the caller's operator, so an id belonging to
 * another tenant is "not found" rather than "not allowed" — the shape of a
 * refusal must not confirm that somebody else's id exists. Within one operator
 * the row is found first and the permission asked for afterwards, because the
 * branch to ask about is on the row; that is the trade the route comment names.
 */
export async function loadStation(
  db: Db,
  operatorId: string,
  id: string,
): Promise<typeof station.$inferSelect> {
  const [row] = await db
    .select()
    .from(station)
    .where(and(eq(station.id, id), eq(station.operatorId, operatorId)))
    .limit(1);
  if (!row) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
  return row;
}

export async function loadBox(
  db: Db,
  operatorId: string,
  id: string,
): Promise<typeof box.$inferSelect> {
  const [row] = await db
    .select()
    .from(box)
    .where(and(eq(box.id, id), eq(box.operatorId, operatorId)))
    .limit(1);
  if (!row) throw new AppError(404, 'BOX_NOT_FOUND', 'No such box');
  return row;
}

export async function loadDevice(
  db: Db,
  operatorId: string,
  id: string,
): Promise<typeof device.$inferSelect> {
  const [row] = await db
    .select()
    .from(device)
    .where(and(eq(device.id, id), eq(device.operatorId, operatorId)))
    .limit(1);
  if (!row) throw new AppError(404, 'DEVICE_NOT_FOUND', 'No such device');
  return row;
}

export async function loadCredential(
  db: Db,
  operatorId: string,
  id: string,
): Promise<typeof deviceCredential.$inferSelect> {
  const [row] = await db
    .select()
    .from(deviceCredential)
    .where(and(eq(deviceCredential.id, id), eq(deviceCredential.operatorId, operatorId)))
    .limit(1);
  if (!row) throw new AppError(404, 'CREDENTIAL_NOT_FOUND', 'No such credential');
  return row;
}

// --- The picker: the only place the visibility rule lives -------------------

/**
 * The stations this account may work, at the branch its session is on.
 *
 * Three filters, and each is load-bearing:
 *
 *   - the operator, as every tenant-scoped query in this API carries, even
 *     where the branch already implies it;
 *   - the branch, which the caller never names: the route passes the session's,
 *     and passes null unless the caller holds a grant there (SCRUM-264), so
 *     this list cannot be aimed at a branch somebody does not work at;
 *   - the access scope, which is the rule itself.
 *
 * Archived stations are excluded unconditionally. There is no `includeArchived`
 * on this route and there must not be one: a till taken off the floor is not a
 * till somebody can stand at.
 *
 * `station_branch_live_idx` serves the first two and `station_staff_account_idx`
 * the third — the latter was created in migration 0009 for exactly this query.
 */
export async function listPickableStations(
  db: Db,
  ctx: { operatorId: string; branchId: string | null; accountId: string },
): Promise<PickableStation[]> {
  /**
   * A platform-wide account that has not picked a branch yet. An empty list is
   * the honest answer — there is no branch to have stations at — and the
   * picker already draws the right empty state for it. Not a 400: the caller
   * did nothing wrong.
   */
  if (!ctx.branchId) return [];

  const deviceCount = sql<number>`(
    select count(*)::int from core.station_device sd
      join core.device d on d.id = sd.device_id
     where sd.station_id = ${station.id} and d.archived_at is null
  )`;

  const rows = await db
    .select({
      id: station.id,
      name: station.name,
      kind: station.kind,
      accessScope: station.accessScope,
      boxId: station.boxId,
      boxName: box.name,
      boxStatus: box.status,
      deviceCount,
    })
    .from(station)
    .leftJoin(box, eq(station.boxId, box.id))
    .where(
      and(
        eq(station.operatorId, ctx.operatorId),
        eq(station.branchId, ctx.branchId),
        isNull(station.archivedAt),
        visibleToAccount(ctx.accountId),
      ),
    )
    .orderBy(asc(station.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    accessScope: r.accessScope,
    boxId: r.boxId,
    boxName: r.boxName ?? null,
    boxStatus: r.boxStatus ?? null,
    deviceCount: Number(r.deviceCount ?? 0),
  }));
}

/**
 * The predicate the list and the by-id check share — genuinely share: it is
 * this expression that both `listPickableStations` and `pickStation` put in
 * their WHERE, not two readings of one rule.
 *
 * Open to everybody at the branch, or named on this station's list. Written
 * once so the two can never drift: a hand-rolled second copy in the picker
 * would hide a station the by-id path still allowed the moment either moved.
 */
function visibleToAccount(accountId: string) {
  return or(
    eq(station.accessScope, 'all_staff'),
    sql`exists (
      select 1 from core.station_staff ss
       where ss.station_id = ${station.id} and ss.account_id = ${accountId}
    )`,
  );
}

/**
 * Take a station for this session.
 *
 * Four checks, four answers, and the statuses are chosen for what the till
 * already does with them: `StationContext` forgets the station this iPad
 * remembers on a 403 or a 404 and keeps working on anything else, so a wrong
 * branch answered 409 would leave a till quietly serving a station at another
 * site. The codes carry the difference; the statuses keep the client correct.
 */
export interface PickedStation {
  station: StationView;
  /**
   * The shift token, when this deployment can mint one (S2-06).
   *
   * Handed back HERE rather than fetched afterwards because the pick is the
   * moment the ticket names, and because a till that has to make a second call
   * for it is a till that might not: the one time the token matters is the one
   * time the second call would have failed.
   *
   * Null when `STAFF_TOKEN_PRIVATE_KEY` is unset — the pick still succeeds and
   * the till works, it simply cannot unlock without the internet, and the
   * reason is on the response rather than in a log.
   */
  staffToken: { token: string; jti: string; expiresAt: string } | null;
  staffTokenUnavailable: string | null;
}

export async function pickStation(
  db: Db,
  ctx: OpContext,
  auth: { accountId: string; operatorId: string; branchId: string | null; sessionId: string; stationId: string | null },
  stationId: string,
  env?: Env,
): Promise<PickedStation> {
  const [row] = await db
    .select()
    .from(station)
    .where(
      and(
        eq(station.id, stationId),
        eq(station.operatorId, auth.operatorId),
        isNull(station.archivedAt),
      ),
    )
    .limit(1);
  /**
   * Archived is folded into "not found" deliberately. To a caller who cannot
   * see the estate, "this till was taken off the floor" and "there is no such
   * till" are the same fact, and telling the two apart is telling somebody
   * which station ids exist.
   */
  if (!row) throw new AppError(404, 'STATION_NOT_FOUND', 'No such station');
  /**
   * SCRUM-264 — A GRANT AT THIS STATION'S BRANCH, BEFORE ANYTHING ELSE.
   *
   * The three checks below say: it exists in your operator, it is at the branch
   * your session is on, and you are on its list. None of them is a permission,
   * and the second is not the check it reads as — `PUT /me/session/branch` put
   * the session's branch wherever the caller asked. So reception at Central
   * Floresta moved their session to Robinson Chalong and took its till: the
   * station was in the operator, it matched the session's branch, and its
   * access scope was `all_staff`, which admitted them.
   *
   * `all_staff` means all staff OF THAT BRANCH, and that sentence has to be
   * enforced somewhere. Here, from grants, before the access list is consulted:
   * the list says which of a branch's staff may work a station, never who is
   * staff there.
   *
   * Asked of the STATION's branch, not the session's, so it holds for a session
   * that was seated before this rule existed — every live session today carries
   * whatever the old sign-in put on it.
   */
  const effective = await resolveEffectivePermissions(db, auth.accountId);
  if (!holdsGrantAt(effective, auth.operatorId, row.branchId)) {
    throw new AppError(
      403,
      'STATION_OTHER_BRANCH',
      'That station is at a branch you do not work at',
    );
  }
  if (!auth.branchId || row.branchId !== auth.branchId) {
    throw new AppError(
      403,
      'STATION_WRONG_BRANCH',
      'That station is at another branch — switch branch first',
    );
  }
  /**
   * The same predicate the picker filters on, asked about this one row rather
   * than re-implemented. Asked SEPARATELY from the load above, and not folded
   * into its WHERE, because the two refusals are not the same fact: a station
   * that does not exist is a 404, and a station somebody may not work is a
   * 403 `STATION_NOT_YOURS` — which is what the till reads to say where the
   * station it remembered went.
   */
  const [visible] = await db
    .select({ id: station.id })
    .from(station)
    .where(and(eq(station.id, row.id), visibleToAccount(auth.accountId)))
    .limit(1);
  if (!visible) {
    throw new AppError(403, 'STATION_NOT_YOURS', 'You are not on this station’s list');
  }

  let minted: MintedStaffToken | null = null;
  let unavailable: string | null = null;
  await withTx(db, ctx, 'session.station_pick', async (tx) => {
    await tx
      .update(sessionTable)
      .set({ stationId: row.id })
      .where(eq(sessionTable.id, auth.sessionId));

    /**
     * The shift token, minted inside the same transaction as the pick.
     *
     * Together or not at all: a session that is standing at a station with no
     * token would be a till that cannot unlock offline and has no way to
     * notice, and a token for a pick that rolled back would be a credential
     * for a station nobody took.
     */
    if (env && staffTokenSettings(env)) {
      minted = await mintStaffToken(
        tx,
        {
          accountId: auth.accountId,
          sessionId: auth.sessionId,
          operatorId: auth.operatorId,
          branchId: row.branchId,
          stationId: row.id,
          requestId: ctx.requestId,
        },
        env,
      );
    } else if (env) {
      unavailable =
        'This deployment has no staff-token key (STAFF_TOKEN_PRIVATE_KEY), so this till cannot be unlocked without the internet.';
    }
    /**
     * Audited even though it changes no business record: the session row is
     * overwritten in place, so "who was standing at Till 1 at 14:40" has no
     * other answer six months later.
     */
    await audit.record(tx, {
      actorAccountId: auth.accountId,
      operatorId: auth.operatorId,
      branchId: row.branchId,
      action: 'session.station_pick',
      entityType: 'station',
      entityId: row.id,
      before: { stationId: auth.stationId },
      after: { stationId: row.id, sessionId: auth.sessionId },
      requestId: ctx.requestId,
    });
  });

  /**
   * `staff: []`, always. The answer to a pick goes to the iPad that just took
   * the station, and who else may take it is the administrator's business.
   */
  const [view] = await stationViews(db, [row], { withStaff: false });
  const token = minted as MintedStaffToken | null;
  return {
    station: view!,
    staffToken: token
      ? { token: token.token, jti: token.jti, expiresAt: token.expiresAt.toISOString() }
      : null,
    staffTokenUnavailable: unavailable,
  };
}

// --- Assembling a station for the admin screens -----------------------------

/**
 * Turn station rows into what both front ends read, in three queries however
 * many stations there are — the Devices page lists a whole branch.
 */
async function stationViews(
  exec: Exec,
  rows: Array<typeof station.$inferSelect>,
  opts: { withStaff: boolean },
): Promise<StationView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const boxIds = [...new Set(rows.map((r) => r.boxId).filter((v): v is string => v !== null))];
  const boxes = boxIds.length
    ? await exec
        .select({ id: box.id, name: box.name, status: box.status })
        .from(box)
        .where(inArray(box.id, boxIds))
    : [];
  const boxById = new Map(boxes.map((b) => [b.id, b]));

  const assignments = await exec
    .select({
      stationId: stationDevice.stationId,
      role: stationDevice.role,
      deviceId: device.id,
      label: device.label,
      kind: device.kind,
      transport: device.transport,
      address: device.address,
    })
    .from(stationDevice)
    .innerJoin(device, eq(stationDevice.deviceId, device.id))
    .where(and(inArray(stationDevice.stationId, ids), isNull(device.archivedAt)))
    .orderBy(asc(stationDevice.role));
  const devicesByStation = new Map<string, StationDeviceView[]>();
  for (const a of assignments) {
    const list = devicesByStation.get(a.stationId) ?? [];
    list.push({
      role: a.role,
      deviceId: a.deviceId,
      label: a.label,
      kind: a.kind,
      transport: a.transport,
      address: a.address,
    });
    devicesByStation.set(a.stationId, list);
  }

  const staffByStation = new Map<string, Array<{ accountId: string; name: string | null }>>();
  if (opts.withStaff) {
    const staff = await exec
      .select({
        stationId: stationStaff.stationId,
        accountId: stationStaff.accountId,
        name: employee.name,
      })
      .from(stationStaff)
      .innerJoin(account, eq(stationStaff.accountId, account.id))
      .leftJoin(employee, eq(account.employeeId, employee.id))
      .where(inArray(stationStaff.stationId, ids))
      .orderBy(asc(stationStaff.addedAt));
    for (const s of staff) {
      const list = staffByStation.get(s.stationId) ?? [];
      list.push({ accountId: s.accountId, name: s.name ?? null });
      staffByStation.set(s.stationId, list);
    }
  }

  return rows.map((r) => {
    const b = r.boxId ? boxById.get(r.boxId) : undefined;
    return {
      id: r.id,
      branchId: r.branchId,
      name: r.name,
      kind: r.kind,
      codePrefix: r.codePrefix,
      boxId: r.boxId,
      boxName: b?.name ?? null,
      boxStatus: b?.status ?? null,
      capabilities: (r.capabilities ?? []) as StationCapability[],
      accessScope: r.accessScope,
      configVersion: r.configVersion,
      paymentRouting: (r.paymentRouting ?? null) as Record<string, unknown> | null,
      offlineWalletCapSatang: r.offlineWalletCapSatang,
      devices: devicesByStation.get(r.id) ?? [],
      staff: staffByStation.get(r.id) ?? [],
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      archived: r.archivedAt !== null,
    };
  });
}

export async function listStations(
  db: Db,
  ctx: { operatorId: string; branchId: string; includeArchived: boolean },
): Promise<StationView[]> {
  const rows = await db
    .select()
    .from(station)
    .where(
      and(
        eq(station.operatorId, ctx.operatorId),
        eq(station.branchId, ctx.branchId),
        ctx.includeArchived ? undefined : isNull(station.archivedAt),
      ),
    )
    .orderBy(asc(station.name));
  return stationViews(db, rows, { withStaff: true });
}

export async function getStationView(
  db: Db,
  row: typeof station.$inferSelect,
): Promise<StationView> {
  const [view] = await stationViews(db, [row], { withStaff: true });
  return view!;
}

// --- Writing a station ------------------------------------------------------

export async function listBranchStaff(
  db: Db,
  operatorId: string,
  branchId: string,
): Promise<StaffCandidate[]> {
  const rows = await db
    .select({
      accountId: account.id,
      name: employee.name,
      phone: account.phone,
      status: account.status,
    })
    .from(account)
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(and(eq(account.operatorId, operatorId), atBranch(branchId)))
    .orderBy(asc(account.phone));
  return rows.map((r) => ({
    accountId: r.accountId,
    name: r.name ?? null,
    phone: r.phone,
    status: r.status === 'inactive' ? 'invited' : r.status,
  }));
}

/**
 * Everything a station write has to be true for, checked once, before anything
 * is written.
 *
 * The device rule is the one that has never been enforced anywhere: nothing
 * ties `station_device` to the station's box, so a device on another branch's
 * box could be assigned, the Console would show a printer, and the till would
 * print nothing — because `configBundle` filters the cross-box assignment out
 * rather than refusing it. That filter stays as the last line of defence; this
 * is the line that tells somebody.
 */
async function validateStationWrite(
  db: Db,
  input: {
    operatorId: string;
    branchId: string;
    boxId: string | null;
    devices: Array<{ role: StationDeviceRole; deviceId: string }>;
    staffAccountIds: string[];
  },
): Promise<void> {
  if (input.devices.length > 0 && !input.boxId) {
    throw new AppError(
      400,
      'STATION_NEEDS_BOX',
      'Assign the box before the devices — a device is reachable through the box it is plugged into',
    );
  }

  if (input.boxId) {
    const [b] = await db
      .select({ id: box.id, branchId: box.branchId })
      .from(box)
      .where(
        and(eq(box.id, input.boxId), eq(box.operatorId, input.operatorId), isNull(box.archivedAt)),
      )
      .limit(1);
    if (!b || b.branchId !== input.branchId) {
      throw new AppError(404, 'BOX_NOT_FOUND', 'No such box at this branch');
    }
  }

  if (input.devices.length > 0) {
    const ids = [...new Set(input.devices.map((d) => d.deviceId))];
    const rows = await db
      .select({ id: device.id, kind: device.kind, boxId: device.boxId })
      .from(device)
      .where(
        and(
          inArray(device.id, ids),
          eq(device.operatorId, input.operatorId),
          isNull(device.archivedAt),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const assignment of input.devices) {
      const row = byId.get(assignment.deviceId);
      if (!row || row.boxId !== input.boxId) {
        throw new AppError(
          400,
          'DEVICE_NOT_ON_BOX',
          'That device is not on this station’s box',
          { deviceId: assignment.deviceId, role: assignment.role },
        );
      }
      if (!ROLE_ACCEPTS[assignment.role].includes(row.kind)) {
        throw new AppError(
          400,
          'DEVICE_ROLE_MISMATCH',
          `A ${row.kind.replace(/_/g, ' ')} cannot take the ${assignment.role.replace(/_/g, ' ')} job`,
          { deviceId: assignment.deviceId, role: assignment.role, kind: row.kind },
        );
      }
    }
  }

  if (input.staffAccountIds.length > 0) {
    const ids = [...new Set(input.staffAccountIds)];
    const rows = await db
      .select({ id: account.id })
      .from(account)
      .leftJoin(employee, eq(account.employeeId, employee.id))
      .where(
        and(
          inArray(account.id, ids),
          eq(account.operatorId, input.operatorId),
          atBranch(input.branchId),
        ),
      );
    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!found.has(id)) {
        /**
         * Without this a list can name somebody the picker's branch filter
         * would hide the station from anyway — an entry that looks like access
         * and grants none.
         */
        throw new AppError(
          400,
          'STAFF_NOT_AT_BRANCH',
          'That account is not among this branch’s staff',
          { accountId: id },
        );
      }
    }
  }
}

/** Reconcile `station_device` to exactly what was sent. */
async function replaceAssignments(
  tx: Exec,
  stationId: string,
  devices: Array<{ role: StationDeviceRole; deviceId: string }>,
): Promise<void> {
  await tx.delete(stationDevice).where(eq(stationDevice.stationId, stationId));
  for (const d of devices) {
    await tx
      .insert(stationDevice)
      .values({ id: newId(), stationId, role: d.role, deviceId: d.deviceId });
  }
}

/**
 * Reconcile `station_staff` to exactly what was sent, touching only the names
 * that moved.
 *
 * Deleting the whole list and writing it back would be simpler and would lie:
 * `added_by` and `added_at` are the record of when somebody was given this
 * station, and re-inserting an unchanged entry restamps it with today and with
 * whoever last saved the form. Only a revoke leaves no row behind — the audit
 * entry `updateStation` writes is where that lives.
 */
async function replaceStaff(
  tx: Exec,
  stationId: string,
  accountIds: string[],
  addedBy: string,
): Promise<void> {
  const wanted = new Set(accountIds);
  const held = await tx
    .select({ accountId: stationStaff.accountId })
    .from(stationStaff)
    .where(eq(stationStaff.stationId, stationId));
  const current = new Set(held.map((r) => r.accountId));

  const gone = [...current].filter((id) => !wanted.has(id));
  if (gone.length > 0) {
    await tx
      .delete(stationStaff)
      .where(and(eq(stationStaff.stationId, stationId), inArray(stationStaff.accountId, gone)));
  }
  for (const accountId of wanted) {
    if (current.has(accountId)) continue;
    await tx.insert(stationStaff).values({ id: newId(), stationId, accountId, addedBy });
  }
}

/** Who joined a station's list and who came off it, for the audit row. */
function staffDiff(
  before: Array<{ accountId: string; name: string | null }>,
  after: Array<{ accountId: string; name: string | null }>,
): {
  added: Array<{ accountId: string; name: string | null }>;
  removed: Array<{ accountId: string; name: string | null }>;
} {
  const had = new Set(before.map((s) => s.accountId));
  const has = new Set(after.map((s) => s.accountId));
  return {
    added: after.filter((s) => !had.has(s.accountId)),
    removed: before.filter((s) => !has.has(s.accountId)),
  };
}

/** What the config bundle carries, and therefore what moves `config_version`. */
function bundleFields(row: typeof station.$inferSelect, devices: StationDeviceView[]): string {
  return JSON.stringify({
    name: row.name,
    kind: row.kind,
    boxId: row.boxId,
    codePrefix: row.codePrefix,
    capabilities: row.capabilities ?? [],
    accessScope: row.accessScope,
    paymentRouting: row.paymentRouting ?? null,
    offlineWalletCapSatang: row.offlineWalletCapSatang,
    devices: devices.map((d) => `${d.role}:${d.deviceId}`).sort(),
  });
}

/**
 * **A service that writes inside `withTx` returns the ROUTE'S WHOLE RESPONSE
 * BODY, not the bare view.**
 *
 * `withTx` stores what its callback returns in `idempotency_key.response_body`
 * and the replay sends that back through the route's own serializer. A service
 * that returned `view` while the route wrapped it in `{ station: view }` stored
 * a body the response schema rejects, so the first press answered 200 and the
 * second — the double press the safeguard exists to absorb — answered 500 for
 * the life of the key, wrote a failed `ops_run` and reported to Sentry. The
 * wrapper is the contract, so the wrapper is what the transaction stores.
 */
export async function createStation(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  branchId: string,
  input: StationWriteInput,
): Promise<{ station: StationView }> {
  if (!input.boxId) {
    throw new AppError(
      400,
      'STATION_NEEDS_BOX',
      'A new station names the box it sits on — a Raspberry Pi already standing on site',
    );
  }
  assertStationCodePrefix(input.kind, input.codePrefix ?? null);
  await assertBoothCodePrefixFree(db, {
    operatorId: actor.operatorId,
    kind: input.kind,
    codePrefix: input.codePrefix ?? null,
  });
  await validateStationWrite(db, {
    operatorId: actor.operatorId,
    branchId,
    boxId: input.boxId,
    devices: input.devices,
    staffAccountIds: input.staffAccountIds,
  });

  const id = newId();
  try {
    return await withTx(db, ctx, 'station.create', async (tx) => {
      await tx.insert(station).values({
        id,
        operatorId: actor.operatorId,
        branchId,
        boxId: input.boxId,
        name: input.name,
        kind: input.kind,
        codePrefix: input.codePrefix ?? null,
        capabilities: input.capabilities,
        accessScope: input.accessScope,
        paymentRouting: (input.paymentRouting ?? null) as never,
        offlineWalletCapSatang: input.offlineWalletCapSatang ?? null,
      });
      await replaceAssignments(tx, id, input.devices);
      await replaceStaff(tx, id, input.staffAccountIds, actor.accountId);
      const [row] = await tx.select().from(station).where(eq(station.id, id)).limit(1);
      const [view] = await stationViews(tx, [row!], { withStaff: true });
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        branchId,
        action: 'station.create',
        entityType: 'station',
        entityId: id,
        after: view,
        requestId: ctx.requestId,
      });
      return { station: view! };
    });
  } catch (err) {
    rethrowFleetConflict(err);
  }
}

export async function updateStation(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: typeof station.$inferSelect,
  patch: Partial<StationWriteInput>,
): Promise<{ station: StationView }> {
  /**
   * `boxId: null` is accepted only where the station already has none — a
   * Sprint 1 row that predates boxes. Detaching a working station from its box
   * would leave a till with printers it cannot reach and no error anywhere.
   */
  const boxId = patch.boxId === undefined ? before.boxId : patch.boxId;
  if (boxId === null && before.boxId !== null) {
    throw new AppError(
      400,
      'STATION_NEEDS_BOX',
      'A station cannot be taken off its box — move it to another box instead',
    );
  }

  // The kind and prefix the row will have once this lands, whichever of the
  // two the request names — so an edit that leaves a booth without a valid
  // prefix is refused even when it names neither.
  assertStationCodePrefix(
    patch.kind ?? before.kind,
    patch.codePrefix === undefined ? before.codePrefix : patch.codePrefix,
  );
  await assertBoothCodePrefixFree(db, {
    operatorId: actor.operatorId,
    kind: patch.kind ?? before.kind,
    codePrefix: patch.codePrefix === undefined ? before.codePrefix : patch.codePrefix,
    exceptStationId: before.id,
  });

  const [beforeView] = await stationViews(db, [before], { withStaff: true });
  const devices = patch.devices ?? beforeView!.devices.map((d) => ({ role: d.role, deviceId: d.deviceId }));
  const staffAccountIds = patch.staffAccountIds ?? beforeView!.staff.map((s) => s.accountId);

  await validateStationWrite(db, {
    operatorId: actor.operatorId,
    branchId: before.branchId,
    boxId,
    devices,
    staffAccountIds,
  });

  try {
    return await withTx(db, ctx, 'station.update', async (tx) => {
      const set: Partial<typeof station.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.boxId !== undefined) set.boxId = patch.boxId;
      if (patch.codePrefix !== undefined) set.codePrefix = patch.codePrefix;
      if (patch.capabilities !== undefined) set.capabilities = patch.capabilities;
      if (patch.accessScope !== undefined) set.accessScope = patch.accessScope;
      if (patch.paymentRouting !== undefined) set.paymentRouting = patch.paymentRouting as never;
      if (patch.offlineWalletCapSatang !== undefined) {
        set.offlineWalletCapSatang = patch.offlineWalletCapSatang;
      }
      if (Object.keys(set).length > 0) {
        await tx.update(station).set(set).where(eq(station.id, before.id));
      }
      if (patch.devices !== undefined) await replaceAssignments(tx, before.id, patch.devices);
      if (patch.staffAccountIds !== undefined) {
        await replaceStaff(tx, before.id, patch.staffAccountIds, actor.accountId);
      }

      const [mid] = await tx.select().from(station).where(eq(station.id, before.id)).limit(1);
      const [midView] = await stationViews(tx, [mid!], { withStaff: true });
      /**
       * One rule, no per-field judgement: the version moves when anything the
       * box can see moves, and stands still otherwise. A station-level version
       * that disagreed with the bundle's hash would make "which bundle is this
       * box running" unanswerable, which is the one question it exists for.
       */
      const bundleChanged =
        bundleFields(mid!, midView!.devices) !== bundleFields(before, beforeView!.devices);
      /**
       * Who may use a station is NOT in the bundle — the box has no need of it
       * — and gating the audit row on the bundle meant the one mutation this
       * ticket is about left no trace at all. Worse for a revoke than for a
       * grant: `station_staff` is reconciled rather than tombstoned, so a row
       * taken off the list is the only record that it was ever on it.
       */
      const { added: staffAdded, removed: staffRemoved } = staffDiff(
        beforeView!.staff,
        midView!.staff,
      );
      const staffChanged = staffAdded.length > 0 || staffRemoved.length > 0;
      if (!bundleChanged && !staffChanged) return { station: midView! };

      let view = midView!;
      if (bundleChanged) {
        const [after] = await tx
          .update(station)
          .set({ configVersion: sql`${station.configVersion} + 1` })
          .where(eq(station.id, before.id))
          .returning();
        [view] = (await stationViews(tx, [after!], { withStaff: true })) as [StationView];
      }
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        branchId: before.branchId,
        action: 'station.update',
        entityType: 'station',
        entityId: before.id,
        before: beforeView,
        // The whole lists are on both sides already; these two say which way
        // each name moved, so a revoke reads as a revoke rather than as a
        // difference somebody has to spot.
        after: { ...view, staffAdded, staffRemoved },
        requestId: ctx.requestId,
      });
      return { station: view };
    });
  } catch (err) {
    rethrowFleetConflict(err);
  }
}

export async function archiveStation(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: typeof station.$inferSelect,
): Promise<void> {
  if (before.archivedAt) {
    throw new AppError(409, 'STATION_ALREADY_ARCHIVED', 'That station is already archived');
  }
  await withTx(db, ctx, 'station.archive', async (tx) => {
    await tx.update(station).set({ archivedAt: new Date() }).where(eq(station.id, before.id));
    /**
     * Sessions holding it are left alone on purpose. A person mid-sale is not
     * yanked off a till because somebody tidied the estate; the refusal, if it
     * comes, is at their next pick. `session.station_id` has no foreign key for
     * exactly this reason.
     */
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: before.branchId,
      action: 'station.archive',
      entityType: 'station',
      entityId: before.id,
      before: { name: before.name, archivedAt: null },
      after: { name: before.name, archivedAt: new Date().toISOString() },
      requestId: ctx.requestId,
    });
  });
}

// --- Boxes ------------------------------------------------------------------

function boxView(
  row: typeof box.$inferSelect,
  counts: { devices: number; stations: number },
  now = Date.now(),
): BoxView {
  return {
    id: row.id,
    branchId: row.branchId,
    name: row.name,
    slot: row.slot,
    role: row.role,
    status: row.status,
    hostname: row.hostname,
    agentVersion: row.agentVersion,
    currentEpoch: row.currentEpoch,
    registeredAt: row.registeredAt?.toISOString() ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    heartbeatAgeSeconds: row.lastHeartbeatAt
      ? Math.max(0, Math.round((now - row.lastHeartbeatAt.getTime()) / 1000))
      : null,
    lastStatus: (row.lastStatus ?? null) as Record<string, unknown> | null,
    deviceCount: counts.devices,
    stationCount: counts.stations,
    /**
     * Whether a code is outstanding, never the code. The hash is all the row
     * keeps, which is what makes the Console's "this is the one time it can be
     * read" true rather than a hopeful sentence.
     */
    claimCodeOutstanding: row.claimCodeHash !== null,
    claimCodeExpiresAt: row.claimCodeExpiresAt?.toISOString() ?? null,
    archived: row.archivedAt !== null,
  };
}

async function boxCounts(
  exec: Exec,
  boxIds: string[],
): Promise<Map<string, { devices: number; stations: number }>> {
  const out = new Map<string, { devices: number; stations: number }>();
  if (boxIds.length === 0) return out;
  for (const id of boxIds) out.set(id, { devices: 0, stations: 0 });
  const devices = await exec
    .select({ boxId: device.boxId, n: sql<number>`count(*)::int` })
    .from(device)
    .where(and(inArray(device.boxId, boxIds), isNull(device.archivedAt)))
    .groupBy(device.boxId);
  for (const d of devices) out.get(d.boxId)!.devices = Number(d.n);
  const stations = await exec
    .select({ boxId: station.boxId, n: sql<number>`count(*)::int` })
    .from(station)
    .where(and(inArray(station.boxId, boxIds), isNull(station.archivedAt)))
    .groupBy(station.boxId);
  for (const s of stations) {
    if (s.boxId) out.get(s.boxId)!.stations = Number(s.n);
  }
  return out;
}

export async function listBoxes(
  db: Db,
  ctx: { operatorId: string; branchId: string; includeArchived: boolean },
): Promise<BoxView[]> {
  const rows = await db
    .select()
    .from(box)
    .where(
      and(
        eq(box.operatorId, ctx.operatorId),
        eq(box.branchId, ctx.branchId),
        ctx.includeArchived ? undefined : isNull(box.archivedAt),
      ),
    )
    .orderBy(asc(box.slot));
  const counts = await boxCounts(db, rows.map((r) => r.id));
  const now = Date.now();
  return rows.map((r) => boxView(r, counts.get(r.id) ?? { devices: 0, stations: 0 }, now));
}

/**
 * Register a box row and mint the claim code its Pi will redeem.
 *
 * **The code never joins the value this transaction returns.** `withTx` stores
 * that value in `idempotency_key.response_body`, where it would sit in readable
 * form for the whole replay window; the plaintext is held in a variable
 * declared outside the callback and merged into the HTTP answer afterwards. A
 * replay of the same key is therefore answered with the box and no code, which
 * is correct: a one-time code handed out twice is not one-time.
 */
export async function createBox(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  branchId: string,
  input: { name: string; slot: string; role: BoxRole },
): Promise<{ box: BoxView; claimCode: string; expiresAt: string }> {
  const id = newId();
  let code!: { code: string; expiresAt: Date };
  try {
    const created = await withTx(db, ctx, 'box.create', async (tx) => {
      await tx.insert(box).values({
        id,
        operatorId: actor.operatorId,
        branchId,
        name: input.name,
        slot: input.slot,
        role: input.role,
        status: 'unclaimed',
      });
      code = await issueClaimCode(tx, id, {
        issuedByAccountId: actor.accountId,
        requestId: ctx.requestId ?? null,
      });
      const [row] = await tx.select().from(box).where(eq(box.id, id)).limit(1);
      const view = boxView(row!, { devices: 0, stations: 0 });
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        branchId,
        action: 'box.create',
        entityType: 'box',
        entityId: id,
        after: { name: input.name, slot: input.slot, role: input.role },
        requestId: ctx.requestId,
      });
      return { box: view };
    });
    return { ...created, claimCode: code.code, expiresAt: code.expiresAt.toISOString() };
  } catch (err) {
    rethrowFleetConflict(err);
  }
}

/**
 * Edit a box, and take one out of service.
 *
 * `online` and `offline` belong to the watchdog and to the heartbeat: a box
 * that has crashed cannot tell anybody it is down, and a person asserting
 * either by hand would be overwriting the one signal that is worth having.
 * `disabled` is the only status a person sets, and setting it is a revocation —
 * see `disableBox` in `services/box.ts`.
 */
export async function updateBox(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: typeof box.$inferSelect,
  patch: { name?: string; slot?: string; role?: BoxRole; status?: BoxStatus },
): Promise<{ box: BoxView }> {
  if (patch.status !== undefined && patch.status !== 'disabled' && patch.status !== 'offline') {
    throw new AppError(
      400,
      'BOX_STATUS_INVALID',
      'Only "disabled" and a return to service can be set by hand — online and offline are the watchdog’s',
    );
  }
  try {
    return await withTx(db, ctx, 'box.update', async (tx) => {
      const set: Partial<typeof box.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.slot !== undefined) set.slot = patch.slot;
      if (patch.role !== undefined) set.role = patch.role;
      if (patch.status === 'disabled') {
        set.status = 'disabled';
        /**
         * Taking a box out of service is a REVOCATION, not a label. The secret
         * goes with the status, so the Pi standing in somebody's flat is
         * refused at its very next request instead of being told "disabled"
         * and retrying for ever. Bringing it back is a new claim code, which is
         * the button already next to this one.
         */
        set.secretHash = null;
        await tx
          .update(deviceCredential)
          .set({
            revokedAt: new Date(),
            revokedReason: 'box_disabled',
            secretHash: null,
            pairingCodeHash: null,
          })
          .where(and(eq(deviceCredential.boxId, before.id), isNull(deviceCredential.revokedAt)));
      } else if (patch.status === 'offline') {
        /**
         * Back in service. A box whose secret was dropped when it was disabled
         * has to register again before it can say anything, so `unclaimed` is
         * the honest answer for it; one that still holds a credential is merely
         * quiet until its next heartbeat.
         */
        set.status = before.secretHash ? 'offline' : 'unclaimed';
      }
      const [after] = await tx.update(box).set(set).where(eq(box.id, before.id)).returning();
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        branchId: before.branchId,
        action: patch.status === 'disabled' ? 'box.disable' : 'box.update',
        entityType: 'box',
        entityId: before.id,
        before: { name: before.name, slot: before.slot, role: before.role, status: before.status },
        after: { name: after!.name, slot: after!.slot, role: after!.role, status: after!.status },
        requestId: ctx.requestId,
      });
      const counts = await boxCounts(tx, [before.id]);
      return { box: boxView(after!, counts.get(before.id) ?? { devices: 0, stations: 0 }) };
    });
  } catch (err) {
    rethrowFleetConflict(err);
  }
}

/** Re-issue a claim code. Rule 6 again: the code never enters the stored body. */
export async function reissueClaimCode(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string },
  boxRow: typeof box.$inferSelect,
): Promise<{ claimCode: string; expiresAt: string }> {
  let code!: { code: string; expiresAt: Date };
  await withTx(db, ctx, 'box.claim_code_issue', async (tx) => {
    code = await issueClaimCode(tx, boxRow.id, {
      issuedByAccountId: actor.accountId,
      requestId: ctx.requestId ?? null,
    });
    // `issueClaimCode` writes its own audit row, and it carries the expiry and
    // the slot rather than the code.
    return { ok: true as const };
  });
  return { claimCode: code.code, expiresAt: code.expiresAt.toISOString() };
}

export async function archiveBox(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: typeof box.$inferSelect,
): Promise<void> {
  if (before.archivedAt) {
    throw new AppError(409, 'BOX_NOT_FOUND', 'That box is already archived');
  }
  const live = await db
    .select({ id: station.id, name: station.name })
    .from(station)
    .where(and(eq(station.boxId, before.id), isNull(station.archivedAt)));
  if (live.length > 0) {
    /**
     * A box carrying live stations is a counter still in use. Archiving it
     * would leave those stations pointing at a box nothing can reach, and the
     * till would find out by printing nothing.
     */
    throw new AppError(
      409,
      'BOX_HAS_LIVE_STATIONS',
      'Move or archive this box’s stations first',
      { stations: live.map((s) => ({ id: s.id, name: s.name })) },
    );
  }
  await withTx(db, ctx, 'box.archive', async (tx) => {
    await tx
      .update(box)
      .set({ archivedAt: new Date(), secretHash: null, claimCodeHash: null, claimCodeExpiresAt: null })
      .where(eq(box.id, before.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: before.branchId,
      action: 'box.archive',
      entityType: 'box',
      entityId: before.id,
      before: { slot: before.slot, status: before.status },
      after: { archivedAt: new Date().toISOString() },
      requestId: ctx.requestId,
    });
  });
}

// --- Commands and heartbeats ------------------------------------------------

export async function listCommands(
  db: Db,
  boxId: string,
  limit: number,
): Promise<BoxCommandView[]> {
  const rows = await db
    .select()
    .from(boxCommand)
    .where(eq(boxCommand.boxId, boxId))
    .orderBy(desc(boxCommand.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    payload: (r.payload ?? null) as Record<string, unknown> | null,
    result: (r.result ?? null) as Record<string, unknown> | null,
    actionId: r.actionId,
    requestedByAccountId: r.requestedByAccountId,
    attempts: r.attempts,
    createdAt: r.createdAt.toISOString(),
    claimedAt: r.claimedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
  }));
}

export async function listHeartbeats(
  db: Db,
  boxId: string,
  limit: number,
): Promise<BoxHeartbeatView[]> {
  const rows = await db
    .select()
    .from(boxHeartbeat)
    .where(eq(boxHeartbeat.boxId, boxId))
    .orderBy(desc(boxHeartbeat.receivedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt.toISOString(),
    reportedAt: r.reportedAt?.toISOString() ?? null,
    clockOffsetMs: r.clockOffsetMs,
    agentVersion: r.agentVersion,
    uptimeS: r.uptimeS,
    tempC: r.tempC,
    outboxDepth: r.outboxDepth,
  }));
}

/**
 * Queue a command for a box to collect on its next poll.
 *
 * Nothing is sent down a wire from here: the cloud writes a row, the box takes
 * it when it asks. That is what lets a test print be sent while a station is
 * still being set up, and it is why a command carries an expiry — a test print
 * queued for a box that was offline all week must not fire when it wakes up.
 */
export async function queueCommand(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  boxRow: typeof box.$inferSelect,
  input: { kind: string; payload?: Record<string, unknown> | null; actionId: string },
): Promise<{ commandId: string; actionId: string }> {
  if (!(BOX_COMMAND_KINDS as readonly string[]).includes(input.kind)) {
    throw new AppError(400, 'COMMAND_KIND_INVALID', 'No such command', { kind: input.kind });
  }
  const kind = input.kind as BoxCommandKind;
  if (!boxRow.registeredAt) {
    throw new AppError(
      409,
      'BOX_UNCLAIMED',
      'This box has never registered — issue a claim code and let it come online first',
    );
  }

  if (kind === 'test_print') {
    const deviceId = input.payload?.deviceId;
    if (typeof deviceId !== 'string') {
      throw new AppError(400, 'COMMAND_PAYLOAD_INVALID', 'A test print names the device to print on');
    }
    const [row] = await db
      .select({ id: device.id })
      .from(device)
      .where(
        and(eq(device.id, deviceId), eq(device.boxId, boxRow.id), isNull(device.archivedAt)),
      )
      .limit(1);
    if (!row) {
      throw new AppError(
        400,
        'COMMAND_PAYLOAD_INVALID',
        'That device is not on this box',
        { deviceId },
      );
    }
  }

  /**
   * A TENDER, guarded here because this is the OTHER door to one (S2-10a).
   *
   * The money path does not come through `queueCommand` at all — it writes the
   * command with the sale's own transaction handle so that an attempt saying
   * `inquiring` and an inquiry that was never queued cannot both exist
   * (`services/payments/terminal.ts`). What comes through here is
   * `POST /boxes/:id/commands`, the Console's generic control, and a
   * `terminal_sale` queued from there would drive a REAL EDC on a real counter
   * and charge a guest against an attempt this ledger has never heard of. So
   * it is checked the way a test print is: the payload has to describe a
   * tender, and the device it names has to be one of this box's.
   */
  if (kind === 'terminal_sale') {
    const parsed = TerminalCommandPayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new AppError(400, 'COMMAND_PAYLOAD_INVALID', 'That is not a tender this platform knows', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const named = parsed.data.deviceId;
    if (named) {
      const [row] = await db
        .select({ id: device.id })
        .from(device)
        .where(and(eq(device.id, named), eq(device.boxId, boxRow.id), isNull(device.archivedAt)))
        .limit(1);
      if (!row) {
        throw new AppError(400, 'COMMAND_PAYLOAD_INVALID', 'That device is not on this box', {
          deviceId: named,
        });
      }
    }
  }

  /**
   * The simulator's one command kind (S2-06), guarded HERE rather than on the
   * route that happens to send it.
   *
   * There are two doors to this: `POST /boxes/:id/simulate`, which validates
   * the action against `SimulatorActionSchema`, and `POST /boxes/:id/commands`,
   * which the Console's Simulators panel uses because the simulator rides the
   * ordinary command queue. A check on one of those doors is a check somebody
   * can walk around, and the two below are not the kind that may be walked
   * around.
   */
  if (kind === 'simulate') {
    /**
     * Validated here and nowhere else, because this is the only door. An
     * action the box would not understand is refused at the press rather than
     * queued, delivered, and answered `SIMULATOR_NOT_BUILT` a poll later.
     */
    const parsed = SimulatorActionSchema.safeParse(input.payload?.action);
    if (!parsed.success) {
      throw new AppError(
        400,
        'COMMAND_PAYLOAD_INVALID',
        'That is not a simulator action this platform knows',
        { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      );
    }
    const action = parsed.data;
    const name = action.action;
    /**
     * A badge value and a PIN are credentials on their way to an
     * authentication path, and `payload` is a stored jsonb column the Console
     * renders as command history — so either one written here would sit in the
     * database and on a web page. Refused rather than stripped: a control that
     * silently dropped the value would look as though it had worked.
     */
    if ((SIMULATOR_ACTIONS_WITH_SECRETS as readonly string[]).includes(name)) {
      throw new AppError(
        409,
        'SIMULATOR_ACTION_CARRIES_SECRET',
        'A badge or a PIN cannot travel through the command queue — it is stored and shown. That control needs the station channel.',
      );
    }
    /** And a device named in it must be one of THIS box's, as a test print's is. */
    if ('deviceId' in action && typeof action.deviceId === 'string') {
      const [row] = await db
        .select({ id: device.id })
        .from(device)
        .where(
          and(eq(device.id, action.deviceId), eq(device.boxId, boxRow.id), isNull(device.archivedAt)),
        )
        .limit(1);
      if (!row) {
        throw new AppError(400, 'COMMAND_PAYLOAD_INVALID', 'That device is not on this box', {
          deviceId: action.deviceId,
        });
      }
    }
  }

  if (kind === 'reset_store') {
    /**
     * The destructive one: it wipes the box's store and mints a new journal
     * epoch. Unsynced events on the box are sales nobody has a copy of, so the
     * refusal is absolute rather than a confirmation dialogue.
     */
    const depth = (boxRow.lastStatus as { outboxDepth?: unknown } | null)?.outboxDepth;
    if (typeof depth === 'number' && depth > 0) {
      throw new AppError(
        409,
        'BOX_OUTBOX_UNSYNCED',
        `This box still has ${depth} unsynced event(s) — let it catch up first`,
        { outboxDepth: depth },
      );
    }
  }

  const id = newId();
  const expiresAt = new Date(Date.now() + boxSettings().commandTtlS * 1000);
  return withTx(db, ctx, `box.command.queue.${kind}`, async (tx) => {
    await tx.insert(boxCommand).values({
      id,
      boxId: boxRow.id,
      kind,
      payload: (input.payload ?? null) as never,
      requestedByAccountId: actor.accountId,
      actionId: input.actionId,
      expiresAt,
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: boxRow.branchId,
      action: `box.command.${kind}`,
      entityType: 'box',
      entityId: boxRow.id,
      after: { commandId: id, kind, payload: input.payload ?? null, actionId: input.actionId },
      requestId: ctx.requestId,
    });
    return { commandId: id, actionId: input.actionId };
  });
}

// --- Devices ----------------------------------------------------------------

function deviceView(row: typeof device.$inferSelect): DeviceView {
  return {
    id: row.id,
    boxId: row.boxId,
    kind: row.kind,
    label: row.label,
    transport: row.transport,
    address: row.address,
    model: row.model,
    protocol: row.protocol,
    reachability: row.reachability,
    paperStatus: row.paperStatus,
    serialNumber: row.serialNumber,
    terminalId: row.terminalId,
    merchantId: row.merchantId,
    // Validated by `DeviceSettingsSchema` on every write; the column itself is
    // untyped jsonb.
    settings: (row.settings as DeviceSettings | null) ?? null,
    lastError: row.lastError,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    archived: row.archivedAt !== null,
  };
}

export async function listDevices(
  db: Db,
  boxId: string,
  includeArchived: boolean,
): Promise<DeviceView[]> {
  const rows = await db
    .select()
    .from(device)
    .where(and(eq(device.boxId, boxId), includeArchived ? undefined : isNull(device.archivedAt)))
    .orderBy(asc(device.kind), asc(device.label));
  return rows.map(deviceView);
}

export async function createDevice(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  boxRow: typeof box.$inferSelect,
  input: {
    kind: DeviceKind;
    label: string;
    transport: DeviceTransport;
    address?: string | null;
    model?: string | null;
    protocol?: string | null;
    serialNumber?: string | null;
    terminalId?: string | null;
    merchantId?: string | null;
    settings?: DeviceSettings | null;
  },
): Promise<{ device: DeviceView }> {
  const id = newId();
  try {
    return await withTx(db, ctx, 'device.create', async (tx) => {
      await tx.insert(device).values({
        id,
        operatorId: boxRow.operatorId,
        branchId: boxRow.branchId,
        boxId: boxRow.id,
        kind: input.kind,
        label: input.label,
        transport: input.transport,
        address: input.address ?? null,
        model: input.model ?? null,
        protocol: input.protocol ?? null,
        serialNumber: input.serialNumber ?? null,
        terminalId: input.terminalId ?? null,
        merchantId: input.merchantId ?? null,
        settings: input.settings ?? null,
      });
      const [row] = await tx.select().from(device).where(eq(device.id, id)).limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: boxRow.operatorId,
        branchId: boxRow.branchId,
        action: 'device.create',
        entityType: 'device',
        entityId: id,
        after: deviceView(row!),
        requestId: ctx.requestId,
      });
      return { device: deviceView(row!) };
    });
  } catch (err) {
    rethrowFleetConflict(err);
  }
}

export async function updateDevice(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: typeof device.$inferSelect,
  patch: {
    label?: string;
    address?: string | null;
    model?: string | null;
    protocol?: string | null;
    serialNumber?: string | null;
    terminalId?: string | null;
    merchantId?: string | null;
    /**
     * Left out keeps what the row has — Drizzle drops an undefined key from
     * `set` — and null clears it. The box needs no nudge either way: the
     * bundle's version is a hash over the document, settings included
     * (`configBundle` in `services/box.ts`), so the next heartbeat pulls.
     */
    settings?: DeviceSettings | null;
  },
): Promise<{ device: DeviceView }> {
  try {
    return await withTx(db, ctx, 'device.update', async (tx) => {
      const [after] = await tx.update(device).set(patch).where(eq(device.id, before.id)).returning();
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: before.operatorId,
        branchId: before.branchId,
        action: 'device.update',
        entityType: 'device',
        entityId: before.id,
        before: deviceView(before),
        after: deviceView(after!),
        requestId: ctx.requestId,
      });
      return { device: deviceView(after!) };
    });
  } catch (err) {
    rethrowFleetConflict(err);
  }
}

/**
 * Archive a device, and say what stops working.
 *
 * The assignments are kept — `station_device` still points at it, so a sale
 * printed last month still resolves what it was printed on — and `configBundle`
 * then drops the archived device from the bundle. Which means a till can lose a
 * printer silently. The answer names the stations that just did, so the Console
 * can say "Counter 1 will stop printing receipts" rather than letting somebody
 * find out at the counter.
 */
export async function archiveDevice(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: typeof device.$inferSelect,
): Promise<Array<{ stationId: string; stationName: string; role: StationDeviceRole }>> {
  if (before.archivedAt) {
    throw new AppError(409, 'DEVICE_ALREADY_ARCHIVED', 'That device is already archived');
  }
  const stillAssigned = await db
    .select({ stationId: station.id, stationName: station.name, role: stationDevice.role })
    .from(stationDevice)
    .innerJoin(station, eq(stationDevice.stationId, station.id))
    .where(and(eq(stationDevice.deviceId, before.id), isNull(station.archivedAt)));

  await withTx(db, ctx, 'device.archive', async (tx) => {
    await tx.update(device).set({ archivedAt: new Date() }).where(eq(device.id, before.id));
    for (const s of stillAssigned) {
      await tx
        .update(station)
        .set({ configVersion: sql`${station.configVersion} + 1` })
        .where(eq(station.id, s.stationId));
    }
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: before.operatorId,
      branchId: before.branchId,
      action: 'device.archive',
      entityType: 'device',
      entityId: before.id,
      before: deviceView(before),
      after: { archivedAt: new Date().toISOString(), stillAssignedTo: stillAssigned },
      requestId: ctx.requestId,
    });
  });
  return stillAssigned;
}

// --- Credentials ------------------------------------------------------------

function credentialView(row: typeof deviceCredential.$inferSelect): CredentialView {
  return {
    id: row.id,
    kind: row.kind,
    stationId: row.stationId,
    boxId: row.boxId,
    label: row.label,
    pairingOutstanding: row.pairingCodeHash !== null,
    pairingCodeExpiresAt: row.pairingCodeExpiresAt?.toISOString() ?? null,
    pairedAt: row.pairedAt?.toISOString() ?? null,
    pairedByAccountId: row.pairedByAccountId,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: row.revokedReason,
    scopes: (row.scopes ?? []) as string[],
  };
}

export async function listCredentials(
  db: Db,
  ctx: { operatorId: string; branchId: string; includeRevoked: boolean },
): Promise<CredentialView[]> {
  const rows = await db
    .select()
    .from(deviceCredential)
    .where(
      and(
        eq(deviceCredential.operatorId, ctx.operatorId),
        eq(deviceCredential.branchId, ctx.branchId),
        ctx.includeRevoked ? undefined : isNull(deviceCredential.revokedAt),
      ),
    )
    .orderBy(desc(deviceCredential.createdAt));
  return rows.map(credentialView);
}

/**
 * Mint a pairing code for a screen: a display, a kiosk or a booth.
 *
 * Rule 6, a third time — the code is returned once, outside the value the
 * transaction stores, and only its hash is kept. `box` is refused here: the
 * database's own check requires a box credential to carry a box id, and a box
 * pairs by redeeming a claim code rather than by somebody reading a number out
 * to a screen.
 */
export async function pairCredential(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  stationRow: typeof station.$inferSelect,
  input: { kind: DeviceCredentialKind; label?: string | null },
): Promise<{ credential: CredentialView; pairingCode: string; expiresAt: string }> {
  if (input.kind === 'box') {
    throw new AppError(
      400,
      'CREDENTIAL_KIND_INVALID',
      'A box pairs by redeeming a claim code, not from a station',
    );
  }
  const id = newId();
  const code = mintClaimCode();
  const expiresAt = new Date(Date.now() + boxSettings().claimCodeTtlS * 1000);
  const created = await withTx(db, ctx, 'device_credential.pair', async (tx) => {
    await tx.insert(deviceCredential).values({
      id,
      operatorId: actor.operatorId,
      branchId: stationRow.branchId,
      kind: input.kind,
      stationId: stationRow.id,
      label: input.label ?? null,
      pairingCodeHash: sha256Hex(normaliseClaimCode(code)),
      pairingCodeExpiresAt: expiresAt,
    });
    const [row] = await tx
      .select()
      .from(deviceCredential)
      .where(eq(deviceCredential.id, id))
      .limit(1);
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: stationRow.branchId,
      action: 'device_credential.pair',
      entityType: 'device_credential',
      entityId: id,
      // The expiry and what it is for; never the code.
      after: {
        kind: input.kind,
        stationId: stationRow.id,
        label: input.label ?? null,
        expiresAt: expiresAt.toISOString(),
      },
      requestId: ctx.requestId,
    });
    return { credential: credentialView(row!) };
  });
  return { ...created, pairingCode: code, expiresAt: expiresAt.toISOString() };
}

export async function revokeCredential(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: typeof deviceCredential.$inferSelect,
  reason: string | null,
): Promise<void> {
  if (before.revokedAt) {
    throw new AppError(409, 'CREDENTIAL_ALREADY_REVOKED', 'That credential is already revoked');
  }
  await withTx(db, ctx, 'device_credential.revoke', async (tx) => {
    /**
     * Revoking is not deleting: the row stays, with who revoked it and why.
     * What goes is everything that could still authenticate — the live secret
     * and any pairing code nobody redeemed.
     */
    await tx
      .update(deviceCredential)
      .set({
        revokedAt: new Date(),
        revokedReason: reason,
        secretHash: null,
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
      })
      .where(eq(deviceCredential.id, before.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: before.branchId,
      action: 'device_credential.revoke',
      entityType: 'device_credential',
      entityId: before.id,
      before: credentialView(before),
      after: { revokedAt: new Date().toISOString(), revokedReason: reason },
      requestId: ctx.requestId,
    });
  });
}

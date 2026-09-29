/**
 * The fleet: the boxes standing at the park, the stations that sit on them,
 * the devices each box can reach, and the credentials the screens hold.
 *
 * WHY IT IS ALL IN ONE FILE — the same reason observability.ts is. The API
 * half of S2-04 is being built beside this page, so what follows is the
 * CONTRACT rather than a description of something already deployed: one place
 * to retarget a path, and every field the API has not grown yet optional, so
 * the Devices page renders correctly against today's API and fills in as the
 * routes land. A 404 means "this deployment does not have that route yet" and
 * the page says so (see isMissingRoute); anything else is a real failure.
 *
 * WHY THESE PATHS. The till states the same contract in
 * apps/pos/src/api/platform.ts, and the two must not ask the API two different
 * ways. Branch-scoped resources are nested (`/branches/:id/stations`), which is
 * what the catalogue routes already do and what the guard can rely on — a path
 * parameter is required by the router and checked before the handler runs,
 * where a `?branchId=` can simply be left off. Devices are asked for per BOX
 * and never per branch, because a printer is reachable through the box it is
 * plugged into and through no other. What is only ever done from the console —
 * registering a box, its claim code, its command history and log, pairing a
 * screen — is added here and nowhere else.
 *
 * The vocabularies below are the database's, from
 * packages/db/src/schema/fleet.ts and edge.ts, so the two cannot drift apart
 * silently.
 */
import type { DeviceSettings, StationSessionDocument } from '@oto/shared';
import { api, ApiError, idemKey, isMissingRoute, qs } from './client';

export { isMissingRoute };

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** `virtual` is the box that runs inside the api; the rest are Raspberry Pis. */
export const BOX_ROLES = ['counter', 'gate', 'booth', 'kiosk', 'standby', 'virtual'] as const;
export type BoxRole = (typeof BOX_ROLES)[number];

/**
 * `unclaimed` is a row waiting for its Pi to redeem a claim code. `online` and
 * `offline` are the watchdog's verdict from the heartbeat age, never the box's
 * own claim — a box that has crashed cannot tell anybody it is down, and that
 * silence is the signal. `disabled` is a box a person took out of service,
 * which is a different fact from one that has gone quiet.
 */
export const BOX_STATUSES = ['unclaimed', 'online', 'offline', 'disabled'] as const;
export type BoxStatus = (typeof BOX_STATUSES)[number];

export const DEVICE_KINDS = [
  'receipt_printer',
  'band_printer',
  'kitchen_printer',
  'bar_printer',
  'scanner',
  'terminal',
  'gate',
  'gate_reader',
  'cash_drawer',
] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_TRANSPORTS = ['lan', 'usb', 'serial', 'bluetooth', 'simulated'] as const;
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[number];

export const STATION_KINDS = ['till', 'kiosk', 'gate', 'display', 'booth'] as const;
export type StationKind = (typeof STATION_KINDS)[number];

/**
 * Who may pick a station — and therefore who can SEE it. `all_staff` puts it
 * in every signed-in member's picker at that branch; `selected_staff` puts it
 * only in the pickers of the accounts on its list, and to everybody else the
 * station is not there at all.
 */
export const STATION_ACCESS_SCOPES = ['all_staff', 'selected_staff'] as const;
export type StationAccessScope = (typeof STATION_ACCESS_SCOPES)[number];

/** What a TILL is used for. Empty means "not restricted"; other kinds ignore it. */
export const STATION_CAPABILITIES = ['tickets', 'fnb', 'dropoff', 'parties'] as const;
export type StationCapability = (typeof STATION_CAPABILITIES)[number];

/** What job a device does for one station — one device per role, as the till has one field each. */
export const STATION_DEVICE_ROLES = [
  'receipt',
  'kids_band',
  'adult_band',
  'kitchen',
  'bar',
  'scanner',
  'card_terminal',
  'qr_terminal',
  'gate',
  'cash_drawer',
] as const;
export type StationDeviceRole = (typeof STATION_DEVICE_ROLES)[number];

export const CREDENTIAL_KINDS = ['display', 'kiosk', 'booth', 'box'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface BoxRow {
  id: string;
  name: string;
  /** The position on site — "counter-1", "gate-north". Survives a Pi being swapped. */
  slot: string;
  role: BoxRole | string;
  status: BoxStatus | string;
  agentVersion?: string | null;
  lastHeartbeatAt?: string | null;
  deviceCount?: number | null;
  /** Console-only, all optional: the till's picker has no use for any of it. */
  branchId?: string;
  hostname?: string | null;
  /** The journal epoch its events are stamped with. "Reset store" mints N+1. */
  currentEpoch?: number | null;
  registeredAt?: string | null;
  /**
   * Seconds since the last heartbeat AS THE API COUNTED IT. Preferred over
   * anything worked out here: a back-office laptop with a wrong clock would
   * otherwise report every box in the park as offline.
   */
  heartbeatAgeSeconds?: number | null;
  uptimeSeconds?: number | null;
  tempC?: number | null;
  clockOffsetMs?: number | null;
  /** Unsynced events waiting on the box — the number that says whether offline is safe. */
  outboxDepth?: number | null;
  stationCount?: number | null;
  /** A claim code has been issued and no Pi has redeemed it yet. */
  claimCodeOutstanding?: boolean;
  claimCodeExpiresAt?: string | null;
  /** The newest heartbeat's report, whole, for anything not flattened above. */
  lastStatus?: Record<string, unknown> | null;
  archived?: boolean;
}

export interface DeviceRow {
  id: string;
  boxId: string;
  kind: DeviceKind | string;
  label: string;
  transport: DeviceTransport | string;
  address?: string | null;
  model?: string | null;
  protocol?: string | null;
  reachability?: 'unknown' | 'reachable' | 'unreachable' | string;
  /** Only meaningful on a printer; `unknown` everywhere else. */
  paperStatus?: 'unknown' | 'ok' | 'low' | 'out' | string;
  serialNumber?: string | null;
  terminalId?: string | null;
  merchantId?: string | null;
  /**
   * The unit's own facts, `DeviceSettingsSchema` in `@oto/shared`: an ESC/POS
   * printer's 576 or 512 dots per line as its self-test page says. Null, or
   * absent from an older api, means the model's profile stands.
   */
  settings?: DeviceSettings | null;
  lastError?: string | null;
  lastSeenAt?: string | null;
  archived?: boolean;
}

/**
 * One device doing one job for a station.
 *
 * The label and the wiring are denormalised onto the assignment by the API
 * rather than sent as a nested device row, because the till reads the same
 * shape and has to name the printer a receipt went to without holding the whole
 * device list (apps/pos/src/station/fleet.ts). This page has that list anyway,
 * so it costs nothing here and saves a request there.
 */
export interface StationDeviceAssignment {
  role: StationDeviceRole | string;
  deviceId: string;
  label?: string | null;
  kind?: DeviceKind | string | null;
  transport?: DeviceTransport | string | null;
  address?: string | null;
}

/**
 * Which tender goes where.
 *
 * S2-10a named the tenders: the API now validates these three keys on write
 * against `PaymentRoutingSchema` in `@oto/shared`, so a value outside the
 * unions below is refused rather than stored. The `| string` on each stays,
 * because a station configured before that vocabulary existed still has to
 * render on this page.
 *
 * It is deliberately written as "which of this station's assigned devices takes
 * it" rather than as device ids, so moving a terminal between stations does not
 * silently re-route money. Unknown keys the API grows are preserved on write —
 * see `mergeRouting`.
 */
export interface PaymentRouting {
  /** `card_terminal` takes it on the tethered EDC; `manual` means staff key it in on the terminal itself. */
  card?: 'card_terminal' | 'manual' | string;
  /** `gateway` is the payment gateway on the customer display; `qr_terminal` is the EDC's own QR. */
  qr?: 'gateway' | 'qr_terminal' | 'none' | string;
  cash?: 'cash_drawer' | 'none' | string;
  [key: string]: unknown;
}

export interface StationRow {
  id: string;
  branchId: string;
  name: string;
  kind: StationKind | string;
  capabilities?: (StationCapability | string)[];
  accessScope?: StationAccessScope | string;
  /** Null only on a station carried over from Sprint 1, before boxes existed. */
  boxId: string | null;
  boxName?: string | null;
  boxStatus?: BoxStatus | string | null;
  devices?: StationDeviceAssignment[];
  /** Who may pick it. Empty unless the scope is `selected_staff`. */
  staff?: Array<{ accountId: string; name: string | null }>;
  /** What the box compares on each config poll. One number answers "which bundle is it running". */
  configVersion?: number | null;
  archived?: boolean;
  /** Set from the console only; the till's wizard leaves these alone. */
  codePrefix?: string | null;
  paymentRouting?: PaymentRouting | null;
  offlineWalletCapSatang?: number | null;
  lastSeenAt?: string | null;
}

/**
 * Everything a station is written with.
 *
 * The staff list and the device assignments are sent WHOLE rather than as
 * deltas: one call, one audit row, and a before and after that reads as what
 * it is rather than as three rows somebody has to reassemble.
 */
export interface StationWrite {
  name: string;
  kind: StationKind;
  boxId: string | null;
  capabilities: StationCapability[];
  accessScope: StationAccessScope;
  /** Ignored by the API unless the scope is `selected_staff`. */
  staffAccountIds: string[];
  devices: Array<{ role: StationDeviceRole; deviceId: string }>;
  /** Console-only fields. The till's wizard omits them and they are left as they were. */
  codePrefix?: string | null;
  paymentRouting?: PaymentRouting | null;
  offlineWalletCapSatang?: number | null;
}

/**
 * Somebody who can be put on a station's list — the staff of that branch.
 *
 * The name is nullable because an account need not have an employee record
 * behind it: a manager granted a role at this branch and never entered in the
 * staff directory is a real person who can be named on a station, and the phone
 * is what identifies them until somebody fills the rest in.
 */
export interface BranchStaffMember {
  accountId: string;
  name: string | null;
  phone?: string | null;
  status?: string | null;
}

/** A station that is still naming some device for a job — see `archiveDevice`. */
export interface StationAssignmentRef {
  stationId: string;
  stationName: string;
  role: StationDeviceRole | string;
}

export interface BoxHeartbeatRow {
  id: string;
  receivedAt: string;
  reportedAt?: string | null;
  clockOffsetMs?: number | null;
  agentVersion?: string | null;
  uptimeS?: number | null;
  /** Null on the virtual box, which has no thermometer — not zero, which reads as cold. */
  tempC?: number | null;
  outboxDepth?: number | null;
}

/**
 * What this Console can ask a box to do.
 *
 * The fourth copy of a vocabulary that is a CHECK constraint in
 * `edge.box_command` — the others are `packages/db/src/schema/edge.ts`,
 * `packages/box-agent/src/protocol.ts` and `apps/api/src/routes/fleet.ts`
 * (which imports the schema's). A kind offered here that the database refuses
 * is a 500 on a button press, which is why the list is kept in step even where
 * this page has no control for one: `simulate` travels through `simulatorApi`
 * and the two S2-10a kinds are queued by the payment services, so none of the
 * three appears in `SAFE_COMMANDS`.
 */
export const BOX_COMMAND_KINDS = [
  'test_print',
  'config_apply',
  'clear_cache',
  'collect_logs',
  'restart',
  'go_offline',
  'go_online',
  'reset_store',
  'simulate',
  /** Take a payment on the station's card terminal (S2-10a). */
  'terminal_sale',
  /** Open the cash drawer on the receipt printer's RJ11 (S2-10a). */
  'drawer_kick',
] as const;
export type BoxCommandKind = (typeof BOX_COMMAND_KINDS)[number];

export const BOX_COMMAND_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;
export type BoxCommandState = (typeof BOX_COMMAND_STATES)[number];

export interface BoxCommandRow {
  id: string;
  kind: BoxCommandKind | string;
  state: BoxCommandState | string;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  /** `x-oto-action-id` — what ties this command to the Box log and to its ops_run. */
  actionId?: string | null;
  requestedByAccountId?: string | null;
  attempts?: number | null;
  createdAt: string;
  claimedAt?: string | null;
  finishedAt?: string | null;
  expiresAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * One line of what a box did. The ticket asks for the last 500, filterable by
 * action id, and for it to be READABLE rather than a dump — so a line is
 * structured (when, how bad, what about) rather than a string the page would
 * have to parse back apart.
 */
export interface BoxLogLine {
  at: string;
  /** pino's levels, as the agent emits them. */
  level?: 'debug' | 'info' | 'warn' | 'error' | string;
  message: string;
  actionId?: string | null;
  commandId?: string | null;
  /** Which part of the agent spoke: `printer`, `sync`, `lease`, `config`. */
  source?: string | null;
  stationId?: string | null;
}

export interface CredentialRow {
  id: string;
  kind: CredentialKind | string;
  stationId?: string | null;
  boxId?: string | null;
  label?: string | null;
  /** A code has been issued and nothing has redeemed it yet. */
  pairingOutstanding?: boolean;
  pairingCodeExpiresAt?: string | null;
  pairedAt?: string | null;
  pairedByAccountId?: string | null;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
  scopes?: string[];
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const fleetApi = {
  /** The boxes standing at a branch, whether or not a station uses them yet. */
  boxes: (branchId: string) =>
    api.get<{ boxes: BoxRow[] }>(`/branches/${encodeURIComponent(branchId)}/boxes`),

  /**
   * Creates the row and mints its claim code. The code comes back ONCE, in
   * this response, because only its hash is stored — so the page shows it
   * until the panel is closed and never pretends it can fetch it again.
   *
   * WHY THE CODE IS OPTIONAL HERE. The API deliberately keeps it out of the
   * body it files against this Idempotency-Key, so a replayed request answers
   * with the box and no code at all. That is the point rather than a gap: a
   * one-time code that can be read a second time out of a stored response is
   * not one-time. The panel says so and offers to issue a fresh one.
   */
  createBox: (branchId: string, body: { name: string; slot: string; role: BoxRole }) =>
    api.post<{ box: BoxRow; claimCode?: string; expiresAt?: string }>(
      `/branches/${encodeURIComponent(branchId)}/boxes`,
      body,
      { idempotencyKey: idemKey() },
    ),

  updateBox: (
    id: string,
    body: { name?: string; slot?: string; role?: BoxRole; status?: BoxStatus },
  ) => api.patch<{ box: BoxRow }>(`/boxes/${encodeURIComponent(id)}`, body),

  /**
   * Re-issues a claim code for a box nobody managed to register in time. The
   * new code supersedes the old one, and it is returned on the same terms as
   * `createBox`: once, and never from a replay.
   */
  reissueClaimCode: (id: string) =>
    api.post<{ claimCode?: string; expiresAt?: string }>(
      `/boxes/${encodeURIComponent(id)}/claim-code`,
      undefined,
      { idempotencyKey: idemKey() },
    ),

  /**
   * What that box has reported. Devices are asked for per box and never per
   * branch, because a printer is reachable through the box it is plugged into
   * and through no other.
   */
  boxDevices: (boxId: string) =>
    api.get<{ devices: DeviceRow[] }>(`/boxes/${encodeURIComponent(boxId)}/devices`),

  /**
   * Declares a device the box cannot find on its own. A printer on the LAN is
   * the case that matters: nothing announces a TCP socket at
   * `192.168.88.204:9100`, so somebody has to say it is there. Anything the
   * box discovers — a scanner on USB, a terminal on a serial port — appears
   * without this.
   */
  createDevice: (
    boxId: string,
    body: {
      kind: DeviceKind;
      label: string;
      transport: DeviceTransport;
      address?: string;
      model?: string;
      protocol?: string;
      serialNumber?: string;
      terminalId?: string;
      merchantId?: string;
      settings?: DeviceSettings;
    },
  ) =>
    api.post<{ device: DeviceRow }>(`/boxes/${encodeURIComponent(boxId)}/devices`, body, {
      idempotencyKey: idemKey(),
    }),

  updateDevice: (
    id: string,
    body: {
      label?: string;
      address?: string | null;
      model?: string | null;
      protocol?: string | null;
      serialNumber?: string | null;
      terminalId?: string | null;
      merchantId?: string | null;
      /** Left out keeps what the row has; null clears it. */
      settings?: DeviceSettings | null;
    },
  ) => api.patch<{ device: DeviceRow }>(`/devices/${encodeURIComponent(id)}`, body),

  /**
   * Archives it. A device that left the park is kept rather than deleted:
   * assignments and command history still point at it.
   *
   * The answer names the stations that were still using it, because the
   * consequence is silent otherwise — the config bundle simply stops carrying
   * that device and a till discovers it has no receipt printer at the moment
   * somebody is waiting for a receipt.
   */
  archiveDevice: (id: string) =>
    api.delete<{ ok: true; stillAssignedTo?: StationAssignmentRef[] }>(
      `/devices/${encodeURIComponent(id)}`,
    ),

  /** Every live station of a branch, the hidden ones included. Admins only. */
  stations: (branchId: string) =>
    api.get<{ stations: StationRow[] }>(`/branches/${encodeURIComponent(branchId)}/stations`),

  createStation: (branchId: string, body: StationWrite) =>
    api.post<{ station: StationRow }>(`/branches/${encodeURIComponent(branchId)}/stations`, body, {
      idempotencyKey: idemKey(),
    }),

  updateStation: (id: string, body: StationWrite) =>
    api.patch<{ station: StationRow }>(`/stations/${encodeURIComponent(id)}`, body),

  archiveStation: (id: string) => api.delete<{ ok: true }>(`/stations/${encodeURIComponent(id)}`),

  /** The staff of one branch, for a station's access list. */
  branchStaff: (branchId: string) =>
    api.get<{ staff: BranchStaffMember[] }>(`/branches/${encodeURIComponent(branchId)}/staff`),

  commands: (boxId: string, limit = 25) =>
    api.get<{ commands: BoxCommandRow[] }>(
      `/boxes/${encodeURIComponent(boxId)}/commands${qs({ limit })}`,
    ),

  /**
   * Queues one command. The action id comes back so the page can jump straight
   * to the lines this command wrote, which is the whole point of the log
   * drawer: press the button, then watch that one action rather than the noise
   * of a working box.
   *
   * **Test print is not one of these** (SCRUM-364). It goes through
   * `printApi.stationTestPrint` in `api/print.ts`, because a command queued
   * here is the only row a test print leaves: the box then reports its outcome
   * against an `edge.print_job` that was never written, the platform answers
   * `PRINT_JOB_NOT_FOUND`, and the Printing panel lists nothing.
   */
  sendCommand: (boxId: string, body: { kind: BoxCommandKind; payload?: Record<string, unknown> }) =>
    api.post<{ commandId: string; actionId?: string | null }>(
      `/boxes/${encodeURIComponent(boxId)}/commands`,
      body,
      { idempotencyKey: idemKey() },
    ),

  /**
   * The box's own account of itself: the lines it last handed over as the
   * result of a `collect_logs` command, laid out by the platform. `collectedAt`
   * says when that was, null for a box never asked. A 404 still reads as "not
   * on this deployment" for a platform from before the route existed.
   */
  log: (boxId: string, params: { limit?: number; actionId?: string } = {}) =>
    api.get<{
      lines: BoxLogLine[];
      truncated?: boolean;
      collectedAt?: string | null;
      commandId?: string | null;
    }>(`/boxes/${encodeURIComponent(boxId)}/log${qs({ limit: 500, ...params })}`),

  heartbeats: (boxId: string, limit = 30) =>
    api.get<{ heartbeats: BoxHeartbeatRow[] }>(
      `/boxes/${encodeURIComponent(boxId)}/heartbeats${qs({ limit })}`,
    ),

  credentials: (branchId: string, includeRevoked = false) =>
    api.get<{ credentials: CredentialRow[] }>(
      `/branches/${encodeURIComponent(branchId)}/credentials${qs({ includeRevoked: includeRevoked || undefined })}`,
    ),

  /** Read the same customer view the station exposes, without taking its lease. */
  displaySnapshot: (stationId: string) =>
    api.get<{ view: 'customer'; document: StationSessionDocument; serverTime: string }>(
      `/stations/${encodeURIComponent(stationId)}/session?view=customer`,
    ),

  /**
   * Mints a pairing code. Like a box's claim code it is returned ONCE and only
   * its hash is kept, so the page shows it until the panel closes and never
   * offers to show it again — a code that can be re-read from a screen is a
   * credential lying around the back office. A replay of this request answers
   * with the credential and no code, for the reason given on `createBox`.
   */
  pair: (stationId: string, body: { kind: CredentialKind; label?: string }) =>
    api.post<{ credential: CredentialRow; pairingCode?: string; expiresAt?: string }>(
      `/stations/${encodeURIComponent(stationId)}/credentials`,
      body,
      { idempotencyKey: idemKey() },
    ),

  /** Claim the short-lived code shown by the display. No credential secret is returned here. */
  claimDisplay: (stationId: string, body: { pairingCode: string; name: string }) =>
    api.post<{
      station: { id: string; name: string; kind: string };
      device: { id: string; name: string };
    }>(`/stations/${encodeURIComponent(stationId)}/displays/claim`, body, {
      idempotencyKey: idemKey(),
    }),

  /** Revoking is not deleting: the row stays, with who revoked it and why. */
  revokeCredential: (id: string, reason?: string) =>
    api.post<{ ok: true }>(`/credentials/${encodeURIComponent(id)}/revoke`, { reason }, {
      idempotencyKey: idemKey(),
    }),
};

/**
 * Who can be added to a station's list, with a fallback for a deployment that
 * has not grown the route yet.
 *
 * The park's rule is "from the staff of that branch". Where the branch route is
 * absent the console falls back to the operator-wide account directory and SAYS
 * the list is not filtered — an unfiltered list that looks filtered is how
 * somebody at the other branch ends up on a till they will never stand at.
 */
export async function staffCandidates(
  branchId: string,
): Promise<{ staff: BranchStaffMember[]; branchFiltered: boolean }> {
  try {
    const { staff } = await fleetApi.branchStaff(branchId);
    return { staff, branchFiltered: true };
  } catch (err) {
    if (!isMissingRoute(err)) throw err;
    const { accounts } = await api.get<{
      accounts: { id: string; phone: string; status: string; employee: { name: string } | null }[];
    }>('/accounts');
    return {
      staff: accounts.map((a) => ({
        accountId: a.id,
        name: a.employee?.name ?? null,
        phone: a.phone,
        status: a.status,
      })),
      branchFiltered: false,
    };
  }
}

/**
 * Change one tender's target without touching the rest of the document.
 *
 * The routing jsonb is shared with tenders this console does not know about
 * yet (S2-10a), and a page that sent only the two fields it understands would
 * quietly delete the others.
 */
export function mergeRouting(
  current: PaymentRouting | null | undefined,
  change: Partial<PaymentRouting>,
): PaymentRouting {
  return { ...(current ?? {}), ...change };
}

// ---------------------------------------------------------------------------
// Reading a box's vitals, wherever the API happens to put them
// ---------------------------------------------------------------------------

export interface BoxVitals {
  agentVersion: string | null;
  uptimeSeconds: number | null;
  outboxDepth: number | null;
  tempC: number | null;
  /**
   * How far the box's clock is from the platform's, positive when it is
   * ahead: the box's own measurement where it declared one (SCRUM-402), the
   * api's computation from its heartbeat otherwise.
   */
  clockOffsetMs: number | null;
  /**
   * How long ago that was measured, in seconds — reckoned from the heartbeat
   * age the api counted, for the reason `heartbeatAgeSeconds` is.
   */
  clockMeasuredAgeSeconds: number | null;
  heartbeatAgeSeconds: number | null;
}

/**
 * The numbers a box reports, read from the flattened fields when the API sends
 * them and out of `last_status` when it does not.
 *
 * `last_status` is the newest heartbeat held whole on the box row, and its
 * shape is still moving with S2-05 and S2-06. Reading it defensively is what
 * lets this page show a version and an uptime the day the agent starts sending
 * them, without waiting for the list route to grow a column for each.
 */
export function boxVitals(box: BoxRow): BoxVitals {
  const status = (box.lastStatus ?? {}) as Record<string, unknown>;
  const num = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = status[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };
  const heartbeatAge =
    box.heartbeatAgeSeconds ??
    (box.lastHeartbeatAt
      ? Math.max(0, Math.round((Date.now() - new Date(box.lastHeartbeatAt).getTime()) / 1000))
      : null);
  return {
    agentVersion:
      box.agentVersion ?? (typeof status.agentVersion === 'string' ? status.agentVersion : null),
    uptimeSeconds: box.uptimeSeconds ?? num('uptimeS', 'uptimeSeconds'),
    outboxDepth: box.outboxDepth ?? num('outboxDepth'),
    tempC: box.tempC ?? num('tempC'),
    clockOffsetMs: box.clockOffsetMs ?? num('clockOffsetMs'),
    clockMeasuredAgeSeconds: secondsBeforeNow(
      // A heartbeat from before the box measured itself carries no time of its
      // own: the api computed that offset as it took the heartbeat.
      typeof status.clockMeasuredAt === 'string'
        ? status.clockMeasuredAt
        : typeof status.receivedAt === 'string'
          ? status.receivedAt
          : (box.lastHeartbeatAt ?? null),
      box.lastHeartbeatAt ?? null,
      heartbeatAge,
    ),
    heartbeatAgeSeconds: heartbeatAge,
  };
}

/**
 * How long before now an instant on the platform's clock was: the heartbeat's
 * age as the api counted it, plus how much earlier than that heartbeat the
 * instant is. A back-office laptop with a wrong clock reads the same answer as
 * every other desk; only with no heartbeat age to go on is this machine's
 * clock used.
 */
function secondsBeforeNow(
  iso: string | null,
  lastHeartbeatAt: string | null,
  heartbeatAgeSeconds: number | null,
): number | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const beat = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : Number.NaN;
  const seconds =
    heartbeatAgeSeconds !== null && Number.isFinite(beat)
      ? heartbeatAgeSeconds + (beat - at) / 1000
      : (Date.now() - at) / 1000;
  return Math.max(0, Math.round(seconds));
}

/**
 * Within this a box's clock is in step with the platform: the same minute the
 * sync ledger allows before it overrules a box's clock, and the Health page's
 * `box.clock` rule allows before it raises one.
 */
export const CLOCK_IN_STEP_MS = 60_000;

/**
 * Past this the clock line wears the warning colour: ten minutes is where the
 * booth flags every spin it takes as `clockSuspect` (SCRUM-402).
 */
export const CLOCK_WARN_AFTER_MS = 10 * 60_000;

/** A span as a person says it: "45 s", "3 min", "12 h", "3 days". */
function spokenSpan(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / 86_400_000)} days`;
}

/** One heartbeat's clock, for its row: "in step", "12 h behind", "3 min ahead". */
export function clockOffsetWords(offsetMs: number): string {
  if (Math.abs(offsetMs) <= CLOCK_IN_STEP_MS) return 'in step';
  return `${spokenSpan(Math.abs(offsetMs))} ${offsetMs > 0 ? 'ahead' : 'behind'}`;
}

/**
 * The box drawer's clock line, as a person would say it (SCRUM-402).
 *
 * "Clock in step with the platform", "Clock 12 h behind the platform (measured
 * 3 min ago)", or "Clock not measured yet". A box that corrects its clock
 * stamps and prints the platform's time either way, so this is not a fault on
 * its paper. It is the machine's own clock — wrong after a power cut when the
 * Pi has no clock battery and the network blocks time sync — and it is what
 * the box falls back on after its next reboot, until the platform answers it.
 * `warn` is past ten minutes.
 */
export function clockLine(
  vitals: Pick<BoxVitals, 'clockOffsetMs' | 'clockMeasuredAgeSeconds'>,
): { words: string; warn: boolean } {
  const offset = vitals.clockOffsetMs;
  if (offset === null) return { words: 'Clock not measured yet', warn: false };
  if (Math.abs(offset) <= CLOCK_IN_STEP_MS) {
    return { words: 'Clock in step with the platform', warn: false };
  }
  const ago = vitals.clockMeasuredAgeSeconds;
  const measured =
    ago === null
      ? ''
      : ago < 10
        ? ' (measured just now)'
        : ` (measured ${spokenSpan(ago * 1000)} ago)`;
  return {
    words: `Clock ${spokenSpan(Math.abs(offset))} ${offset > 0 ? 'ahead of' : 'behind'} the platform${measured}`,
    warn: Math.abs(offset) > CLOCK_WARN_AFTER_MS,
  };
}

/**
 * A box is late when it has been silent for longer than two heartbeats.
 *
 * The watchdog's own threshold is `BOX_OFFLINE_AFTER_S` and it is the one that
 * opens an alert; this is only what the page paints amber with, so that a box
 * drifting quiet is visible here a minute or two before the alert lands.
 */
export const HEARTBEAT_LATE_AFTER_S = 150;

/** A refusal the page can act on, told apart from a route that is simply absent. */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.code === 'FORBIDDEN');
}

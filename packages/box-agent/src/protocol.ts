import { z } from 'zod';

/**
 * The wire between a box and the cloud (S2-04).
 *
 * This file is the single definition of that contract: the api validates
 * requests with these schemas and generates its OpenAPI from them, and the
 * agent builds its bodies against the same types. A box in a shopping mall is
 * updated on a different schedule from the api in front of it, so the two ends
 * drifting apart is not a hypothetical — keeping one copy is what makes a
 * change to the contract a change both ends see at compile time.
 *
 * Two rules the shapes below follow, and that every later field must follow:
 *
 *   - **Nothing personal crosses this wire upwards.** A heartbeat carries
 *     counts, states and error FINGERPRINTS. Not a member, not a phone, not a
 *     line of a receipt. The box knows all of those and has no reason to
 *     report them, and telemetry is the one stream nobody reads until the day
 *     something has already gone wrong.
 *   - **A box only ever speaks about itself.** No request body names a box, a
 *     station or a device belonging to anyone else — the box the credential
 *     names is the whole scope, and the api takes it from the credential
 *     rather than from anything the box sends.
 */

/**
 * The agent's own version, reported on every registration and heartbeat and
 * compared against the cloud's `minSupportedAgentVersion`.
 *
 * Bumped when the agent changes in a way the cloud can see — a new command
 * kind understood, a field added to the heartbeat — not on every edit.
 */
export const BOX_AGENT_VERSION = '0.1.0';

/** `Authorization: Bearer <boxId>.<secret>` — see `services/box.ts`. */
export const BOX_CREDENTIAL_SEPARATOR = '.';

export function boxCredential(boxId: string, secret: string): string {
  return `${boxId}${BOX_CREDENTIAL_SEPARATOR}${secret}`;
}

// --- Registration -----------------------------------------------------------

export const BoxRegisterRequestSchema = z.object({
  /** Single-use, short-lived, issued by an administrator on the Console. */
  claimCode: z.string().min(6).max(64),
  agentVersion: z.string().min(1).max(32),
  /** What the machine calls itself — useful when a slot holds the wrong Pi. */
  hostname: z.string().max(128).optional(),
});
export type BoxRegisterRequest = z.infer<typeof BoxRegisterRequestSchema>;

export interface BoxRegisterResponse {
  boxId: string;
  /**
   * Returned once and never stored in readable form. An agent that loses it
   * cannot ask for it again: the claim code is spent, and recovery is an
   * administrator issuing a new one. Write it down before acknowledging.
   */
  secret: string;
  name: string;
  slot: string;
  role: string;
  branchId: string;
  operatorId: string;
  /** The journal epoch this box stamps its events with (S2-05). */
  epoch: number;
  heartbeatIntervalS: number;
  minSupportedAgentVersion: string;
}

// --- Heartbeat --------------------------------------------------------------

export const DEVICE_REACHABILITY = ['unknown', 'reachable', 'unreachable'] as const;
export const DEVICE_PAPER_STATES = ['unknown', 'ok', 'low', 'out'] as const;

export const DeviceReportSchema = z.object({
  /** The device id from the config bundle, when the box knows which row it is. */
  id: z.string().uuid().optional(),
  /** `192.168.88.204:9100`, `/dev/ttyACM0` — how the box found it. */
  address: z.string().max(128).optional(),
  kind: z.string().max(32).optional(),
  model: z.string().max(128).optional(),
  reachability: z.enum(DEVICE_REACHABILITY),
  paperStatus: z.enum(DEVICE_PAPER_STATES).optional(),
  /** A short label for the last fault. Never a device payload. */
  lastError: z.string().max(200).optional(),
});
export type DeviceReport = z.infer<typeof DeviceReportSchema>;

export const BoxHeartbeatRequestSchema = z.object({
  /**
   * The box's own clock. `received_at` is what the cloud trusts; the
   * difference between the two is the offset the watchdog alerts on, and the
   * monotonic ordering of this field is what stops a captured heartbeat being
   * replayed to make a dead box look alive.
   */
  reportedAt: z.string().datetime(),
  agentVersion: z.string().min(1).max(32),
  uptimeS: z.number().int().min(0).optional(),
  /** Null on a virtual box, which has no thermometer — never 0, which reads as cold. */
  tempC: z.number().nullable().optional(),
  /** Unsynced events waiting on the box: the number that says whether offline is safe. */
  outboxDepth: z.number().int().min(0).optional(),
  /** The config version the box has actually applied, so drift is visible. */
  configVersion: z.string().max(64).optional(),
  /** The box has been put into offline mode deliberately (S2-05). */
  offline: z.boolean().optional(),
  devices: z.array(DeviceReportSchema).max(64).default([]),
  leases: z
    .array(
      z.object({
        stationId: z.string().uuid(),
        /** Which client holds the station session — an opaque id, never a person. */
        holder: z.string().max(64),
        expiresAt: z.string().datetime(),
      }),
    )
    .max(32)
    .default([]),
  /**
   * What has been going wrong, as fingerprints and counts. The message itself
   * stays on the box: a printer error can quote the line it failed to print.
   */
  errors: z
    .array(
      z.object({
        fingerprint: z.string().max(32),
        code: z.string().max(64),
        count: z.number().int().min(1),
      }),
    )
    .max(32)
    .default([]),
});
export type BoxHeartbeatRequest = z.infer<typeof BoxHeartbeatRequestSchema>;

export interface BoxHeartbeatAck {
  receivedAt: string;
  serverTime: string;
  /** Positive means the box is ahead of the cloud. */
  clockOffsetMs: number;
  /** What the box's configuration SHOULD be; pull the bundle when it differs. */
  configVersion: string;
  minSupportedAgentVersion: string;
  heartbeatIntervalS: number;
  /** Queued commands waiting — the agent polls immediately rather than waiting. */
  commandsPending: number;
  epoch: number;
  /** Reports matched to a device row of this box, and reports that matched nothing. */
  devicesMatched: number;
  devicesUnknown: number;
}

// --- Config bundle ----------------------------------------------------------

export interface BoxConfigDevice {
  id: string;
  /** What this device does for the station: `receipt`, `kids_band`, `scanner`, … */
  role: string;
  kind: string;
  label: string;
  transport: string;
  address: string | null;
  model: string | null;
  protocol: string | null;
  serialNumber: string | null;
  terminalId: string | null;
  merchantId: string | null;
}

export interface BoxConfigStation {
  id: string;
  name: string;
  kind: string;
  codePrefix: string | null;
  capabilities: string[];
  configVersion: number;
  paymentRouting: unknown;
  offlineWalletCapSatang: number | null;
  accessScope: string;
  devices: BoxConfigDevice[];
}

export interface BoxConfigBundle {
  /**
   * One short hash over everything below. The agent compares this and nothing
   * else, so "the till has the wrong printer" is answerable by one string
   * rather than by a diff of two documents.
   */
  configVersion: string;
  box: {
    id: string;
    name: string;
    slot: string;
    role: string;
    epoch: number;
    status: string;
  };
  branch: {
    id: string;
    code: string;
    name: string;
    timezone: string;
    openingHours: unknown;
    businessDayStart: string;
  };
  stations: BoxConfigStation[];
  /** PUBLIC halves only — what a box needs to verify a staff token offline. */
  signingKeys: Array<{ purpose: string; kid: string; algorithm: string; publicKey: string }>;
  heartbeatIntervalS: number;
  minSupportedAgentVersion: string;
}

// --- Commands ---------------------------------------------------------------

export const BOX_COMMAND_KINDS = [
  'test_print',
  'config_apply',
  'clear_cache',
  'collect_logs',
  'restart',
  'go_offline',
  'go_online',
  'reset_store',
] as const;
export type BoxCommandKind = (typeof BOX_COMMAND_KINDS)[number];

export const BoxCommandPollRequestSchema = z.object({
  /** How many to take at once. Small: a box that dies mid-batch re-runs less. */
  max: z.number().int().min(1).max(10).default(5),
});

export interface BoxCommandHandout {
  id: string;
  kind: BoxCommandKind;
  payload: unknown;
  /** `x-oto-action-id`, minted where somebody pressed the button. */
  actionId: string | null;
  attempts: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface BoxCommandPollResponse {
  commands: BoxCommandHandout[];
  serverTime: string;
}

export const BoxCommandResultRequestSchema = z.object({
  state: z.enum(['succeeded', 'failed']),
  /** Counts and states the Console shows; never a printed line. */
  result: z.record(z.unknown()).optional(),
  errorCode: z.string().max(64).optional(),
  errorMessage: z.string().max(500).optional(),
});
export type BoxCommandResultRequest = z.infer<typeof BoxCommandResultRequestSchema>;

export interface BoxCommandResultResponse {
  id: string;
  state: string;
  /**
   * True when this result was already recorded and nothing was written again.
   * A box that retries because the acknowledgement was lost must not reset a
   * store twice, and this is how it learns that it did not.
   */
  replayed: boolean;
  /** After a `reset_store`, the new journal epoch the box must stamp from. */
  epoch: number;
}

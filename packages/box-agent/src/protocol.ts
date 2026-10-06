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
  /**
   * The PUBLIC half of the box's sync signing key, SPKI PEM (S2-05).
   *
   * Presented once, at registration, and kept in `core.box.sync_public_key`.
   * The private half never leaves the box, which is the whole point: the
   * cloud holds only what it needs to VERIFY a box's events and nothing it
   * could use to forge them. Optional so that an agent older than S2-05 still
   * registers; such a box can queue nothing until it has a key.
   */
  syncPublicKey: z.string().max(1024).optional(),
  syncKeyAlgorithm: z.enum(['ed25519']).optional(),
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

/**
 * What a booth box reports about the wheel it is running (S2-07a).
 *
 * Counts and states, like everything else on this wire: no code, no prize
 * name, no member, and — the one that matters here — no staff identity.
 * `staffSignedIn` is a boolean rather than an account id on purpose. Health
 * needs to know that vouchers are printing with nobody attending the booth;
 * it does not need to know who is standing there, and a telemetry stream is
 * the last place to put a name that nothing reads until something has already
 * gone wrong.
 *
 * **One booth per box.** The block is a single object, not a list keyed by
 * station, because a booth box boots into the game and runs one wheel. A box
 * that ever hosts two booths needs this as an array with a `stationId` on each
 * entry, and that is a change to the shape rather than a field added to it.
 */
export const BoothHeartbeatSchema = z.object({
  /**
   * `booth.booth_config_version.version` — the published wheel the box is
   * actually running. **Null means it has never synced one**, which is a
   * distinct state from version 1: the television shows its no-wheel screen —
   * "This booth is being set up — please ask our staff" while the box is
   * online, "Booth not set up, connect to internet" while it is not — and the
   * button does nothing.
   *
   * A number rather than the box-wide `configVersion` above, which is a hash
   * of the whole box's configuration. They answer different questions and a
   * booth that has pulled its station config but not a wheel is exactly the
   * case where the two disagree.
   */
  configVersion: z.number().int().positive().nullable(),
  /**
   * Tri-state, not a boolean, and the distinction is one this fleet has
   * already been bitten by: "could not ask" is not "not reachable". A booth
   * whose printer the agent has not probed yet reports `unknown`, and Health
   * must not draw a fault from it.
   */
  printerReachable: z.enum(DEVICE_REACHABILITY),
  paperStatus: z.enum(DEVICE_PAPER_STATES),
  /** Minted vouchers whose facts the cloud has not acknowledged. The offline count. */
  vouchersPending: z.number().int().min(0),
  /** The box's own stamp, as with every other time on this wire. Null: no spin yet. */
  lastSpinAt: z.string().datetime().nullable(),
  /** Whether SOMEBODY is signed in. Never who. See the note above. */
  staffSignedIn: z.boolean(),
  /**
   * The prizes that have hit their daily cap on this booth today, by
   * `booth.booth_prize.id`. Configuration, not people — which is why ids are
   * allowed here at all.
   *
   * It is a list rather than a count because the alert names the prize, and
   * because "the 200 baht voucher ran out at eleven" is the fact the booth
   * report is asked for. Bounded, since a wheel has slices rather than a
   * catalogue behind it.
   */
  dailyCapsReached: z.array(z.string().uuid()).max(64).default([]),
});
export type BoothHeartbeat = z.infer<typeof BoothHeartbeatSchema>;

export const BoxHeartbeatRequestSchema = z.object({
  /**
   * The box's clock as the box corrects it (SCRUM-402): once it has measured
   * itself against the platform in this boot, this is the platform's time as
   * the box reckons it, and until then it is the machine's own. `received_at`
   * is what the cloud trusts; a heartbeat further from it than
   * `BOX_MAX_CLOCK_SKEW_S` is refused (`BOX_CLOCK_SKEW_ERROR`), and the
   * monotonic ordering of this field (`BOX_HEARTBEAT_STALE_ERROR`) is what
   * stops a captured heartbeat being replayed to make a dead box look alive.
   * How far out the machine's clock itself is travels in `clock`, below.
   */
  reportedAt: z.string().datetime(),
  agentVersion: z.string().min(1).max(32),
  /**
   * The box's sync public key, when it has one the cloud may not (S2-05).
   *
   * A box that registered before S2-05 has a spent claim code and no way back
   * through `/register`, so the one channel it still has for handing over a
   * newly minted public half is this one — authenticated by the box secret,
   * which is the same proof registration used. It is also how a rotation
   * reaches the cloud.
   */
  syncPublicKey: z.string().max(1024).optional(),
  uptimeS: z.number().int().min(0).optional(),
  /** Null on a virtual box, which has no thermometer — never 0, which reads as cold. */
  tempC: z.number().nullable().optional(),
  /** Unsynced events waiting on the box: the number that says whether offline is safe. */
  outboxDepth: z.number().int().min(0).optional(),
  /**
   * How long the oldest unacknowledged event has been waiting, in seconds.
   *
   * Depth alone does not say whether a box is stuck: three events queued a
   * minute ago is a busy till, three queued yesterday is a box that has been
   * talking to the cloud and failing to hand anything over. The watchdog's
   * "online but oldest unacked > SYNC_STALE_AFTER_S" rule reads this field.
   */
  oldestUnackedS: z.number().int().min(0).nullable().optional(),
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
   * Present only on a box running a booth (S2-07a), and optional so that every
   * till in the fleet — and every agent built before this ticket — sends a
   * heartbeat this schema still accepts.
   */
  booth: BoothHeartbeatSchema.optional(),
  /**
   * The offline copies this box is holding (SCRUM-323).
   *
   * `appliedAt` is when bytes last landed, `checkedAt` when the cloud last said
   * the copy was current — a 304 moves the second and not the first — and
   * `scopes` is how many documents the box holds. Nothing in it names a person
   * or quotes a record, which is what lets it sit on `box.last_status` and be
   * read over somebody's shoulder in a back office.
   *
   * Optional, like the booth block: a box that has pulled nothing yet sends no
   * block rather than a block of nulls, and an older agent's heartbeat is still
   * accepted.
   */
  cache: z
    .object({
      appliedAt: z.string().datetime().nullable().optional(),
      checkedAt: z.string().datetime().nullable().optional(),
      scopes: z.number().int().min(0).max(64).optional(),
    })
    .optional(),
  /**
   * The box's own measurement of its clock against the platform's (SCRUM-402).
   *
   * A Pi with no clock battery comes back from a power cut with the time it
   * last saved, and a mall network that lets HTTPS out but not NTP never puts
   * it right. So the box measures on every heartbeat — its time just before
   * sending and just after the answer, against the answer's `serverTime` —
   * and stamps and prints the platform's time from then on. That makes
   * `reportedAt` a corrected time, and the offset the cloud computes from it
   * says next to nothing about the machine; this block is what does.
   *
   * `offsetMs` is box minus platform, positive when the box is ahead — the
   * sign `BoxHeartbeatAck.clockOffsetMs` uses. `measuredAt` is the platform's
   * time when it was taken. Both null: nothing measured since this box booted.
   * A measurement is never carried across a reboot, because the clock it
   * described is not the clock the machine came back with.
   *
   * Optional, so an agent older than this still reports; the cloud then keeps
   * its own computation, as it always did.
   */
  clock: z
    .object({
      offsetMs: z.number().int().nullable(),
      measuredAt: z.string().datetime().nullable(),
    })
    .optional(),
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
  /**
   * The cloud's clock as it took the heartbeat. The box measures its own
   * clock against this on every answer (SCRUM-402), and a heartbeat refused
   * for its clock carries it too, in `BoxClockSkewDetails`.
   */
  serverTime: string;
  /**
   * `reportedAt` minus `receivedAt`: positive means the box is ahead of the
   * cloud. For a box that corrects its clock (SCRUM-402) this is what is left
   * after the correction, plus the time on the wire; the machine's own offset
   * is the one the box declares in the heartbeat's `clock` block.
   */
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

/**
 * The code a heartbeat is refused with when its `reportedAt` is further from
 * the cloud's clock than `BOX_MAX_CLOCK_SKEW_S` (fifteen minutes by default).
 */
export const BOX_CLOCK_SKEW_ERROR = 'BOX_CLOCK_SKEW';

/**
 * What that refusal carries in `error.details` (SCRUM-402).
 *
 * The refusal is the one answer a box with a badly wrong clock is sure to
 * get, so it has to be enough to measure by: the cloud's time, taken as it
 * handled the request, which the box adopts exactly as it adopts an accepted
 * answer's `serverTime`. Its next heartbeat then reports the platform's time
 * and is accepted. Without this a Pi that came back from a power cut hours
 * behind was refused on every heartbeat and shown offline, and nothing on the
 * Console named the clock.
 */
export interface BoxClockSkewDetails {
  serverTime: string;
  /** `reportedAt` minus the cloud's time: positive when the box is ahead. */
  clockOffsetMs: number;
  /** The bound it was refused against. */
  maxClockSkewS: number;
}

/**
 * The code a heartbeat is refused with when its `reportedAt` is at or before
 * the last one the cloud accepted from this box: the replay defence.
 */
export const BOX_HEARTBEAT_STALE_ERROR = 'BOX_HEARTBEAT_STALE';

/**
 * What that refusal carries in `error.details` (SCRUM-402).
 *
 * A box that corrects its clock leaves the cloud's watermark on the
 * platform's time, and a new process forgets where it stood: its floor under
 * `reportedAt` starts at nothing, and after a reboot the measurement is set
 * aside and it reports its raw clock again. A Pi whose raw clock is a few
 * minutes behind after a reboot, or a box that restarted while its floor was
 * holding its reports after one it had sent ahead, then reports inside
 * `BOX_MAX_CLOCK_SKEW_S` and at or before the watermark. Refused as stale
 * with nothing said, it was refused on every heartbeat until real time passed
 * the watermark: shown offline, and unable to measure itself. So the refusal
 * says what time it is and where the watermark stands. The box measures
 * itself against `serverTime` exactly as against a skew refusal's, and raises
 * its floor to `lastAcceptedReportedAt`, so its next heartbeat is after it
 * and accepted.
 *
 * Nothing in it is secret: `serverTime` is any answer's, and the watermark is
 * a time this box itself sent.
 */
export interface BoxHeartbeatStaleDetails {
  serverTime: string;
  /** The last `reportedAt` the cloud accepted from this box. */
  lastAcceptedReportedAt: string;
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
  /**
   * Per-unit facts that cannot be derived from the model (S2-06).
   *
   * `DeviceSettings` in `@oto/shared`: whether this XP-80 is 576 or 512 dots
   * per line, what band stock is loaded on this 4B-2082A, which mode this
   * scanner is in. Typed `unknown` on the wire and validated where it is read,
   * for the reason the rest of this file gives — a box is updated on its own
   * schedule, and a field added to this document must not stop an older agent
   * parsing its bundle.
   */
  settings?: unknown;
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

/**
 * A print template as it crosses the wire.
 *
 * Structurally `PrintTemplate` from `@oto/shared` and validated with that
 * package's schema where it is read. Declared structurally here rather than
 * imported so this file stays the single statement of what the wire carries —
 * a reader of the contract should not have to open another package to learn
 * what a box is sent.
 */
export interface PrintTemplateWire {
  id: string;
  type: string;
  name: string;
  showLogo: boolean;
  headerText?: string | null;
  footerText?: string | null;
  fields: Record<string, boolean | undefined>;
  version: number;
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
    /**
     * Present so a box restored from its credential file — which never
     * re-registers, because the claim code is spent — can still stamp a
     * station session row with the operator it belongs to. Optional so an api
     * that has not added it yet still produces a bundle this agent accepts.
     */
    operatorId?: string;
    timezone: string;
    openingHours: unknown;
    businessDayStart: string;
  };
  stations: BoxConfigStation[];
  /**
   * The branch's print templates (S2-06).
   *
   * They ride the config bundle rather than a cache scope of their own because
   * they are branch configuration read by exactly the things the bundle is
   * already for, and because that is what makes "toggle a field, run a test
   * print, see the change" work with no redeploy: the edit bumps the bundle's
   * `configVersion`, the next heartbeat's ack differs, and the box pulls.
   *
   * Optional, so a box older than S2-06 still accepts a bundle carrying them,
   * and an empty list is meaningful: `printFieldOn` treats no template as
   * "print every applicable field", which is what a new branch does.
   */
  printTemplates?: PrintTemplateWire[];
  /** PUBLIC halves only — what a box needs to verify a staff token offline. */
  signingKeys: Array<{ purpose: string; kid: string; algorithm: string; publicKey: string }>;
  /**
   * The park's band key (`BAND_HMAC_KEY`, S2-11) — the one secret this
   * document carries, and why it carries one.
   *
   * A band code is signed with an HMAC (`verifyBandCode` in `@oto/shared`), so
   * checking one with the link down takes the same key that signed it: there
   * is no public half to send instead, which is what `signingKeys` above sends
   * for a staff token. The bundle is the channel the box already trusts for
   * its configuration — fetched over the box's own credential, never logged,
   * and written by a Raspberry Pi only to its home directory with the
   * credential's own permissions (`fileConfigCache` in `runner/runtime.ts`).
   *
   * Optional and nullable: an api that does not send it yet, or a deployment
   * with no key configured, leaves the box classifying band codes and saying
   * it cannot check them (`BAND_KEY_MISSING`) rather than guessing. A host
   * that holds the key itself — the virtual box inside the api — passes it as
   * `BoxAgentOptions.bands.key`, which wins over this.
   */
  bandKey?: string | null;
  heartbeatIntervalS: number;
  minSupportedAgentVersion: string;
}

/**
 * The booth's published wheel, as it reaches a box (S2-07a).
 *
 * **It does not ride `BoxConfigBundle`.** That document is the box's stations,
 * devices and print templates, and it is pulled when its hash changes; a wheel
 * is published on its own cadence, is compared by its own `bundle_hash`, and
 * has to be applied whole or not at all. So it travels as the `booth` cache
 * scope (`SYNC_CHANGE_SCOPES`), beside members and the catalogue, and the box
 * keeps the latest version it has applied.
 *
 * Re-exported from `@oto/shared` rather than restated here, which is the
 * opposite of what `PrintTemplateWire` above does, and deliberately: a print
 * template is read by the box alone, while this same document is read by the
 * page on the television, drawn from by the box, and written by the api that
 * publishes it. Three readers of one hashed document is the case where a
 * structural copy that drifts by one optional field costs nothing at compile
 * time and produces a wheel whose slices do not match its own odds.
 */
export type {
  BoothConfigBundle,
  BoothConfigLayout,
  BoothConfigPrize,
  BoothConfigSettings,
} from '@oto/shared';

// --- Commands ---------------------------------------------------------------

/**
 * What a box can be asked to do.
 *
 * **This list is a CHECK constraint in `edge.box_command`**, so it is one of
 * the few places in this repository where four copies of a vocabulary have to
 * agree: here, `packages/db/src/schema/edge.ts`, `apps/api/src/routes/fleet.ts`
 * (which imports the schema's copy) and `apps/console/src/api/fleet.ts`. A kind
 * the database accepts and the agent does not understand is a command that is
 * minted, delivered, and answered `UNKNOWN_COMMAND` — which is survivable — but
 * a kind the Console offers and the database refuses is a 500 on a button
 * press. `test/contract-drift.test.ts` compares this copy with the schema's.
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
  /**
   * Make a simulated device pretend something (S2-06): a printer out of paper,
   * a scanner reading a code, the counter button pressed. One kind rather than
   * one per action — the discrimination is a zod union in the payload
   * (`SimulatorActionSchema` in `@oto/shared`), which costs nothing to extend,
   * while every addition here is a migration.
   */
  'simulate',
  /**
   * Take a payment on the station's card terminal (S2-10a). Not a simulator
   * action: a real tender goes to a real terminal on a serial cable, and the
   * simulator answers on the same messages.
   *
   * **The outcome does not come back on the command's ack.** It travels on its
   * own route — `POST /payments/attempts/:id/result` — as a print job's outcome
   * does, because the customer-interaction budget is 120 seconds
   * (`DEVICE_INVENTORY.md:948`) and a command ack cannot be held open for it.
   */
  'terminal_sale',
  'terminal_settle',
  /**
   * Open the cash drawer. The pulse rides the receipt printer's RJ11 rather
   * than being a device of its own, so this is a job for the box's print queue;
   * it is a command kind because the platform does not print a receipt on
   * finalise yet, and a drawer that opens only when there is paper to print
   * would be a till nobody could take cash at.
   */
  'drawer_kick',
] as const;
export type BoxCommandKind = (typeof BOX_COMMAND_KINDS)[number];

export const BoxCommandPollRequestSchema = z.object({
  /** How many to take at once. Small: a box that dies mid-batch re-runs less. */
  max: z.number().int().min(1).max(10).default(5),
  /**
   * Hand out only these kinds; leave every other queued command where it is
   * (SCRUM-328). Absent means all of them, which is what an online box sends.
   *
   * It narrows the CLAIM rather than what the box does with the answer,
   * because a command handed out is a command marked `running`: a box that
   * took a test print it had no intention of carrying out would leave that row
   * claimed by nobody, and the Console would show a print somebody pressed as
   * in progress for ever. An offline box asks for `go_online` and nothing
   * else, so the test print queued behind it is still `queued` when the box
   * comes back.
   */
  kinds: z.array(z.enum(BOX_COMMAND_KINDS)).min(1).max(BOX_COMMAND_KINDS.length).optional(),
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

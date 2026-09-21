import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, core, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';

// --- The fleet: boxes, stations, devices and credentials (schema `core`) ----
//
// S2-04. The order here is the order the park described: an administrator
// picks the BOX first, because it is a Raspberry Pi already standing on site;
// the devices then offered are only the ones that box reported, because a
// printer is reachable through the box it is plugged into and nowhere else;
// and last, who may use the station. Staff never create or edit a station —
// they sign in, pick one from a list, and work.
//
// One rule runs through the whole file: **access scope drives visibility, not
// merely permission**. A station restricted to named staff is ABSENT from
// everybody else's picker rather than greyed out, so nobody stands at a till
// wondering why it refuses them. `station.access_scope` and `station_staff`
// are what the picker filters on. The refusal on a direct pick by id still
// exists, because a list that hides something is not a permission check.
//
// `ON DELETE` is `restrict` on every foreign key in this file, with one
// deliberate exception marked on `edge.box_heartbeat`. Nothing here is ever
// hard-deleted: a box is archived, a station is archived, a credential is
// revoked, a person is deactivated. A cascade would quietly take the record of
// which staff member was allowed on which till away with the till — and that
// record is exactly what an investigation asks for six months later.

/**
 * What a box is for.
 *
 * `counter`, `gate`, `booth` and `kiosk` are the Pis at the park; `standby` is
 * a spare that can take a counter's stations over when one dies; `virtual` is
 * the box that runs inside the api under `PROCESS_ROLES=edge`, which is what
 * lets the whole fleet pair, sync and demo on Render with no hardware at all.
 */
export const BOX_ROLES = ['counter', 'gate', 'booth', 'kiosk', 'standby', 'virtual'] as const;
export type BoxRole = (typeof BOX_ROLES)[number];

/**
 * `unclaimed` is a row an administrator created with a claim code but that no
 * Pi has ever registered against — it exists so the code can be issued before
 * the hardware is unboxed. `online` and `offline` are decided by the watchdog
 * from `last_heartbeat_at`, never by the box announcing them: a box that has
 * crashed cannot tell anybody it is down, and that silence is the whole
 * signal. `disabled` is a box taken out of service by a person, which is a
 * different fact from one that has merely gone quiet.
 */
export const BOX_STATUSES = ['unclaimed', 'online', 'offline', 'disabled'] as const;
export type BoxStatus = (typeof BOX_STATUSES)[number];

export const box = core.table(
  'box',
  {
    id: idPk(),
    /** Denormalised from the branch, as on every tenant-owned table (S2-01b). */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /** What a person calls it: "Counter 1 box", "Virtual box 1". */
    name: text('name').notNull(),
    /**
     * The position on site this box is meant to occupy — "counter-1",
     * "gate-north" — decided by a person before the hardware arrives. The slot,
     * not the hostname, is what the setup wizard lists, and it is what stays
     * put when a dead Pi is swapped for the standby: the new machine takes the
     * slot and the stations follow it.
     */
    slot: text('slot').notNull(),
    /** What the agent reports about itself; useful when a slot holds the wrong Pi. */
    hostname: text('hostname'),
    role: text('role').$type<BoxRole>().notNull().default('counter'),
    /**
     * SHA-256 of the per-box secret minted at `POST /box/v1/register`, which
     * the box then HMACs every heartbeat and every event envelope with. The
     * secret itself is returned once, at registration, and never stored — the
     * column name says `hash` so that no route can be written as though it
     * held the secret.
     */
    secretHash: text('secret_hash'),
    /**
     * Hash of the single-use claim code an administrator issues so a Pi can
     * register itself. Set to null the moment it is redeemed, which is what
     * makes the partial unique index below mean "codes still outstanding".
     */
    claimCodeHash: text('claim_code_hash'),
    /**
     * A claim code with no expiry is a permanent credential someone read out
     * over the phone once. Registration refuses an expired code even though
     * the hash still matches.
     */
    claimCodeExpiresAt: timestamp('claim_code_expires_at', { withTimezone: true, mode: 'date' }),
    /**
     * The PUBLIC half of the keypair the box signs its sync events with
     * (S2-05), raw base64url or SPKI PEM. Ed25519 by default.
     *
     * Two credentials, two jobs. `secret_hash` authenticates the CONNECTION:
     * the box presents `boxId.secret` as a bearer token and the api compares
     * the SHA-256. This key authenticates each EVENT, one at a time, long
     * after the connection that carried it has closed — a batch that sat in an
     * outbox for two days is still provably from this box.
     *
     * A keypair rather than the shared HMAC the S2-05 ticket sketches, because
     * the cloud stores only a hash of the box secret and a hash cannot verify
     * an HMAC. The alternative — a second, recoverable per-box secret — would
     * put a credential in the database that forges a box's whole history if
     * the database leaks. Here there is nothing to steal: the box keeps the
     * private half, and a signature is verified once, at push, after which
     * `sync_event.sig` is evidence rather than something re-checked.
     */
    syncPublicKey: text('sync_public_key'),
    syncKeyAlgorithm: text('sync_key_algorithm').notNull().default('ed25519'),
    /** When this key was presented — on registration, or on a rotation. */
    syncKeyRegisteredAt: timestamp('sync_key_registered_at', {
      withTimezone: true,
      mode: 'date',
    }),
    registeredAt: timestamp('registered_at', { withTimezone: true, mode: 'date' }),
    agentVersion: text('agent_version'),
    /**
     * The journal epoch every event this box emits is stamped with (S2-05).
     * "Reset store" mints N+1, so a batch replayed from the wiped store of
     * epoch N is recognisably stale rather than silently re-applied.
     */
    currentEpoch: integer('current_epoch').notNull().default(1),
    status: text('status').$type<BoxStatus>().notNull().default('unclaimed'),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true, mode: 'date' }),
    /**
     * The most recent heartbeat's redacted report — uptime, temperature,
     * outbox depth, device reachability and paper, lease holders, error
     * fingerprints. Denormalised on purpose: Health asks "is this box well?"
     * for every box on every page load, and this makes that one row per box
     * instead of the newest row out of half a million in `edge.box_heartbeat`.
     */
    lastStatus: jsonb('last_status'),
    ...timestamps,
    /**
     * A box removed from the park is archived, not deleted: its commands, its
     * heartbeat history and the stations that once sat on it all still have to
     * resolve. `box_command`'s restricting foreign key enforces that.
     */
    ...archivedAt,
  },
  (t) => [
    index('box_operator_idx').on(t.operatorId),
    index('box_branch_idx').on(t.branchId),
    /** Two live boxes cannot claim the same position; an archived one frees its slot. */
    uniqueIndex('box_slot_unique')
      .on(t.branchId, t.slot)
      .where(sql`archived_at is null`),
    /**
     * `POST /box/v1/register` arrives with a claim code and nothing else — the
     * Pi does not yet know its own id — so the code hash is the lookup key and
     * has to be both indexed and unique. Partial, because a consumed code is
     * nulled out and a hundred nulls are not a hundred collisions.
     */
    uniqueIndex('box_claim_code_unique')
      .on(t.claimCodeHash)
      .where(sql`claim_code_hash is not null`),
    /** The watchdog's scan: every box whose last heartbeat is older than the cutoff. */
    index('box_heartbeat_age_idx').on(t.lastHeartbeatAt),
    check(
      'box_role_check',
      sql`${t.role} in ('counter','gate','booth','kiosk','standby','virtual')`,
    ),
    check('box_status_check', sql`${t.status} in ('unclaimed','online','offline','disabled')`),
    check('box_epoch_check', sql`${t.currentEpoch} > 0`),
  ],
);

/**
 * A place a session can be held: a till, a kiosk, a gate, a customer display,
 * and from S2-07 a booth. Text + CHECK rather than a pg enum so a new kind
 * arrives without a DDL lock (S2-01b).
 */
export const STATION_KINDS = ['till', 'kiosk', 'gate', 'display', 'booth'] as const;
export type StationKind = (typeof STATION_KINDS)[number];

/**
 * Who may pick this station, and therefore who can see it at all.
 *
 * `all_staff` — anybody signed in at this branch sees it in the picker and
 * takes it by pressing it. `selected_staff` — only the accounts in
 * `station_staff` see it; to everybody else the station does not exist.
 */
export const STATION_ACCESS_SCOPES = ['all_staff', 'selected_staff'] as const;
export type StationAccessScope = (typeof STATION_ACCESS_SCOPES)[number];

/**
 * What a TILL is used for — the prototype's `StationCapability`
 * (apps/pos/src/types.ts). An empty list means "not restricted", which is how
 * the prototype reads an absent list, so a station that existed before anybody
 * chose capabilities behaves exactly as it did.
 *
 * A station of any other kind does not consult this at all: a booth, a kiosk,
 * a gate and a display are defined by `kind`, and an empty list on one of them
 * is the absence of a question rather than an answer to it.
 */
export const STATION_CAPABILITIES = ['tickets', 'fnb', 'dropoff', 'parties'] as const;
export type StationCapability = (typeof STATION_CAPABILITIES)[number];

export const station = core.table(
  'station',
  {
    id: idPk(),
    /**
     * Denormalised from the branch (S2-01b): every tenant-owned table carries
     * its operator, so a tenancy filter never has to join through the branch
     * to find out whose station this is.
     */
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id),
    /**
     * The box that drives this station's devices (R-12: a station belongs to
     * exactly one box). Nullable only because Sprint 1 shipped stations before
     * boxes existed and this migration may not rewrite rows it cannot answer
     * for; every station the wizard creates has one.
     */
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    kind: text('kind').$type<StationKind>().notNull().default('till'),
    /**
     * Short, stable prefix for everything this station mints: band codes are a
     * station-prefixed ULID plus an HMAC, and receipt series are
     * `{branch}{station}-{series}-{seq}`. Two live stations sharing a prefix
     * would mint colliding band codes at two tills at once, so the uniqueness
     * below is not cosmetic.
     */
    codePrefix: text('code_prefix'),
    /** `StationCapability[]`; empty = does everything. Validated by zod in @oto/shared. */
    capabilities: jsonb('capabilities').$type<StationCapability[]>().notNull().default([]),
    /**
     * Bumped on every change the box has to pick up — devices, routing,
     * capabilities, caps. The box compares it on each config poll and applies
     * the bundle whole, so "the till has the wrong printer" is answerable by
     * one number rather than by guesswork.
     */
    configVersion: integer('config_version').notNull().default(1),
    /**
     * Which tender goes to which device: card to a terminal, QR to the gateway
     * or to a terminal's own QR, cash to the drawer. Held as one document
     * rather than as a column per tender because the set of tenders is still
     * growing (S2-10a) and each carries its own settings. Validated by a zod
     * schema in @oto/shared at the API boundary, as the catalogue jsonb is.
     */
    paymentRouting: jsonb('payment_routing'),
    /**
     * How much wallet credit this station may spend while it is offline,
     * per wallet per day, in satang. Wallet spend is online-only by default
     * (R-48); this is the capped exception. Null means "use the platform
     * default" rather than "no limit" — a station that has never been
     * configured must not be the one with an unbounded cap.
     */
    offlineWalletCapSatang: integer('offline_wallet_cap_satang'),
    accessScope: text('access_scope')
      .$type<StationAccessScope>()
      .notNull()
      .default('all_staff'),
    /**
     * Sprint 1's per-station shared key. Superseded by `device_credential`,
     * which carries scopes, a pairing record and revocation. Kept because the
     * release now deployed still reads it; the contract step drops it.
     */
    deviceKeyHash: text('device_key_hash'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** A till taken off the floor is archived: its sales and audit rows still point at it. */
    ...archivedAt,
  },
  (t) => [
    index('station_branch_idx').on(t.branchId),
    index('station_operator_idx').on(t.operatorId),
    index('station_box_idx').on(t.boxId),
    /**
     * The station picker's own query — the live stations of one branch — runs
     * on every sign-in, so it gets an index that carries only live rows rather
     * than reading the archived ones and throwing them away.
     */
    index('station_branch_live_idx')
      .on(t.branchId)
      .where(sql`archived_at is null`),
    /**
     * Two live tills called "Reception Till 1" at one branch is a mistake, not
     * a configuration. Partial, so archiving a station frees its name for the
     * one that replaces it.
     */
    uniqueIndex('station_name_unique')
      .on(t.branchId, t.name)
      .where(sql`archived_at is null`),
    uniqueIndex('station_code_prefix_unique')
      .on(t.branchId, t.codePrefix)
      .where(sql`code_prefix is not null and archived_at is null`),
    check('station_kind_check', sql`${t.kind} in ('till','kiosk','gate','display','booth')`),
    check('station_access_scope_check', sql`${t.accessScope} in ('all_staff','selected_staff')`),
    check(
      'station_wallet_cap_check',
      sql`${t.offlineWalletCapSatang} is null or ${t.offlineWalletCapSatang} >= 0`,
    ),
  ],
);

/**
 * Who may pick a `selected_staff` station.
 *
 * This table is read on every station pick, so it is the other half of the
 * visibility rule: the picker returns the branch's `all_staff` stations plus
 * the `selected_staff` stations this account has a row here for, and nothing
 * else. A station with no rows and scope `selected_staff` is visible to nobody,
 * which is a legitimate state — a till being prepared.
 *
 * Removing somebody is a plain delete; who was on the list and when is carried
 * by the audit row the service writes, which is where that question is asked
 * from anyway.
 */
export const stationStaff = core.table(
  'station_staff',
  {
    id: idPk(),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /**
     * The manager or administrator who granted it. Not nullable: access to a
     * till is always given by somebody, and that somebody is who an audit
     * asks about.
     */
    addedBy: uuid('added_by')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('station_staff_unique').on(t.stationId, t.accountId),
    /**
     * The unique index leads with the station, which answers the admin screen's
     * "who is on this list". The picker asks the opposite question — "which
     * restricted stations may THIS account see" — on every sign-in, and needs
     * its own index to answer it.
     */
    index('station_staff_account_idx').on(t.accountId),
    index('station_staff_added_by_idx').on(t.addedBy),
  ],
);

/**
 * A physical device plugged into or reachable from one box.
 *
 * `band_printer` is the prototype's `bracelet_printer` under the name the rest
 * of the platform uses for what it prints (S2-01b renamed `wristband` to
 * `band`); the POS maps the two when it reads a station's assignments.
 * Displays, kiosks and booths are NOT device kinds — they are browsers holding
 * a `device_credential`, and a kiosk or a booth is itself a station.
 */
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

/**
 * How the box reaches it. `lan` is raw TCP 9100 to a printer, `serial` a USB
 * CDC or RS485 line to a terminal or a gate controller, `usb` a HID device
 * read through evdev, `bluetooth` the scanner paired to its cradle.
 * `simulated` is a device the virtual box invents, which is how every flow in
 * this sprint is proved before anybody travels to Phuket.
 */
export const DEVICE_TRANSPORTS = ['lan', 'usb', 'serial', 'bluetooth', 'simulated'] as const;
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[number];

export const DEVICE_REACHABILITY = ['unknown', 'reachable', 'unreachable'] as const;
export type DeviceReachability = (typeof DEVICE_REACHABILITY)[number];

/** Only meaningful for printers; `unknown` everywhere else and before the first report. */
export const DEVICE_PAPER_STATES = ['unknown', 'ok', 'low', 'out'] as const;
export type DevicePaperState = (typeof DEVICE_PAPER_STATES)[number];

export const device = core.table(
  'device',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    /**
     * Not nullable: a device exists because a box reported it, and a printer
     * is reachable through the box it is plugged into and nowhere else. A
     * device that moves to another box is a new row on that box, so the old
     * assignments keep saying what they meant at the time.
     */
    boxId: uuid('box_id')
      .notNull()
      .references(() => box.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<DeviceKind>().notNull(),
    /** What staff call it in the wizard: "Receipt Printer 1". */
    label: text('label').notNull(),
    transport: text('transport').$type<DeviceTransport>().notNull(),
    /** `192.168.88.204:9100`, `/dev/ttyACM0`; null for a bluetooth or simulated device. */
    address: text('address'),
    /** `4B-2082A`, `Xprinter XP-80`, `NEXGO N5`, `PAX A920Pro`. */
    model: text('model'),
    /**
     * Which adapter dialect to speak — `tspl2`, `escpos`, `ghl_linkpos`,
     * `digio_tlv`, `gex2`, `reader_http`. Mostly implied by the model, but not
     * always: the 4B-2082A takes TSPL2 or a ZPL emulation and the hardware
     * reference's decision D1 leaves which one open until a label is printed on
     * site, so the switch has to be per device rather than per model.
     */
    protocol: text('protocol'),
    serialNumber: text('serial_number'),
    /** Payment terminals only, from the acquirer: TID and MID. */
    terminalId: text('terminal_id'),
    merchantId: text('merchant_id'),
    /**
     * What is true of THIS unit rather than of its model (S2-06).
     *
     * The device research leaves three facts open per physical machine, and
     * each one changes the bytes we send: whether an XP-80 is 576 or 512 dots
     * per line, readable only from its self-test page (§9.4, D6); whether a
     * 4B-2082A is in TSPL2 or its ZPL emulation, and what band stock is loaded
     * in it (§9.1, D1); whether the DS2278 cradle is presenting as a USB HID
     * keyboard or as a CDC serial device, and what key the counter button
     * sends (§9.2, D2). Two printers with the same model string can disagree
     * about all of it.
     *
     * Everything implied by the model — the command set, the status encoding,
     * the default profile — stays in `@oto/print`'s device profiles and is not
     * repeated here. An absent section, or an absent key inside one, means
     * "use the profile". Shape validated by `DeviceSettingsSchema` in
     * `@oto/shared`, which is `.strict()`, so a mistyped key is refused at the
     * edit rather than silently doing nothing in the park.
     */
    settings: jsonb('settings'),
    reachability: text('reachability')
      .$type<DeviceReachability>()
      .notNull()
      .default('unknown'),
    paperStatus: text('paper_status').$type<DevicePaperState>().notNull().default('unknown'),
    /** Short, non-leaking label for the last fault — no device payloads. */
    lastError: text('last_error'),
    /** When the box last said anything about it, healthy or not. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
    ...archivedAt,
  },
  (t) => [
    /** The wizard's question: "what did this box report, of this kind?" */
    index('device_box_kind_idx').on(t.boxId, t.kind),
    index('device_branch_idx').on(t.branchId),
    index('device_operator_idx').on(t.operatorId),
    /**
     * One box reporting the same address twice is a duplicate registration,
     * not two printers. Partial, so an archived device frees the address for
     * the unit that replaced it.
     */
    uniqueIndex('device_address_unique')
      .on(t.boxId, t.address)
      .where(sql`address is not null and archived_at is null`),
    check(
      'device_kind_check',
      sql`${t.kind} in ('receipt_printer','band_printer','kitchen_printer','bar_printer','scanner','terminal','gate','gate_reader','cash_drawer')`,
    ),
    check(
      'device_transport_check',
      sql`${t.transport} in ('lan','usb','serial','bluetooth','simulated')`,
    ),
    check(
      'device_reachability_check',
      sql`${t.reachability} in ('unknown','reachable','unreachable')`,
    ),
    check('device_paper_check', sql`${t.paperStatus} in ('unknown','ok','low','out')`),
  ],
);

/**
 * What job a device does for a station — the prototype's `StationProfile`
 * fields (`receiptPrinterId`, `kidsBraceletPrinterId`, `adultBraceletPrinterId`,
 * `kitchenPrinterId`, `barPrinterId`, `scannerId`) as rows instead of columns,
 * plus the tender routing targets and the drawer.
 */
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

export const stationDevice = core.table(
  'station_device',
  {
    id: idPk(),
    stationId: uuid('station_id')
      .notNull()
      .references(() => station.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => device.id, { onDelete: 'restrict' }),
    role: text('role').$type<StationDeviceRole>().notNull(),
    ...timestamps,
  },
  (t) => [
    /**
     * One device per role per station, exactly as the prototype has one field
     * each. A second receipt printer on a till is a change of assignment, not
     * an addition, and the database is what says so.
     */
    uniqueIndex('station_device_role_unique').on(t.stationId, t.role),
    /** "Which stations would break if this printer went away?" */
    index('station_device_device_idx').on(t.deviceId),
    check(
      'station_device_role_check',
      sql`${t.role} in ('receipt','kids_band','adult_band','kitchen','bar','scanner','card_terminal','qr_terminal','gate','cash_drawer')`,
    ),
  ],
);

/**
 * What kind of thing holds a credential. A display, a kiosk and a booth are
 * browsers paired to a station; a box is the Pi itself.
 */
export const DEVICE_CREDENTIAL_KINDS = ['display', 'kiosk', 'booth', 'box'] as const;
export type DeviceCredentialKind = (typeof DEVICE_CREDENTIAL_KINDS)[number];

/**
 * The credential a non-person holds, and the record of who gave it to them.
 *
 * A display, a kiosk or a booth is paired by an administrator reading out a
 * short code; redeeming it mints a long secret this row stores the hash of.
 * Every call that credential makes is then authorised against its station, so
 * a display cannot read another till's sale.
 *
 * A box's CURRENT secret also lives on `box.secret_hash`, because a heartbeat
 * arrives every 60 seconds from every box and authenticating it should be one
 * indexed lookup rather than a join. The row here is what makes a rotation
 * auditable: `rotated_from` chains the new credential to the one it replaced,
 * so "when did this box's secret last change, and who changed it" has an
 * answer.
 */
export const deviceCredential = core.table(
  'device_credential',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branch.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<DeviceCredentialKind>().notNull(),
    /** Set for display / kiosk / booth; null for a box. See the CHECK below. */
    stationId: uuid('station_id').references(() => station.id, { onDelete: 'restrict' }),
    /** Set for a box; null for the rest. */
    boxId: uuid('box_id').references(() => box.id, { onDelete: 'restrict' }),
    /** Which iPad or screen this is, so revoking the right one is possible. */
    label: text('label'),
    /**
     * Hash of the short pairing code an administrator reads out. Nulled when
     * redeemed, like a box's claim code, so the partial unique index below
     * means "codes still outstanding".
     */
    pairingCodeHash: text('pairing_code_hash'),
    pairingCodeExpiresAt: timestamp('pairing_code_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    /** Hash of the long-lived secret minted when the code is redeemed. */
    secretHash: text('secret_hash'),
    /** The permissions this credential carries, validated by zod in @oto/shared. */
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    /**
     * The credential this one replaced. Restrict rather than set null: the
     * point of the chain is that it cannot be broken, and a revoked credential
     * is kept rather than deleted anyway.
     */
    rotatedFrom: uuid('rotated_from'),
    pairedByAccountId: uuid('paired_by_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    pairedAt: timestamp('paired_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: text('revoked_reason'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    /** The authentication lookup on every call a paired device makes. */
    uniqueIndex('device_credential_secret_unique')
      .on(t.secretHash)
      .where(sql`secret_hash is not null`),
    /** The redemption lookup: the device arrives with a code and nothing else. */
    uniqueIndex('device_credential_pairing_unique')
      .on(t.pairingCodeHash)
      .where(sql`pairing_code_hash is not null`),
    index('device_credential_station_idx').on(t.stationId),
    index('device_credential_box_idx').on(t.boxId),
    index('device_credential_operator_idx').on(t.operatorId),
    index('device_credential_branch_idx').on(t.branchId),
    index('device_credential_rotated_from_idx').on(t.rotatedFrom),
    index('device_credential_paired_by_idx').on(t.pairedByAccountId),
    foreignKey({
      columns: [t.rotatedFrom],
      foreignColumns: [t.id],
      name: 'device_credential_rotated_from_fk',
    }).onDelete('restrict'),
    check(
      'device_credential_kind_check',
      sql`${t.kind} in ('display','kiosk','booth','box')`,
    ),
    /**
     * A credential that belongs to neither a station nor a box authorises
     * nothing and can be checked against nothing, so the database refuses it
     * rather than leaving a route to discover it at three in the afternoon.
     */
    check(
      'device_credential_target_check',
      sql`(${t.kind} = 'box' and ${t.boxId} is not null and ${t.stationId} is null)
          or (${t.kind} <> 'box' and ${t.stationId} is not null and ${t.boxId} is null)`,
    ),
  ],
);

/**
 * PUBLIC halves of the platform's signing keys — nothing else.
 *
 * The staff token, the booking QR and the benefit QR are signed in the cloud
 * and verified on a box that may have been offline for hours, so every box
 * needs the public half in its config bundle. The private halves live in
 * environment variables (`STAFF_TOKEN_PRIVATE_KEY` and its siblings) and never
 * touch this table; the column is called `public_key` so that writing one here
 * would have to be a deliberate act rather than a slip.
 */
export const SIGNING_KEY_PURPOSES = ['staff_token', 'booking_qr', 'benefit_qr'] as const;
export type SigningKeyPurpose = (typeof SIGNING_KEY_PURPOSES)[number];

export const signingKey = core.table(
  'signing_key',
  {
    id: idPk(),
    /** Null = platform-wide, which is every key today; an operator-specific key is possible later. */
    operatorId: uuid('operator_id').references(() => operator.id, { onDelete: 'restrict' }),
    purpose: text('purpose').$type<SigningKeyPurpose>().notNull(),
    /** The `kid` carried in the token header, which is how a verifier picks this row. */
    kid: text('kid').notNull(),
    algorithm: text('algorithm').notNull().default('ed25519'),
    /** SPKI PEM or raw base64url. Public. */
    publicKey: text('public_key').notNull(),
    /**
     * Rotation is two keys live at once: the new one signs, the old one still
     * verifies until every token minted under it has expired. So a key is
     * retired rather than deleted, and `active` says which one signs.
     */
    active: boolean('active').notNull().default(true),
    notBefore: timestamp('not_before', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('signing_key_kid_unique').on(t.purpose, t.kid),
    /** "Which key signs a staff token right now" and "which are still worth shipping to a box". */
    index('signing_key_purpose_active_idx').on(t.purpose, t.active),
    index('signing_key_operator_idx').on(t.operatorId),
    check(
      'signing_key_purpose_check',
      sql`${t.purpose} in ('staff_token','booking_qr','benefit_qr')`,
    ),
  ],
);

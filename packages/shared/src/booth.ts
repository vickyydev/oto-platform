/**
 * The Lucky Wheel's frozen contracts (S2-07a).
 *
 * Three surfaces meet here and none of them can see the other two at compile
 * time: the page on the booth television, the agent on the box under it, and
 * the api that publishes a wheel and later applies the spins. This file is
 * what they agree on, and it is deliberately small — the shapes that more than
 * one of them has to name, and nothing else.
 *
 * Two rules it inherits from the rest of the platform, and one of its own:
 *
 *   - **Nothing personal reaches the television (D15).** No phone number, no
 *     name, no child record, no token, no origin, no key, no stack trace. The
 *     outgoing game shipped a staff PIN literal in a public bundle; the shapes
 *     below are drawn so that mistake has nowhere to live. The PIN is verified
 *     on the box; the page sends it and is told yes or no.
 *   - **A box only ever speaks about itself.** The heartbeat block below is
 *     counts and states for THIS booth.
 *   - **Weights are integers.** `weightBp` is basis points and the active
 *     prizes sum to 10,000 (D4). A float "must sum to 100" fails on addition
 *     the first time somebody splits a slice three ways.
 */

import { z } from 'zod';

// --- The published wheel ----------------------------------------------------

/**
 * The version of the BUNDLE DOCUMENT's shape, not of the wheel.
 *
 * `booth.booth_config_version.version` counts publishes — 1, 2, 3, one per
 * edit an administrator makes. This counts changes to the document's own
 * layout, and it is stamped into every bundle (`schemaVersion`) so a box that
 * has been offline through an upgrade can tell a document it understands from
 * one it does not. Readers compare against it; nothing in this file enforces
 * the comparison.
 */
export const BOOTH_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Who is allowed a spin. Mirrors `BOOTH_ELIGIBILITY_MODES` in `@oto/db` and
 * the CHECK on `booth.booth_settings.eligibility`.
 *
 * Declared twice on purpose and for the usual reason: `@oto/db` depends on
 * `@oto/shared`, so the arrow cannot point the other way. The database is the
 * authority — a value missing from its CHECK is refused whatever this says.
 *
 * `none` is the only mode a mall booth can use: visitors at a shopping centre
 * have no wristband, and the owner's instruction is not to ask for a phone
 * number on the television.
 */
export const BOOTH_ELIGIBILITY_MODES = ['none', 'band', 'phone'] as const;
export type BoothEligibilityMode = (typeof BOOTH_ELIGIBILITY_MODES)[number];

/**
 * One slice, as the published bundle carries it.
 *
 * Every field is named exactly as its column in `booth.booth_prize` — the
 * least surprising projection of the row, so the agent and the api never need
 * a translation table between them.
 *
 * **What is NOT here is as deliberate as what is.** No voucher-definition
 * document, no terms text, no stock level: a slice is what the wheel needs to
 * draw and to name a prize. The words of a type that had a title or an
 * instruction when the wheel was published — title, instruction and terms —
 * ride beside the prizes in the bundle's `voucherDefinitions` (SCRUM-400),
 * and the box resolves the rest when a voucher is won from its cache: the expiry,
 * and the terms of any type the bundle carries no words for.
 * The whole thing sits on a Raspberry Pi in a shopping mall that anybody can
 * carry out of a storeroom.
 */
export const BoothConfigPrizeSchema = z.object({
  id: z.string().uuid(),
  nameEn: z.string(),
  nameTh: z.string().nullable(),
  /** The short text on the slice. Null means fall back to `nameEn`. */
  wheelLabel: z.string().nullable(),
  weightBp: z.number().int().min(0).max(10000),
  active: z.boolean(),
  /** Per booth, per trading day. Null is uncapped. */
  dailyCap: z.number().int().positive().nullable(),
  expiryDays: z.number().int().positive().nullable(),
  costSatang: z.number().int().min(0),
  sliceColor: z.string().nullable(),
  textColor: z.string().nullable(),
  sortOrder: z.number().int().min(0),
  /** What winning it produces. Null cannot be published (S2-07b refuses it). */
  voucherDefinitionId: z.string().uuid().nullable(),
});
export type BoothConfigPrize = z.infer<typeof BoothConfigPrizeSchema>;

export const BOOTH_SPIN_DURATION_DEFAULT_SECONDS = 10;
export const BOOTH_SPIN_DURATION_MIN_SECONDS = 2;
export const BOOTH_SPIN_DURATION_MAX_SECONDS = 20;

/** Older published wheels omit the duration and run for ten seconds. */
export function boothSpinDurationSeconds(settings: { spinDurationSeconds?: number }): number {
  const configured = settings.spinDurationSeconds;
  return typeof configured === 'number' && Number.isInteger(configured) &&
    configured >= BOOTH_SPIN_DURATION_MIN_SECONDS && configured <= BOOTH_SPIN_DURATION_MAX_SECONDS
    ? configured
    : BOOTH_SPIN_DURATION_DEFAULT_SECONDS;
}

/** Static text on paper. Prize words, instructions and terms belong to the voucher type. */
export interface BoothVoucherDesign {
  layout: 'classic' | 'showcase';
  /** Null uses the branch's current name. */
  venueLine: string | null;
  winnerLine: string;
  winnerLineThai: string;
  codeLabel: string;
  issuedLabel: string;
  expiresLabel: string;
  termsLabel: string;
  singleUseLabel: string;
}

export const BoothVoucherDesignSchema = z.object({
  layout: z.enum(['classic', 'showcase']),
  venueLine: z.string().max(200).nullable(),
  winnerLine: z.string().max(100),
  winnerLineThai: z.string().max(100),
  codeLabel: z.string().max(100),
  issuedLabel: z.string().max(100),
  expiresLabel: z.string().max(100),
  termsLabel: z.string().max(100),
  singleUseLabel: z.string().max(200),
});

export const BoothConfigSettingsSchema = z.object({
  eligibility: z.enum(BOOTH_ELIGIBILITY_MODES),
  /**
   * The key the red button sends. **Never `Enter`**: the park's USB badge
   * scanner types digits and then Enter, so a booth bound to Enter spins the
   * wheel every time somebody scans a badge. The CHECK on the column refuses
   * that one string; this refuses it again here, because a bundle is applied
   * by a box that never sees the CHECK.
   */
  buttonKey: z
    .string()
    .min(1)
    .max(32)
    .refine((key) => key !== 'Enter', {
      message: 'Enter is the badge scanner’s key and cannot be the booth button',
    }),
  /**
   * How many spins this booth may give away in one trading day. Null is no
   * cap, and it is the common case.
   *
   * **The box is what enforces it** (SCRUM-257): it counts its own spins for
   * the branch's trading day and refuses the press once the number is reached,
   * offline included, which is the only place the count exists on a booth with
   * no internet. Nothing else may enforce it — a second count in the cloud
   * would disagree with the paper the booth has already printed.
   */
  dailySpinCap: z.number().int().positive().nullable(),
  /**
   * How long a member of staff stays signed in at this booth, in minutes
   * (SCRUM-223).
   *
   * The session ends when this has passed or when somebody signs out — never
   * because nobody pressed anything for a while: a booth is attended for a
   * shift, and a sign-in that lapsed mid-afternoon would produce exactly the
   * unattributed vouchers staff sign in to avoid.
   *
   * **Optional, and present only when an administrator has set one**
   * (Console → Booths → Booth settings, stored in
   * `booth.booth_settings.staff_session_minutes`, SCRUM-400). Absent, a box
   * uses `BOOTH_STAFF_SESSION_DEFAULT_MINUTES`. Optional rather than defaulted
   * here because a bundle is hashed AS STORED, and a schema that filled the
   * field in would hand the box a document nobody published.
   */
  staffSessionMinutes: z.number().int().positive().nullable().optional(),
  /** Optional so parsing an older bundle never inserts a field into its hashed document. */
  spinDurationSeconds: z.number().int()
    .min(BOOTH_SPIN_DURATION_MIN_SECONDS).max(BOOTH_SPIN_DURATION_MAX_SECONDS).optional(),
  /**
   * The voucher slip this booth prints (SCRUM-471): Console → Booths →
   * Voucher slip, stored on `booth.booth_settings.voucher_*`.
   *
   * **Each is optional, and present only when it differs from its default**
   * (`BOOTH_VOUCHER_SLIP_DEFAULTS`), for the reason `staffSessionMinutes`
   * gives: a bundle is hashed as stored, so a booth nobody has customised
   * publishes the document — and the hash — it always did, and a box reading
   * a bundle without them prints the slip it always printed. Read them through
   * `boothVoucherSlip`, never directly.
   *
   * The texts carry no length limit here, on purpose: the settings route and
   * the column's CHECK hold the limits, and a box refusing a whole wheel over
   * a footer a newer cloud allowed to be longer would take the booth off the
   * air for a line of small print. The renderer wraps what it is given.
   */
  voucherShowLogo: z.boolean().optional(),
  voucherHeaderText: z.string().nullable().optional(),
  voucherFooterText: z.string().nullable().optional(),
  voucherShowStaff: z.boolean().optional(),
  voucherShowTerms: z.boolean().optional(),
  /** Optional until a booth chooses the new paper design. */
  voucherDesign: BoothVoucherDesignSchema.optional(),
});
export type BoothConfigSettings = z.infer<typeof BoothConfigSettingsSchema>;

/** The longest header line a booth's voucher takes — the print templates' own limit. */
export const BOOTH_VOUCHER_HEADER_MAX_CHARS = 200;
/** The longest footer line a booth's voucher takes — the print templates' own limit. */
export const BOOTH_VOUCHER_FOOTER_MAX_CHARS = 400;

/** What a booth's voucher slip shows, resolved: every field present. */
export interface BoothVoucherSlip {
  showLogo: boolean;
  /** A line of its own under the venue line; null prints none. */
  headerText: string | null;
  /** The slip's last line; null prints none. */
  footerText: string | null;
  showStaff: boolean;
  showTerms: boolean;
  design: BoothVoucherDesign;
}

export const BOOTH_VOUCHER_DESIGN_DEFAULTS: Readonly<BoothVoucherDesign> = Object.freeze({
  layout: 'classic',
  venueLine: null,
  winnerLine: '★ YOU WON ★',
  winnerLineThai: 'คุณได้รับรางวัล',
  codeLabel: 'VOUCHER CODE',
  issuedLabel: 'Issued / วันที่ออก',
  expiresLabel: 'Expires / วันหมดอายุ',
  termsLabel: 'TERMS / เงื่อนไข',
  singleUseLabel: 'Voucher can be used only once. / คูปองสามารถใช้ได้เพียง 1 ครั้ง',
});

export function sameBoothVoucherDesign(a: BoothVoucherDesign, b: BoothVoucherDesign): boolean {
  return (Object.keys(BOOTH_VOUCHER_DESIGN_DEFAULTS) as Array<keyof BoothVoucherDesign>)
    .every((key) => a[key] === b[key]);
}

/**
 * The slip every booth printed before SCRUM-471, and still prints until an
 * administrator changes it: the logo, the Staff row and the terms, and no
 * header or footer line. Also the column defaults of migration 0039.
 */
export const BOOTH_VOUCHER_SLIP_DEFAULTS: Readonly<BoothVoucherSlip> = Object.freeze({
  showLogo: true,
  headerText: null,
  footerText: null,
  showStaff: true,
  showTerms: true,
  design: BOOTH_VOUCHER_DESIGN_DEFAULTS,
});

/** A text as the slip stores it: trimmed, and "nothing" spelled null. */
export function boothVoucherText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The slip a booth running these settings prints: each field as published, or
 * its default when the bundle does not carry it — which is every bundle
 * published before SCRUM-471 and every booth nobody has customised.
 */
export function boothVoucherSlip(settings: {
  voucherShowLogo?: boolean;
  voucherHeaderText?: string | null;
  voucherFooterText?: string | null;
  voucherShowStaff?: boolean;
  voucherShowTerms?: boolean;
  voucherDesign?: Partial<BoothVoucherDesign> | null;
}): BoothVoucherSlip {
  const flag = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  return {
    showLogo: flag(settings.voucherShowLogo, BOOTH_VOUCHER_SLIP_DEFAULTS.showLogo),
    headerText: boothVoucherText(settings.voucherHeaderText),
    footerText: boothVoucherText(settings.voucherFooterText),
    showStaff: flag(settings.voucherShowStaff, BOOTH_VOUCHER_SLIP_DEFAULTS.showStaff),
    showTerms: flag(settings.voucherShowTerms, BOOTH_VOUCHER_SLIP_DEFAULTS.showTerms),
    design: { ...BOOTH_VOUCHER_DESIGN_DEFAULTS, ...(settings.voucherDesign ?? {}) },
  };
}

/**
 * The slip fields a publish writes into `settings`: only those that differ
 * from their defaults, so an untouched booth's bundle — and its hash — are
 * what they were before the fields existed. The inverse of `boothVoucherSlip`.
 */
export function boothVoucherSlipBundleFields(slip: Omit<BoothVoucherSlip, 'design'> & { design?: BoothVoucherDesign }): {
  voucherShowLogo?: boolean;
  voucherHeaderText?: string;
  voucherFooterText?: string;
  voucherShowStaff?: boolean;
  voucherShowTerms?: boolean;
  voucherDesign?: BoothVoucherDesign;
} {
  const header = boothVoucherText(slip.headerText);
  const footer = boothVoucherText(slip.footerText);
  const design = slip.design ?? BOOTH_VOUCHER_DESIGN_DEFAULTS;
  return {
    ...(slip.showLogo !== BOOTH_VOUCHER_SLIP_DEFAULTS.showLogo ? { voucherShowLogo: slip.showLogo } : {}),
    ...(header !== null ? { voucherHeaderText: header } : {}),
    ...(footer !== null ? { voucherFooterText: footer } : {}),
    ...(slip.showStaff !== BOOTH_VOUCHER_SLIP_DEFAULTS.showStaff ? { voucherShowStaff: slip.showStaff } : {}),
    ...(slip.showTerms !== BOOTH_VOUCHER_SLIP_DEFAULTS.showTerms ? { voucherShowTerms: slip.showTerms } : {}),
    ...(!sameBoothVoucherDesign(design, BOOTH_VOUCHER_DESIGN_DEFAULTS)
      ? { voucherDesign: design } : {}),
  };
}

/**
 * The session length a box uses when the published wheel names none: twelve
 * hours, which covers the longest shift the park runs at a mall booth.
 */
export const BOOTH_STAFF_SESSION_DEFAULT_MINUTES = 720;

/**
 * The longest session a box will grant, whatever a bundle says: one day.
 *
 * A session that outlived the trading day would carry yesterday's sign-in into
 * tomorrow's first spins, and nobody would have proved who they were that
 * morning. A larger number in a bundle is honoured up to this ceiling rather
 * than refused, because refusing it would take the whole wheel off the air
 * over a staff setting.
 */
export const BOOTH_STAFF_SESSION_MAX_MINUTES = 24 * 60;

/** The session length, in minutes, a booth running these settings grants. */
export function boothStaffSessionMinutes(settings: {
  staffSessionMinutes?: number | null;
}): number {
  const configured = settings.staffSessionMinutes;
  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured <= 0) {
    return BOOTH_STAFF_SESSION_DEFAULT_MINUTES;
  }
  return Math.min(configured, BOOTH_STAFF_SESSION_MAX_MINUTES);
}

export const BoothConfigLayoutSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.number().int().positive(),
  /**
   * Palette, label rules, rotation geometry — and the asset SLOT manifest,
   * which names what the wheel wants and where each name is expected to come
   * from rather than carrying any bytes (D23).
   *
   * Typed `unknown` here and validated where it is READ, which is the same
   * choice `BoxConfigDevice.settings` makes in the box protocol and for the
   * same reason: a booth is updated on its own schedule, and a field the
   * wheel-rendering slice adds to a design must not stop an older box parsing
   * its bundle. The slice that draws the wheel owns these two shapes.
   */
  design: z.unknown(),
  assetManifest: z.unknown(),
});
export type BoothConfigLayout = z.infer<typeof BoothConfigLayoutSchema>;

/**
 * What a booth is actually running: `booth.booth_config_version.bundle`.
 *
 * Published whole and applied whole — half a prize list is a wheel whose odds
 * do not add up. The box compares `bundle_hash` and applies the document
 * behind it or nothing.
 *
 * **Validate, do not re-serialise.** `bundle_hash` is SHA-256 over the
 * canonical JSON of the document AS STORED, and a zod object drops keys it
 * does not know about. Parsing a bundle to check it is fine; hashing the
 * PARSED value is not, and would make a box built before a field was added
 * disagree with the cloud about every bundle that carries it.
 *
 * **It does not carry its own version number.** `version` counts publishes and
 * lives on the row, not in the document, so whatever hands a bundle to the
 * television has to hand the number over beside it — otherwise the page cannot
 * say which wheel it is showing, and `SpinResponse.configVersion` has nothing
 * to be compared against.
 */
export const BoothConfigBundleSchema = z.object({
  schemaVersion: z.number().int().positive(),
  settings: BoothConfigSettingsSchema,
  layout: BoothConfigLayoutSchema,
  /**
   * In slice order — the order the page draws them, which is the publisher's
   * `sort_order`. `SpinResponse.prizeIndex` indexes THIS array.
   */
  prizes: z.array(BoothConfigPrizeSchema),
  /**
   * The park's own words for the slips this wheel prints (SCRUM-400): per
   * voucher definition a prize points at, the title and the instruction line
   * in English and Thai, and the terms, exactly as the administrator typed
   * them in Console → Voucher types.
   *
   * **Optional, and present only for definitions that carry a title or an
   * instruction.** A bundle is hashed AS STORED, so a wheel whose definitions
   * nobody has worded publishes the same document — and the same hash — it
   * always did, and a box reading one without this field prints the prize's
   * own names, the generic redemption line and the terms from its cache
   * scope, as before; those terms change at the box's next pull.
   *
   * Frozen at publish like the rest of the bundle, terms included: for a
   * definition with an entry here the box prints the entry's terms, never the
   * cache's, so re-wording it — terms and all — changes the slip at that
   * booth's next publish, and a version says what its slips said. The expiry
   * is not here: the box reads it when a voucher is won — the prize's own
   * days from the wheel, or else the type's from its cache scope — so a
   * type's changed expiry applies from the box's next pull.
   *
   * The prizes themselves still carry no definition document; this sits
   * beside them, keyed by `voucherDefinitionId`. Every field but the id is
   * optional so a box parses a bundle from a cloud that words fewer of them.
   * A title or an instruction left out falls back to the prize's names or
   * the generic line; terms left out print none, not the cache's, because
   * for a type with an entry the entry is the whole of its terms.
   */
  voucherDefinitions: z
    .array(
      z.object({
        id: z.string().uuid(),
        titleEn: z.string().nullable().optional(),
        titleTh: z.string().nullable().optional(),
        instructionEn: z.string().nullable().optional(),
        instructionTh: z.string().nullable().optional(),
        termsEn: z.string().nullable().optional(),
        termsTh: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
export type BoothConfigBundle = z.infer<typeof BoothConfigBundleSchema>;

// --- One press of the red button --------------------------------------------

/**
 * What became of the paper.
 *
 * `no_printer` is not a fault: a demo booth and a virtual box have no printer
 * at all, and the result screen shows the code and the QR instead. `queued`
 * and `failed` both mean a real printer that did not produce a slip now — the
 * difference is whether it still might.
 */
export const BOOTH_PRINT_STATES = ['printed', 'queued', 'failed', 'no_printer'] as const;
export type BoothPrintState = (typeof BOOTH_PRINT_STATES)[number];

/**
 * The box's answer to a press, and the one contract the page cannot be wrong
 * about.
 *
 * **Why `prizeId` rides beside `prizeIndex`.** The television draws its slices
 * from the bundle it loaded; the box draws from the bundle it has cached. One
 * publish between those two moments and index 3 is a different prize on each
 * side: the wheel stops on the bracelet workshop while the printer produces a
 * 200 baht voucher. Nothing throws, no test that exercises one side alone can
 * see it, and the first person to notice is a parent at reception holding a
 * slip that does not match what their child watched. So the box returns BOTH —
 * the slot to stop on and the identity of what was won — and the page asserts
 * `bundle.prizes[prizeIndex].id === prizeId` before it animates. When they
 * disagree the page has stale configuration and must reload it rather than
 * show either answer.
 *
 * `configVersion` is the same check at coarser grain: `booth_config_version.version`,
 * the number the box drew under. A page holding a different number knows it is
 * stale without inspecting a single slice.
 *
 * **This shape describes a press that DREW something.** A press the box
 * refuses — nothing eligible, so "Booth not ready — please call staff" (D5) —
 * is an error response, not this document with nulls in it. And there is no
 * losing outcome here even though `booth.spin.outcome` has one: a slice with
 * no prize row behind it cannot be published today, so the day a layout gains
 * a losing slice this type gains `outcome` and `prizeId` becomes nullable with
 * it. Inventing a null now would mean every reader carrying a branch for a
 * case that cannot occur, and the wrong one by the time it can.
 */
export interface SpinResponse {
  /** UUIDv7 of the `booth.spin` row, which the box wrote BEFORE answering. */
  spinId: string;
  /** Index into the bundle's `prizes`, in slice order. See above. */
  prizeIndex: number;
  /** `booth.booth_prize.id` — what was won. */
  prizeId: string;
  /** `booth.booth_config_version.version` — the wheel that drew. */
  configVersion: number;
  /**
   * The code that was minted, or null when this prize produces nothing to
   * redeem — a giveaway handed over at the booth rather than claimed at the
   * park.
   *
   * **Never null merely because the printer is down.** The code is minted on
   * the box in the transaction that records the spin, before any paper is
   * attempted; a printer fault is what `printState` reports, and the page then
   * shows the code and its QR on the television instead. A reader that treats
   * null as "printing failed" will hide a valid voucher from a family standing
   * in front of it.
   */
  voucherCode: string | null;
  /** ISO 8601. Null when the voucher never expires. */
  expiresAt: string | null;
  printState: BoothPrintState;
  /**
   * Who was signed in at the booth. **Null is a real and expected value** — a
   * sign-in problem must never take the booth down, so the wheel still spins
   * and the spin is flagged unattributed for the `booth.unattributed` alert.
   *
   * It is an opaque id and nothing else: no name, no phone, no photo. The
   * television is in a shopping centre and anybody can read it.
   */
  staffAccountId: string | null;
  /**
   * The box could not vouch for its own clock when it stamped the spin — a Pi
   * has no clock battery and a booth that came up after a mall power cut with
   * no NTP will happily stamp 1970 on a morning's spins. It travels to the page
   * so a `#debug` session can explain a day's figures, and to the cloud on the
   * row.
   */
  clockSuspect: boolean;
}

// --- What the `staff` cache scope gains -------------------------------------

/**
 * The fields the booth adds to each entry of the `staff` cache scope.
 *
 * **Why the existing scope gains fields rather than getting one of its own.**
 * `staff` already carries a rule the booth would otherwise have to re-earn:
 * the api refuses to serve it unless the deny-list is pulled in the same
 * request, and the agent refuses to apply it otherwise (`planCacheApply`). A
 * box may not hold a list of who may work here without the list of whose
 * access has been withdrawn. A new `booth_staff` scope would start life
 * outside that pairing, and the first person to notice would be somebody
 * whose PIN still opened a booth a week after they left.
 *
 * These are ADDITIONS to the entry `apps/api/src/services/sync.ts` already
 * builds and `OfflineStaffRecord` in `@oto/box-agent` already reads —
 * `accountId`, `passwordHash`, `status`, `mustChangePassword`, `lastTokenAt`.
 * All three are optional and nullable, so a box older than this ticket parses
 * a bundle carrying them and a cloud older than this ticket serves entries
 * without them.
 */
export interface BoothStaffCacheFields {
  /**
   * argon2id over the booth PIN, from `core.credential` (kind `pin`).
   *
   * **It is not a lookup key and cannot be made into one.** argon2id salts per
   * row, so there is no query — online or offline — that turns four typed
   * digits into an account. Whatever screen takes a PIN has to know whose PIN
   * it is first, which is what `staffCode` is for. A "type any PIN and we will
   * find you" overlay cannot be built on this field: it would mean verifying
   * the typed digits against every cached staff row in turn, which is both
   * slow by design and a four-digit brute force against the whole branch.
   */
  pinHash?: string | null;
  /** ISO 8601; null means the PIN does not expire. */
  pinExpiresAt?: string | null;
  /**
   * The badge secret's digest, from `core.credential` (kind `badge`).
   *
   * **Open decision, flagged rather than assumed.** A scan is meant to sign
   * somebody in on its own, and that requires finding an account FROM the
   * scanned value — which an argon2id hash cannot do, for the reason above. A
   * deterministic keyed digest (HMAC over the badge number with a per-operator
   * key) can be looked up and is what this field would have to hold for
   * badge-scan sign-in to work offline; `core.credential.secret_hash` as it
   * stands is argon2id for every kind. Whoever builds PIN and badge management
   * (S2-07b) settles this: either this field carries a keyed digest and the
   * credential row says which, or a badge scan produces a staff code and the
   * PIN path below is the only one. Nothing writes it today.
   */
  badgeHash?: string | null;
  /**
   * The short code that says WHICH account is signing in — what a person types
   * before their PIN, or what a badge resolves to.
   *
   * **No column holds this yet.** It is in the contract because the PIN cannot
   * be a lookup key and something has to be, and because a field invented
   * later by whichever slice needs it first is how two surfaces end up
   * disagreeing about what a staff member types at a booth. The slice that
   * builds PIN management owns where it lives and how it is allocated.
   */
  staffCode?: string | null;
  /**
   * What the slip and the television call this person: the employee's
   * nickname, or their name when they have none (SCRUM-223).
   *
   * **Carried only for people on a booth of the box being served**, because
   * it is the one field here that names somebody to whoever holds the disk. A
   * booth needs it to print "Staff: Nok (S-7KMQ)" with no internet, and a till
   * does not need it at all, so a till's box is not sent it.
   */
  displayName?: string | null;
}

/**
 * The alphabet a staff code is written in: the thirty characters the booth
 * code draws from (`BOOTH_CODE_ALPHABET`), restated rather than imported so a
 * change to how vouchers are spelled cannot quietly re-spell every staff code
 * already printed on a slip.
 */
const STAFF_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The short code printed beside a staff member's name on a booth voucher,
 * e.g. `S-7KMQ` (SCRUM-223).
 *
 * **Derived, not stored.** No column holds a staff code yet, and one is needed
 * now: two people called Nok at one park must not be the same line on a slip.
 * So the code is computed from the account id — the same id always gives the
 * same code, on the cloud and on every box, with nothing to allocate or keep
 * in step. It is not a secret and not a lookup key for signing in; it only
 * tells two people apart on paper.
 *
 * Four characters from thirty is 810,000 codes, so two of fifty booth staff
 * sharing one is about a one-in-seven-hundred chance. The account id on the
 * spin row stays the identity; this is what a person reads. A later slice that
 * allocates codes in a column replaces this function and nothing else.
 */
export function boothStaffCode(accountId: string): string {
  // A UUID's last twelve hex digits are its random tail (UUIDv7 puts the
  // timestamp at the front), which is what spreads the codes out: accounts
  // created in one seed run share their leading digits.
  const hex = accountId.replace(/[^0-9a-fA-F]/g, '').slice(-12).padStart(12, '0');
  let value = Number.parseInt(hex, 16);
  let code = '';
  for (let i = 0; i < 4; i += 1) {
    code = STAFF_CODE_ALPHABET[value % STAFF_CODE_ALPHABET.length] + code;
    value = Math.floor(value / STAFF_CODE_ALPHABET.length);
  }
  return `S-${code}`;
}

/** "Nok (S-7KMQ)", "S-7KMQ", "Nok" or null — the Staff row of a booth voucher. */
export function boothStaffLabel(
  name: string | null | undefined,
  code: string | null | undefined,
): string | null {
  const n = typeof name === 'string' ? name.trim() : '';
  const c = typeof code === 'string' ? code.trim() : '';
  if (n !== '' && c !== '') return `${n} (${c})`;
  if (n !== '') return n;
  if (c !== '') return c;
  return null;
}

// --- The day's booth staff (SCRUM-473) --------------------------------------

/**
 * The day's roster of one booth, as the box receives it on the `booth` cache
 * scope beside `allowedStaff` (SCRUM-473, plan decisions D4-D6).
 *
 * `date` is the branch's trading day the roster is for; a box compares it with
 * its own trading day and treats a roster for any other day as empty, so a box
 * that has been offline since yesterday does not print yesterday's names.
 *
 * Each person carries the name the slip prints and, when they have one, the
 * account that may sign in. A casual worker has no account and never will:
 * named on the slip, never signed in (the owner's decision). The account ids
 * are ALSO sign-in eligibility on that day — the union of the roster and the
 * standing `allowedStaff` list (D5.2).
 *
 * **Optional on the entry, and old boxes ignore it**: the box's cache entry
 * schema is a plain (non-strict) zod object, so a box built before this field
 * strips it and goes on printing the signed-in person, exactly as before.
 */
export const BoothDutyRosterSchema = z.object({
  /** `YYYY-MM-DD`, the branch's trading day. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  people: z
    .array(
      z.object({
        /** Null for a casual worker. */
        accountId: z.string().uuid().nullable(),
        displayName: z.string().min(1),
      }),
    )
    .default([]),
});
export type BoothDutyRoster = z.infer<typeof BoothDutyRosterSchema>;

/**
 * Names joined as a person would say them: "Tom", "Tom and Jerry",
 * "Tom, Jerry and Nok". No Oxford comma — the slip is printed in the park's
 * English, which does not use one, and the line is narrow.
 *
 * Blank names are dropped and a name repeated (case-insensitively, trimmed) is
 * said once, so one person reaching the label two ways never prints twice.
 * Null when nobody is left.
 */
export function joinBoothStaffNames(names: readonly (string | null | undefined)[]): string | null {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(name);
  }
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  return `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}`;
}

/**
 * The Staff row of a booth voucher, merged for the day (SCRUM-473, D6).
 *
 * The ladder, in order:
 *
 *  1. **A roster for today** — every name on it, joined naturally, plus the
 *     person signed in when they are not already on it (a stand-in who signed
 *     in through the standing list joins the day's label: D5.2). The signed-in
 *     person is added by NAME only; the roster is names, and "Tom, Jerry and
 *     Nok (S-7KMQ)" would print one person's code as though it were all three.
 *     A stand-in with no name on record prints their code instead.
 *  2. **Nobody attributed today** (no roster, or an empty one) and somebody
 *     signed in — exactly today's slip: `signedInLabel` ("Nok (S-7KMQ)")
 *     unchanged, byte for byte.
 *  3. **Neither** — null, which the template prints as "unattributed", as today.
 *
 * The untouched-slip guarantee of step 2 is scoped to BEFORE anyone is
 * attributed today. The moment the day's roster holds anyone — the rota's
 * people, a manual add, or a stand-in self-assigned at their first sign-in at
 * a booth with no rota — step 1 applies and the label is names only for the
 * rest of the day: "Nok" replacing "Nok (S-7KMQ)" after the first attribution
 * of the day is the owner's format ruling, not a regression.
 *
 * `roster` is taken only when its `date` is `today`; any other day's roster is
 * treated as absent.
 */
export function boothDutyLabel(input: {
  roster: BoothDutyRoster | null | undefined;
  today: string;
  signedIn: {
    accountId: string;
    name: string | null;
    /** `boothStaffLabel(name, code)` — what the slip prints today. */
    label: string | null;
  } | null;
}): string | null {
  const people =
    input.roster && input.roster.date === input.today ? input.roster.people : [];
  if (people.length === 0) return input.signedIn?.label ?? null;
  const names: (string | null)[] = people.map((p) => p.displayName);
  const who = input.signedIn;
  if (who && !people.some((p) => p.accountId === who.accountId)) {
    names.push(who.name ?? who.label);
  }
  return joinBoothStaffNames(names);
}

// --- Signing in at the booth (SCRUM-223) ------------------------------------

/**
 * How the person at the booth proved who they are.
 *
 * `pin` is checked on the box against the argon2id hashes on its staff scope,
 * with or without internet. `account` is a phone and password checked by the
 * CLOUD — the box forwards them to `BOOTH_STAFF_VERIFY_PATH` under its own
 * credential — so it needs the internet and is refused without it. `badge` is
 * declared and still finds nobody (no badge hash is sent to a box yet).
 */
export const BOOTH_SIGN_IN_METHODS = ['pin', 'account', 'badge'] as const;
export type BoothSignInMethod = (typeof BOOTH_SIGN_IN_METHODS)[number];

/**
 * Why a sign-in at the booth was refused, as a CODE the television turns into
 * its own words (D15). None of these is an error: a refused sign-in is a 200
 * with `ok: false`, and the wheel goes on playing unattributed.
 *
 *  - `wrong` — the PIN, or the phone and password, did not match.
 *  - `locked` — too many wrong attempts; `retryAfterMs` says how long.
 *  - `offline` — an account sign-in needs the internet and the box has none.
 *    The television says "No internet — sign in with your PIN".
 *  - `not_allowed` — the password was right, and this person's role does not
 *    carry `booth:staff:sign_in`.
 *  - `not_assigned` — the password was right, and an administrator has not
 *    put this person on this booth.
 *  - `must_change_password` — a temporary password: change it on the POS
 *    first. A booth has no screen for choosing a new one.
 *  - `unavailable` — the box could not check at all (no station, no store).
 *  - `box_refused` — the cloud answered, and refused the BOX rather than the
 *    person: its credential was revoked or replaced in the Console, or the box
 *    was taken out of service. The internet is fine, so "No internet" would
 *    be untrue; the television says the box is no longer allowed here.
 *  - `booth_not_on_box` — the cloud answered that this booth station is not
 *    on this box any more: moved to another box, archived, or no longer a
 *    booth. This box's copy is out of date until its next pull.
 */
export const BOOTH_SIGN_IN_REFUSALS = [
  'pin_expired',
  'wrong',
  'locked',
  'offline',
  'not_allowed',
  'not_assigned',
  'must_change_password',
  'unavailable',
  'box_refused',
  'booth_not_on_box',
] as const;
export type BoothSignInRefusal = (typeof BOOTH_SIGN_IN_REFUSALS)[number];

/**
 * Who is signed in at the booth, as the television shows it.
 *
 * **A deliberate change to D15, on the owner's instruction of 24 September**:
 * the corner of the screen names the person attending, the way a name badge
 * would. It carries the display name and the staff code and nothing else — no
 * account id, no phone, nothing that is a credential.
 */
export interface BoothStaffOnDuty {
  name: string | null;
  code: string | null;
  method: BoothSignInMethod;
  signedInAt: string;
  /** When the session ends by itself: sign-in plus the booth's session length. */
  expiresAt: string | null;
}

/**
 * The box asks the cloud to check a phone and password for its booth.
 *
 * Under the BOX's credential, never a person's session: the box is the only
 * caller, and it can only ask about a booth station that is its own.
 */
export const BOOTH_STAFF_VERIFY_PATH = '/box/v1/booth/staff/verify';

export const BoothStaffVerifyRequestSchema = z.object({
  stationId: z.string().uuid(),
  /** As typed; the cloud normalises it the way sign-in does. */
  phone: z.string().min(3).max(32),
  password: z.string().min(1).max(256),
});
export type BoothStaffVerifyRequest = z.infer<typeof BoothStaffVerifyRequestSchema>;

/** Who the cloud found, when it found somebody who may sign in here. */
export interface BoothStaffVerifyResponse {
  accountId: string;
  displayName: string | null;
  staffCode: string;
}

/**
 * The error codes the verify route answers with, so the box can tell a wrong
 * password from its own credential being refused — both are a 401.
 */
export const BOOTH_STAFF_VERIFY_ERRORS = {
  invalid: 'INVALID_CREDENTIALS',
  notAllowed: 'BOOTH_SIGN_IN_NOT_ALLOWED',
  notAssigned: 'BOOTH_STAFF_NOT_ASSIGNED',
  mustChangePassword: 'MUST_CHANGE_PASSWORD',
  locked: 'BOOTH_STAFF_LOCKED',
  /** 404: the station asked about is not a live booth on the asking box. */
  boothNotOnBox: 'BOOTH_NOT_ON_THIS_BOX',
  /**
   * 403: the box has been taken out of service. Answered by the box
   * credential check in front of every `/box/v1/*` route (`authenticateBox`),
   * like the plain 401 for a credential that is no longer this box's; named
   * here because the box has to tell both apart from a wrong password.
   */
  boxDisabled: 'BOX_DISABLED',
} as const;

/** `POST /booth/reprint` — the last voucher of this booth, or one spin's. */
export interface BoothReprintRequest {
  spinId?: string;
}

export interface BoothReprintResponse {
  spinId: string;
  /** What became of the new copy. The code on it is the one already issued. */
  printState: BoothPrintState;
}

// --- The paired screen (SCRUM-244) ------------------------------------------

/**
 * The header a booth television sends on every `/booth/*` call.
 *
 * Named here because three places have to spell it identically and none of
 * them can see the other two: the page (`apps/booth/src/booth/client.ts`), the
 * api's credential plugin, and whatever proxy or rewrite sits between them.
 * Lower case, because Fastify lower-cases incoming header names and a
 * constant that only matches when someone remembers to `.toLowerCase()` is a
 * constant that will one day not match.
 *
 * **Not `Authorization`.** A booth carries no session and no bearer token in
 * the platform's sense; a header of its own keeps "this is a paired screen"
 * visibly distinct from "this is a box" and from "this is a signed-in person"
 * in a log, in a proxy rule and in a reviewer's head.
 */
export const BOOTH_DEVICE_HEADER = 'x-oto-booth-device';

/** `POST /booth/pair` — the six digits a member of staff types at the booth. */
export interface BoothPairRequest {
  code: string;
}

/**
 * What the screen keeps afterwards.
 *
 * `deviceSecret` is returned exactly once and is stored on the server only as
 * a hash, so a page that loses it has to be paired again — which is a member
 * of staff pressing "Pair a screen" in the Console, not a recovery flow.
 *
 * **No booth NAME and no branch on this answer** (D15): the page has no use
 * for either and a television in a shopping centre should not be able to say
 * which park it belongs to. The station id is here because the page shows
 * nothing with it — it is what makes "this credential is for another booth"
 * a refusal the api can make rather than a mystery.
 */
export interface BoothPairResponse {
  deviceSecret: string;
  stationId: string;
}

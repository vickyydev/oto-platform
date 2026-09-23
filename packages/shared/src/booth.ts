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
 * document, no terms text, no stock level: a bundle is what the wheel needs to
 * draw and to name a prize, and the box resolves the rest at print time. The
 * whole thing sits on a Raspberry Pi in a shopping mall that anybody can carry
 * out of a storeroom.
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
});
export type BoothConfigSettings = z.infer<typeof BoothConfigSettingsSchema>;

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

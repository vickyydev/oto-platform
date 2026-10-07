import { z } from 'zod';
import { BENEFIT_ROLES, BenefitTargetSchema, type PercentDiscountBenefit } from './benefits';

/**
 * The staff benefit QR (S2-21, SCRUM-218, round 2 of
 * docs/progress/plans/benefits/PLAN.md §4, §5 and §7).
 *
 * The prototype's QR is a readable string (`OTO-BENEFIT-OP-4`) that anybody
 * can type and that comps any order (`mockApi.ts:430-435`). The platform's is
 * a credential it signs: the payload the plan names, `OTO-BEN:v1:<employee>:
 * <credential>:<exp>`, the key id it was signed under, and an Ed25519
 * signature — the scheme the platform already uses for the shift token
 * (`staff-token.ts`): the private half stays in the api
 * (`BENEFIT_QR_PRIVATE_KEY`), the public half is a `core.signing_key` row with
 * purpose `benefit_qr` and travels to every box, so a box can CHECK a QR with
 * no network and can never MINT one.
 *
 * THE SHAPE, worked through once:
 *
 *   OTO-BEN:v1:<employee uuid>:<credential uuid>:<exp>:<kid>.<signature>
 *   ^^^^^^^^ ^^                                         ^^^^^ ^^^^^^^^^^^
 *   │        │                                          │     └ Ed25519 over everything before
 *   │        │                                          │       the dot, base64url, 86 characters
 *   │        │                                          └ which `core.signing_key` row verifies
 *   │        │                                            it: 16 hex characters of SHA-256
 *   │        │                                            over the public half
 *   │        └ the format's version; a new format is a new number, never a reuse
 *   └ the header no other code the platform prints can carry
 *
 * WHY NOTHING ELSE CAN BE READ AS ONE OF THESE. A band code is letters and
 * digits, a dot and a signature — no colon (`band-code.ts`); a booking QR
 * starts `BK1:`; a voucher is eleven characters; a product barcode is digits;
 * a shift token is three base64url parts with no colon. A benefit QR is none
 * of them, and the places that take one of them refuse it in their own words:
 * the gate reader says "scan your wristband", sign-in and the till's badge
 * path say it signs nobody in, and the booth says it is not a staff badge.
 *
 * WHAT IS NOT IN IT. No name — the box reads the name from its `benefits`
 * scope, the cloud from `core.employee` — and no benefit: what a QR applies is
 * the person's profile on the day it is scanned, so a template change reaches
 * every QR without reissuing any.
 *
 * NOTHING HERE READS A CLOCK OR A KEY, and nothing imports `node:crypto`: this
 * file is bundled into the browser. Signing and verifying are in
 * `@oto/box-agent` (`benefit-credential.ts`), which the api imports, so one
 * codec signs and verifies.
 */

/** Every benefit QR starts with this. */
export const BENEFIT_CREDENTIAL_HEADER = 'OTO-BEN:';
/** Bumped when the payload changes MEANING. A box refuses a version it cannot read. */
export const BENEFIT_CREDENTIAL_VERSION = 1;
/** Ed25519, matching `core.signing_key.algorithm`. */
export const BENEFIT_CREDENTIAL_ALGORITHM = 'ed25519';
/** The `core.signing_key.purpose` the public halves are published under. */
export const BENEFIT_CREDENTIAL_KEY_PURPOSE = 'benefit_qr';

/**
 * How long a benefit QR is good for, in days, from issue.
 *
 * The prototype's code never expires, and the plan's payload carries an
 * expiry without naming one. A year is chosen against the two failures: a QR
 * that expires every shift is a card reprinted every day, and one that never
 * expires is a credential whose only end is a revocation somebody remembered
 * to make. The revocation list a box holds is bounded by this: a revoked QR
 * leaves the list once its own expiry refuses it. An owner question (round 2).
 */
export const BENEFIT_CREDENTIAL_TTL_DAYS = 365;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SHAPE = new RegExp(
  `^OTO-BEN:v1:(${UUID}):(${UUID}):([0-9]{1,12}):([0-9a-f]{16})\\.([A-Za-z0-9_-]{86})$`,
);
const VERSION = /^OTO-BEN:v([0-9]{1,4}):/;

/**
 * Does this string carry the benefit QR's header? Trimmed, and the header
 * read without regard to case, so a scanner set to upper-case everything is
 * still recognised as having read a benefit QR — and refused as one where it
 * is not the right thing, rather than as a string that means nothing.
 */
export function hasBenefitCredentialHeader(code: string): boolean {
  return (
    code.trim().slice(0, BENEFIT_CREDENTIAL_HEADER.length).toUpperCase() ===
    BENEFIT_CREDENTIAL_HEADER
  );
}

export interface ParsedBenefitCredential {
  version: number;
  employeeId: string;
  credentialId: string;
  /** Expires at, seconds since the epoch. */
  exp: number;
  kid: string;
  /** The bytes the signature is over: everything before the last dot. */
  signingInput: string;
  /** base64url. */
  signature: string;
}

export type BenefitCredentialParse =
  | { ok: true; credential: ParsedBenefitCredential }
  /** `malformed`: not a benefit QR this platform printed. `version`: one from a newer platform. */
  | { ok: false; reason: 'malformed' | 'version'; version?: number };

/**
 * Split a benefit QR into its parts. **Nothing here is trusted**: the parts
 * are attacker-controlled until `verifyBenefitCredential` (`@oto/box-agent`)
 * has checked the signature, and this exists so a verifier can find the key.
 */
export function parseBenefitCredential(raw: string): BenefitCredentialParse {
  const code = raw.trim();
  const version = VERSION.exec(code);
  if (version && Number(version[1]) > BENEFIT_CREDENTIAL_VERSION) {
    return { ok: false, reason: 'version', version: Number(version[1]) };
  }
  const match = SHAPE.exec(code);
  if (!match) return { ok: false, reason: 'malformed' };
  const [, employeeId, credentialId, exp, kid, signature] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const dot = code.lastIndexOf('.');
  return {
    ok: true,
    credential: {
      version: BENEFIT_CREDENTIAL_VERSION,
      employeeId,
      credentialId,
      exp: Number(exp),
      kid,
      signingInput: code.slice(0, dot),
      signature,
    },
  };
}

/** The bytes a benefit QR's signature is over. One function, so mint and verify cannot drift. */
export function benefitCredentialSigningInput(input: {
  employeeId: string;
  credentialId: string;
  exp: number;
  kid: string;
}): string {
  return `${BENEFIT_CREDENTIAL_HEADER}v${BENEFIT_CREDENTIAL_VERSION}:${input.employeeId}:${input.credentialId}:${input.exp}:${input.kid}`;
}

// --- Refusals, and the words for them -----------------------------------------

/** Why a benefit QR was not applied. One code per cause; the cloud and the box share them. */
export const BENEFIT_CREDENTIAL_REFUSALS = {
  /** Has the header and is not a QR this platform printed. */
  MALFORMED: 'BENEFIT_CREDENTIAL_MALFORMED',
  /** A format newer than this box or api can read. */
  SCHEMA_TOO_NEW: 'BENEFIT_CREDENTIAL_SCHEMA_TOO_NEW',
  /** Names a key nobody here holds (another deployment's, or one retired). */
  UNKNOWN_KEY: 'BENEFIT_CREDENTIAL_UNKNOWN_KEY',
  /** The signature does not verify: altered, or invented. */
  INVALID: 'BENEFIT_CREDENTIAL_INVALID',
  /** Past its own expiry. */
  EXPIRED: 'BENEFIT_CREDENTIAL_EXPIRED',
  /** Revoked by an administrator. The acceptance's "benefit revoked". */
  REVOKED: 'BENEFIT_REVOKED',
  /** The person has left (an archived employee): every QR of theirs is refused. */
  EMPLOYEE_LEFT: 'BENEFIT_EMPLOYEE_LEFT',
  /** Signed, and names nobody this park has — or a credential it has no record of. */
  NOT_FOUND: 'BENEFIT_NOT_FOUND',
  /** The person has nothing set up on the day (prototype `isEmptyBenefitProfile`). */
  NOT_CONFIGURED: 'BENEFIT_NOT_CONFIGURED',
  /**
   * The box holds no `benefits` scope, so it cannot say whether this QR was
   * revoked — and refuses rather than assume it was not (the shift token's
   * `REVOCATION_UNKNOWN`, for the same reason).
   */
  REVOCATION_UNKNOWN: 'BENEFIT_REVOCATION_UNKNOWN',
} as const;
export type BenefitCredentialRefusal =
  (typeof BENEFIT_CREDENTIAL_REFUSALS)[keyof typeof BENEFIT_CREDENTIAL_REFUSALS];

/**
 * The longest signing input the v1 shape admits: header and version, two
 * uuids, a twelve-digit expiry and a sixteen-character key id, with their
 * colons. Nothing a refusal echoes of a benefit QR is longer than this.
 */
const SHOWN_MAX = 'OTO-BEN:v1:'.length + (36 + 1) * 2 + (12 + 1) + 16;

/**
 * What a refusal may say back of a scanned or typed code: anything without
 * the benefit QR's header as it was read (the prototype's own echo), and a
 * benefit QR only up to its signature — never the signature.
 *
 * A refused QR is not a dead one. A box that has not pulled a rotated key yet,
 * a holder whose role is gone today and returns tomorrow, a park the QR is
 * not from, and a QR with one id altered but its genuine signature still on
 * it are all refused, and every one of them carries a signature that verifies
 * somewhere. The words are shown on the till, ride the scan to every screen
 * watching the station — the one facing the guest included — and sit in an
 * error answer the replay store keeps, so they must hold nothing a camera
 * could turn back into the QR. Cut at the first dot (the signing input has
 * none) and, should a scanner have mangled the dot, at the length a signing
 * input can be.
 */
export function benefitCodeShown(raw: string): string {
  const code = raw.trim();
  if (!hasBenefitCredentialHeader(code)) return code;
  const dot = code.indexOf('.');
  const unsigned = dot === -1 ? code : code.slice(0, dot);
  return unsigned.length > SHOWN_MAX ? `${unsigned.slice(0, SHOWN_MAX)}…` : unsigned;
}

/**
 * What the till says. The first two are the prototype's own
 * (`BenefitScanModal.tsx:34-38`) and are kept word for word — `notFound`
 * echoes what was read as the prototype does, short of a benefit QR's
 * signature (`benefitCodeShown`); the rest are the platform's, for refusals
 * the prototype could not make.
 */
export const BENEFIT_WORDS = {
  notFound: (code: string) => `No staff benefit found for "${benefitCodeShown(code)}".`,
  notConfigured: (name: string) => `${name} has no benefit configured.`,
  revoked: (name: string | null) =>
    name
      ? `Benefit revoked: ${name}'s QR no longer applies a staff benefit.`
      : 'Benefit revoked: this QR no longer applies a staff benefit.',
  expired: 'This benefit QR has expired. Ask a manager for a new one.',
  employeeLeft: (name: string) => `${name} has left, so their benefit QR no longer applies.`,
  revocationUnknown:
    'This box has no staff benefit list yet, so it cannot check a benefit QR. It arrives with the box’s next update.',
} as const;

/**
 * What sign-in and the till's badge path say when they are handed a benefit
 * QR (plan H8): it is a benefit at the F&B order station, not a way in.
 */
export const BENEFIT_QR_NOT_A_SIGN_IN =
  'That is a staff benefit QR. It applies a benefit at the F&B order station and signs nobody in.';

// --- The `benefits` cache scope -----------------------------------------------

/** A public half as the scope carries it — never a private one. */
export const BenefitScopeKeySchema = z.object({
  purpose: z.string(),
  kid: z.string(),
  algorithm: z.string(),
  /** SPKI PEM. */
  publicKey: z.string(),
});
export type BenefitScopeKey = z.infer<typeof BenefitScopeKeySchema>;

/** The stages that draw on a quota: online only, never applied by a box (plan §4, R-48). */
export const BENEFIT_ONLINE_ONLY_STAGES = ['freeItems', 'credit'] as const;
export type BenefitOnlineOnlyStage = (typeof BENEFIT_ONLINE_ONLY_STAGES)[number];

/**
 * What a box may apply for one person over a run of trading days,
 * `[from, to)`: the comp and the standing percent, which carry no quota. The
 * free items and the credit stay in the cloud (plan §7); `onlineOnly` says
 * only that the person HAS them, so the till can say "online only" rather
 * than nothing.
 */
export const BenefitScopeDaySchema = z.object({
  from: z.string(),
  /** Exclusive; null runs on. */
  to: z.string().nullable(),
  benefitRole: z.enum(BENEFIT_ROLES).nullable(),
  comp: z.boolean(),
  standingDiscount: z
    .object({ percent: z.number().min(0).max(100), target: BenefitTargetSchema.optional() })
    .nullable(),
  onlineOnly: z.array(z.enum(BENEFIT_ONLINE_ONLY_STAGES)),
});
export type BenefitScopeDay = z.infer<typeof BenefitScopeDaySchema>;

export const BenefitScopeEmployeeSchema = z.object({
  employeeId: z.string().uuid(),
  name: z.string(),
  /** From the day the scope was built on, soonest first, never overlapping. */
  days: z.array(BenefitScopeDaySchema),
});
export type BenefitScopeEmployee = z.infer<typeof BenefitScopeEmployeeSchema>;

/**
 * The `benefits` scope's ONE item, applied whole: half a revocation list is
 * a revoked QR admitted.
 */
export const BenefitScopeItemSchema = z.object({
  /** Over everything below, so a box can tell the same list from a new one. */
  version: z.string(),
  /** The `benefit_qr` public halves a QR may be verified against. */
  keys: z.array(BenefitScopeKeySchema),
  /** Revoked and not yet expired. Past its expiry a QR refuses itself. */
  revokedCredentialIds: z.array(z.string().uuid()),
  /** People who have left and whose QRs have not all expired. */
  revokedEmployeeIds: z.array(z.string().uuid()),
  employees: z.array(BenefitScopeEmployeeSchema),
});
export type BenefitScopeItem = z.infer<typeof BenefitScopeItemSchema>;

/** The run of days a person's benefit is in force on `day`, or null. */
export function benefitScopeDayOn(
  person: BenefitScopeEmployee,
  day: string,
): BenefitScopeDay | null {
  return person.days.find((d) => d.from <= day && (d.to === null || d.to > day)) ?? null;
}

/** Whether a day's offline facts give anything at all, the online-only stages included. */
export function benefitScopeDayIsEmpty(d: BenefitScopeDay | null): boolean {
  return !d || !d.benefitRole || (!d.comp && !d.standingDiscount && d.onlineOnly.length === 0);
}

/** What a person's offline facts are, read off a profile. */
export function offlineBenefitFacts(profile: {
  comp?: boolean;
  freeItems?: unknown[];
  credit?: unknown;
  standingDiscount?: PercentDiscountBenefit;
}): Pick<BenefitScopeDay, 'comp' | 'standingDiscount' | 'onlineOnly'> {
  const onlineOnly: BenefitOnlineOnlyStage[] = [];
  if ((profile.freeItems ?? []).length > 0) onlineOnly.push('freeItems');
  if (profile.credit) onlineOnly.push('credit');
  return {
    comp: Boolean(profile.comp),
    standingDiscount: profile.standingDiscount
      ? {
          percent: profile.standingDiscount.percent,
          ...(profile.standingDiscount.target ? { target: profile.standingDiscount.target } : {}),
        }
      : null,
    onlineOnly,
  };
}

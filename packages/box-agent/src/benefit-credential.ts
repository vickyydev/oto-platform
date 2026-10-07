import { createHash, createPublicKey, sign, verify } from 'node:crypto';

import {
  BENEFIT_CREDENTIAL_ALGORITHM,
  BENEFIT_CREDENTIAL_KEY_PURPOSE,
  BENEFIT_CREDENTIAL_REFUSALS,
  BENEFIT_WORDS,
  BenefitScopeItemSchema,
  benefitCredentialSigningInput,
  benefitScopeDayIsEmpty,
  benefitScopeDayOn,
  hasBenefitCredentialHeader,
  parseBenefitCredential,
  type BenefitCredentialRefusal,
  type BenefitScopeDay,
  type BenefitScopeItem,
} from '@oto/shared';

import type { ScanHandler, ScanHandlerResult } from './scan';
import type { StaffSigningKey } from './staff-token';

/**
 * The staff benefit QR, signed and checked (S2-21, SCRUM-218, round 2 of
 * docs/progress/plans/benefits/PLAN.md).
 *
 * The same scheme as the shift token (`staff-token.ts`), and for the same
 * reasons: Ed25519, the private half in the api's environment
 * (`BENEFIT_QR_PRIVATE_KEY`), the public half a `core.signing_key` row with
 * purpose `benefit_qr` that travels to every box. A box holding a stolen disk
 * can CHECK a benefit QR and can never MINT one — which matters more here than
 * for a shift token, because the owner's QR comps a whole order.
 *
 * Both halves live in this package, as the shift token's do, so the bytes that
 * are signed and the bytes that are verified come out of one function
 * (`benefitCredentialSigningInput` in `@oto/shared`). The shape — header,
 * parts, the words a refusal is said in — is in `@oto/shared`
 * (`benefit-credential.ts`), because the till and the gate read it in a
 * browser and on a box with no `node:crypto` in their path.
 *
 * **What a box decides about a benefit QR, and what it leaves.** It decides
 * that this platform signed it, that it has not expired, that it is not on the
 * revocation list the box holds and its holder has not left, and who it names
 * — and it answers with that person's comp and standing percent for the
 * trading day, which carry no quota and so may be applied offline. Free items
 * and the credit pool draw on a quota that lives in the cloud and are
 * "online only" (plan §4, R-48): the box says the person HAS them and applies
 * neither.
 *
 * **A revocation reaches a box on its next pull.** The cloud refuses a revoked
 * QR from the moment it is revoked; a box refuses it once its `benefits` scope
 * carries the revocation, which is its next cache refresh — and for a box that
 * is offline, whenever it is next online. That is the property of offline
 * working the shift token documents, and the bound is the same: a QR's own
 * expiry. A box with NO `benefits` scope refuses every benefit QR
 * (`BENEFIT_REVOCATION_UNKNOWN`) rather than admit one it cannot check.
 */

/** The claims a benefit QR carries, as the cloud mints them. */
export interface BenefitCredentialClaims {
  employeeId: string;
  credentialId: string;
  /** Expires at, seconds since the epoch. */
  exp: number;
}

/**
 * Sign a benefit QR. Exported from the box package although only the api
 * calls it, so one function produces the signed bytes and the checked ones.
 *
 * Ed25519 is deterministic (RFC 8032): the same claims under the same key are
 * the same QR every time, which is what lets the api print a QR again from the
 * row it keeps rather than storing the code.
 */
export function encodeBenefitCredential(
  claims: BenefitCredentialClaims,
  key: { kid: string; privateKeyPem: string },
): string {
  const signingInput = benefitCredentialSigningInput({ ...claims, kid: key.kid });
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), key.privateKeyPem);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** Lower-case hex SHA-256 of a printed QR — what `promo.benefit_credential.code_hash` holds. */
export function benefitCredentialHash(code: string): string {
  return createHash('sha256').update(code.trim(), 'utf8').digest('hex');
}

export interface VerifiedBenefitCredential extends BenefitCredentialClaims {
  kid: string;
  expiresAt: Date;
}

export type BenefitCredentialVerification =
  | { ok: true; credential: VerifiedBenefitCredential }
  | { ok: false; refusal: BenefitCredentialRefusal };

/**
 * Check a benefit QR's signature and expiry against the public halves held —
 * shape, version, key, signature, expiry, in that order, the signature before
 * anything the claims say. Revocation is the caller's: the cloud reads its
 * rows, a box its `benefits` scope (`checkBenefitOnBox`).
 */
export function verifyBenefitCredential(
  code: string,
  options: { keys: readonly StaffSigningKey[]; now?: Date },
): BenefitCredentialVerification {
  const parsed = parseBenefitCredential(code);
  if (!parsed.ok) {
    return {
      ok: false,
      refusal:
        parsed.reason === 'version'
          ? BENEFIT_CREDENTIAL_REFUSALS.SCHEMA_TOO_NEW
          : BENEFIT_CREDENTIAL_REFUSALS.MALFORMED,
    };
  }
  const c = parsed.credential;
  const key = options.keys.find(
    (k) =>
      k.purpose === BENEFIT_CREDENTIAL_KEY_PURPOSE &&
      k.kid === c.kid &&
      k.algorithm === BENEFIT_CREDENTIAL_ALGORITHM,
  );
  if (!key) return { ok: false, refusal: BENEFIT_CREDENTIAL_REFUSALS.UNKNOWN_KEY };

  let signatureOk = false;
  try {
    signatureOk = verify(
      null,
      Buffer.from(c.signingInput, 'ascii'),
      createPublicKey(key.publicKey),
      Buffer.from(c.signature, 'base64url'),
    );
  } catch {
    // A malformed key in the bundle: a failed check, not a crash at the till.
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, refusal: BENEFIT_CREDENTIAL_REFUSALS.INVALID };

  const nowS = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (c.exp <= nowS) return { ok: false, refusal: BENEFIT_CREDENTIAL_REFUSALS.EXPIRED };

  return {
    ok: true,
    credential: {
      employeeId: c.employeeId,
      credentialId: c.credentialId,
      exp: c.exp,
      kid: c.kid,
      expiresAt: new Date(c.exp * 1000),
    },
  };
}

// --- On the box ---------------------------------------------------------------

/** What a box holds to check a benefit QR with no network. */
export interface BenefitBoxContext {
  /** The `benefits` scope's one item, or null when this box holds none. */
  scope: BenefitScopeItem | null;
  /** The branch's trading day by this box's clock, or null when it has no branch yet. */
  today: string | null;
  now?: Date;
}

/** Read the `benefits` scope's item out of a stored bundle payload, or null. */
export function readBenefitScope(payload: unknown): BenefitScopeItem | null {
  const items = (payload as { items?: unknown[] } | null)?.items;
  const parsed = BenefitScopeItemSchema.safeParse(Array.isArray(items) ? items[0] : undefined);
  return parsed.success ? parsed.data : null;
}

export interface BenefitOnBox {
  employeeId: string;
  credentialId: string;
  name: string;
  /** The trading day it was resolved for. */
  day: string;
  benefitRole: NonNullable<BenefitScopeDay['benefitRole']>;
  comp: boolean;
  standingDiscount: BenefitScopeDay['standingDiscount'];
  /** Free items and credit the person has, which a box does not apply. */
  onlineOnly: BenefitScopeDay['onlineOnly'];
  expiresAt: string;
}

export type BenefitBoxVerdict =
  | { ok: true; benefit: BenefitOnBox }
  | { ok: false; refusal: BenefitCredentialRefusal; message: string; name?: string };

/**
 * A benefit QR, checked against what this box holds — the cloud's
 * `POST /benefits/resolve`, with no network.
 */
export function checkBenefitOnBox(code: string, context: BenefitBoxContext): BenefitBoxVerdict {
  const shown = code.trim();
  const scope = context.scope;
  if (!scope) {
    return {
      ok: false,
      refusal: BENEFIT_CREDENTIAL_REFUSALS.REVOCATION_UNKNOWN,
      message: BENEFIT_WORDS.revocationUnknown,
    };
  }
  const verified = verifyBenefitCredential(shown, { keys: scope.keys, now: context.now });
  if (!verified.ok) {
    return {
      ok: false,
      refusal: verified.refusal,
      message:
        verified.refusal === BENEFIT_CREDENTIAL_REFUSALS.EXPIRED
          ? BENEFIT_WORDS.expired
          : BENEFIT_WORDS.notFound(shown),
    };
  }
  const { credential } = verified;
  const person = scope.employees.find((e) => e.employeeId === credential.employeeId) ?? null;
  const name = person?.name ?? null;
  if (scope.revokedCredentialIds.includes(credential.credentialId)) {
    return {
      ok: false,
      refusal: BENEFIT_CREDENTIAL_REFUSALS.REVOKED,
      message: BENEFIT_WORDS.revoked(name),
      ...(name ? { name } : {}),
    };
  }
  if (scope.revokedEmployeeIds.includes(credential.employeeId)) {
    return {
      ok: false,
      refusal: BENEFIT_CREDENTIAL_REFUSALS.EMPLOYEE_LEFT,
      message: BENEFIT_WORDS.employeeLeft(name ?? 'This staff member'),
    };
  }
  if (!person) {
    return {
      ok: false,
      refusal: BENEFIT_CREDENTIAL_REFUSALS.NOT_FOUND,
      message: BENEFIT_WORDS.notFound(shown),
    };
  }
  const day = context.today ? benefitScopeDayOn(person, context.today) : null;
  if (!context.today || benefitScopeDayIsEmpty(day) || !day?.benefitRole) {
    return {
      ok: false,
      refusal: BENEFIT_CREDENTIAL_REFUSALS.NOT_CONFIGURED,
      message: BENEFIT_WORDS.notConfigured(person.name),
      name: person.name,
    };
  }
  return {
    ok: true,
    benefit: {
      employeeId: credential.employeeId,
      credentialId: credential.credentialId,
      name: person.name,
      day: context.today,
      benefitRole: day.benefitRole,
      comp: day.comp,
      standingDiscount: day.standingDiscount,
      onlineOnly: day.onlineOnly,
      expiresAt: credential.expiresAt.toISOString(),
    },
  };
}

/** The name the benefit handler goes by on the tape, in the Box log drawer and on the station channel. */
export const BENEFIT_CODE_HANDLER = 'benefit';

/**
 * The handler: a benefit QR read at a counter, checked on the box.
 *
 * Claimed by the router itself (as the booking QR is), because its header is
 * the platform's own: no ticket registers a meaning for it and no broad
 * matcher registered later may take one.
 *
 * WHAT TRAVELS. `detail.benefit` is who it names and what this box may apply
 * for them today; `detail.benefitCode` is the QR itself, because applying
 * free items or credit is the cloud's and the till has to present the QR to
 * it — the voucher code travels for the same reason. The customer display
 * never receives `benefitCode` (`redactScanForCustomer` strips it), and the
 * tape keeps a fingerprint, as for every scan. A refusal travels with no
 * `benefitCode` at all, and its words echo the QR only up to its signature
 * (`BENEFIT_WORDS.notFound`, `benefitCodeShown` in `@oto/shared`): a QR this
 * box refuses for reasons of its own — a key it has not pulled, a holder with
 * no benefit today — is still a live credential, and its words reach every
 * screen watching, the guest's included.
 */
export function benefitCredentialHandler(
  read: () => Promise<BenefitBoxContext | null> | BenefitBoxContext | null,
): ScanHandler {
  return {
    name: BENEFIT_CODE_HANDLER,
    kind: 'benefit',
    matches: hasBenefitCredentialHeader,
    async handle(ctx): Promise<ScanHandlerResult> {
      const context = (await read()) ?? { scope: null, today: null };
      const verdict = checkBenefitOnBox(ctx.code, { ...context, now: context.now ?? ctx.at });
      if (!verdict.ok) {
        return {
          // A box with no list to check against is the box failing, never the
          // QR — said as an error, like a band scanned on a box with no key.
          outcome:
            verdict.refusal === BENEFIT_CREDENTIAL_REFUSALS.REVOCATION_UNKNOWN
              ? 'error'
              : 'refused',
          errorCode: verdict.refusal,
          detail: { message: verdict.message, ...(verdict.name ? { name: verdict.name } : {}) },
        };
      }
      return {
        outcome: 'handled',
        detail: {
          action: 'apply_benefit',
          benefit: verdict.benefit,
          benefitCode: ctx.code.trim(),
          message: `${verdict.benefit.name} — staff benefit checked on this box`,
        },
      };
    },
  };
}

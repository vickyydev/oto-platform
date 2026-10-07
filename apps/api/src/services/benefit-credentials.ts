import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  benefitCredentialHash,
  encodeBenefitCredential,
  verifyBenefitCredential,
} from '@oto/box-agent';
import { benefitCredential, employee, signingKey, type Db } from '@oto/db';
import {
  BENEFIT_CREDENTIAL_KEY_PURPOSE,
  BENEFIT_CREDENTIAL_REFUSALS,
  BENEFIT_CREDENTIAL_TTL_DAYS,
  BENEFIT_CREDENTIAL_VERSION,
  BENEFIT_WORDS,
  hasBenefitCredentialHeader,
  newId,
  offlineBenefitFacts,
  type BenefitProfile,
  type BenefitRole,
  type BenefitScopeDay,
  type BenefitScopeEmployee,
  type BenefitScopeItem,
} from '@oto/shared';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { usableSigningKeys } from '../lib/signing-keys';
import { parseStaffTokenKey, staffTokenKid } from '../lib/staff-token-key';
import { audit } from './audit';
import {
  benefitToday,
  compact,
  effectiveBenefitOn,
  effectiveOn,
  loadEmployee,
  lockScope,
  profileRows,
  templateRows,
  type Actor,
  type VersionAuthor,
} from './benefits';
import { accountNames } from './refund-slices';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * The staff benefit QR, issued, revoked, printed and resolved (S2-21,
 * SCRUM-218, round 2 of docs/progress/plans/benefits/PLAN.md §4, §5 and §7).
 *
 * **The scheme is the shift token's** (`services/staff-token.ts`): an Ed25519
 * private key in the environment (`BENEFIT_QR_PRIVATE_KEY`), its public half a
 * `core.signing_key` row (purpose `benefit_qr`) published at boot and inside
 * every issue, the codec in `@oto/box-agent` so one function signs and
 * verifies, and a row per credential that makes it revocable. The QR format is
 * `@oto/shared`'s `benefit-credential.ts`.
 *
 * **What the QR carries** is the payload behind the prototype's
 * `BenefitQrDialog` — the person's name over the QR and the code under it —
 * with the code now one the platform signed rather than `OTO-BENEFIT-OP-4`.
 * It names the person and the credential and nothing they get: the benefit is
 * read on the day it is scanned, so a template change reaches every QR.
 *
 * **What ends one, and where.** A revocation is refused by the cloud at once
 * (`resolveBenefitCredential` reads the row) and by a box from its next pull
 * of the `benefits` scope (`benefitsCacheItem`), whose revocation list carries
 * every revoked QR still inside its own expiry. Somebody who has left
 * (`core.employee.archived_at`) is refused in both places too.
 *
 * **The QR opens nothing.** It is not a sign-in, not a band and not a staff
 * badge; sign-in, the till's badge path, the gate reader and the booth's
 * badge path each refuse it in their own words (plan H8).
 */

// --- The key ----------------------------------------------------------------

export interface BenefitQrSettings {
  privateKeyPem: string;
  publicKeyPem: string;
  /** Derived from the public half, as the shift token's is. */
  kid: string;
}

const settingsCache = new WeakMap<object, BenefitQrSettings | null>();

export function benefitQrSettings(env: Env): BenefitQrSettings | null {
  const key = env as unknown as object;
  if (settingsCache.has(key)) return settingsCache.get(key) ?? null;
  const raw = env.BENEFIT_QR_PRIVATE_KEY?.trim();
  if (!raw) {
    settingsCache.set(key, null);
    return null;
  }
  const { privateKeyPem, publicKeyPem } = parseStaffTokenKey(raw);
  const settings = { privateKeyPem, publicKeyPem, kid: staffTokenKid(publicKeyPem) };
  settingsCache.set(key, settings);
  return settings;
}

function requireSettings(env: Env): BenefitQrSettings {
  const settings = benefitQrSettings(env);
  if (!settings) {
    throw new AppError(
      503,
      'BENEFIT_QR_UNAVAILABLE',
      'This deployment has no benefit QR key: set BENEFIT_QR_PRIVATE_KEY to an ed25519 private key in PKCS#8 PEM. Until it is set, no benefit QR can be issued or shown; QRs already printed still work.',
    );
  }
  return settings;
}

/**
 * Publish the public half, idempotent on `(purpose, kid)` — the shift token's
 * `publishStaffTokenKey`, for purpose `benefit_qr`. A new key adds a row
 * beside the old one, so QRs printed under the old key keep verifying until it
 * is deliberately retired.
 */
export async function publishBenefitQrKey(exec: Exec, env: Env): Promise<string | null> {
  const settings = benefitQrSettings(env);
  if (!settings) return null;
  await exec
    .insert(signingKey)
    .values({
      id: newId(),
      operatorId: null,
      purpose: BENEFIT_CREDENTIAL_KEY_PURPOSE,
      kid: settings.kid,
      algorithm: 'ed25519',
      publicKey: settings.publicKeyPem,
      active: true,
    })
    .onConflictDoNothing({ target: [signingKey.purpose, signingKey.kid] });
  return settings.kid;
}

// --- Views ------------------------------------------------------------------

type CredentialRow = typeof benefitCredential.$inferSelect;

export type BenefitCredentialStatus = 'active' | 'revoked' | 'expired';

export interface BenefitCredentialView {
  id: string;
  employeeId: string;
  employeeName: string;
  kid: string;
  version: number;
  status: BenefitCredentialStatus;
  issuedAt: string;
  expiresAt: string;
  issuedBy: VersionAuthor | null;
  revokedAt: string | null;
  revokedBy: VersionAuthor | null;
  /** When a benefit was last applied with it (set from round 3); null if never. */
  lastSeenAt: string | null;
}

function statusOf(row: CredentialRow, now: Date): BenefitCredentialStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

async function viewsOf(
  db: Exec,
  rows: readonly CredentialRow[],
  now: Date,
): Promise<BenefitCredentialView[]> {
  if (rows.length === 0) return [];
  const people = await db
    .select({ id: employee.id, name: employee.name })
    .from(employee)
    .where(inArray(employee.id, [...new Set(rows.map((r) => r.employeeId))]));
  const nameOfPerson = new Map(people.map((p) => [p.id, p.name]));
  const nameOf = await accountNames(
    db,
    rows.flatMap((r) => [
      r.issuedByAccountId,
      ...(r.revokedByAccountId ? [r.revokedByAccountId] : []),
    ]),
  );
  const author = (id: string | null): VersionAuthor | null =>
    id ? { accountId: id, name: nameOf(id) } : null;
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeName: nameOfPerson.get(r.employeeId) ?? '',
    kid: r.kid,
    version: r.version,
    status: statusOf(r, now),
    issuedAt: r.issuedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    issuedBy: author(r.issuedByAccountId),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    revokedBy: author(r.revokedByAccountId),
    lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
  }));
}

/** One credential inside the caller's operator, or 404 — another operator's included. */
async function loadCredential(
  db: Exec,
  operatorId: string,
  credentialId: string,
): Promise<CredentialRow> {
  const [row] = await db
    .select()
    .from(benefitCredential)
    .where(
      and(eq(benefitCredential.id, credentialId), eq(benefitCredential.operatorId, operatorId)),
    )
    .limit(1);
  if (!row) throw new AppError(404, 'BENEFIT_CREDENTIAL_NOT_FOUND', 'No such benefit QR');
  return row;
}

/** Every QR issued in the operator, or one person's, newest first. Never the code. */
export async function listBenefitCredentials(
  db: Db,
  operatorId: string,
  opts: { employeeId?: string } = {},
  now: Date = new Date(),
): Promise<BenefitCredentialView[]> {
  const rows = await db
    .select()
    .from(benefitCredential)
    .where(
      and(
        eq(benefitCredential.operatorId, operatorId),
        opts.employeeId ? eq(benefitCredential.employeeId, opts.employeeId) : undefined,
      ),
    )
    .orderBy(desc(benefitCredential.issuedAt), desc(benefitCredential.id))
    .limit(200);
  return viewsOf(db, rows, now);
}

// --- Issue ------------------------------------------------------------------

/** Whether somebody has a benefit role today or from a later day — a QR is for a benefit. */
function hasRoleFrom(
  rows: ReadonlyArray<{
    benefitRole: BenefitRole | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>,
  today: string,
): boolean {
  return rows.some(
    (r) =>
      r.benefitRole !== null &&
      (r.effectiveTo === null || r.effectiveTo > today) &&
      r.effectiveTo !== r.effectiveFrom,
  );
}

/**
 * Issue a staff member's benefit QR. One live QR per person: a second is
 * refused until the first is revoked (or has expired), so "which card is
 * theirs" always has one answer and a lost card is ended by revoking it.
 * Somebody with no benefit role gets none — the prototype's rule: no role,
 * no benefit and no QR. Audited `benefit.credential_issue`, with no key
 * material in the row: the credential's id, the key's id and its dates.
 */
export async function issueBenefitCredential(
  db: Db,
  ctx: OpContext,
  actor: Actor,
  employeeId: string,
  env: Env,
  today: string,
  now: Date = new Date(),
): Promise<{ credential: BenefitCredentialView }> {
  const settings = requireSettings(env);
  const person = await loadEmployee(db, actor.operatorId, employeeId);
  if (person.archivedAt) {
    throw new AppError(
      409,
      'EMPLOYEE_ARCHIVED',
      `${person.name} has left; a benefit QR cannot be issued`,
    );
  }
  return withTx(db, ctx, 'benefit.credential_issue', async (tx) => {
    await lockScope(tx, 'benefit_credential', person.id);
    const versions = await profileRows(tx, actor.operatorId, [person.id]);
    if (!hasRoleFrom(versions, today)) {
      throw new AppError(
        409,
        'BENEFIT_NO_ROLE',
        `${person.name} has no benefit role, so there is no benefit QR to issue. Give them a role first.`,
      );
    }
    const [live] = await tx
      .select({ id: benefitCredential.id })
      .from(benefitCredential)
      .where(
        and(
          eq(benefitCredential.employeeId, person.id),
          isNull(benefitCredential.revokedAt),
          gt(benefitCredential.expiresAt, now),
        ),
      )
      .limit(1);
    if (live) {
      throw new AppError(
        409,
        'BENEFIT_CREDENTIAL_LIVE',
        `${person.name} already has a benefit QR in use. Revoke it before issuing another.`,
        { credentialId: live.id },
      );
    }
    // In the same transaction as the row, as the shift token's mint does: a QR
    // signed under a key no box can find would verify nowhere.
    await publishBenefitQrKey(tx, env);

    const id = newId();
    const exp = Math.floor(now.getTime() / 1000) + BENEFIT_CREDENTIAL_TTL_DAYS * 86_400;
    const expiresAt = new Date(exp * 1000);
    const code = encodeBenefitCredential(
      { employeeId: person.id, credentialId: id, exp },
      { kid: settings.kid, privateKeyPem: settings.privateKeyPem },
    );
    const [row] = await tx
      .insert(benefitCredential)
      .values({
        id,
        operatorId: actor.operatorId,
        employeeId: person.id,
        kid: settings.kid,
        version: BENEFIT_CREDENTIAL_VERSION,
        codeHash: benefitCredentialHash(code),
        issuedByAccountId: actor.accountId,
        issuedAt: now,
        expiresAt,
      })
      .returning();
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      action: 'benefit.credential_issue',
      entityType: 'benefit_credential',
      entityId: id,
      // Whose QR, under which key, until when. Never the code, its hash or
      // anything of the key but its public id: an audit row is read on a web
      // page, and a QR is a credential that comps an order.
      after: {
        id,
        employeeId: person.id,
        employeeName: person.name,
        kid: settings.kid,
        version: BENEFIT_CREDENTIAL_VERSION,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      requestId: ctx.requestId,
    });
    const [view] = await viewsOf(tx, [row!], now);
    // The route's whole answer, built inside the transaction: it is what an
    // idempotent retry is handed back, so it must be the answer, not part of it.
    return { credential: view! };
  });
}

// --- Print ------------------------------------------------------------------

export interface BenefitQrPayload {
  credentialId: string;
  employeeId: string;
  /** The dialog's title (prototype `BenefitQrDialog`: `operator.name`). */
  name: string;
  /** What the QR encodes and the line printed under it. */
  code: string;
  expiresAt: string;
}

/**
 * The printable payload behind the Staff Benefits QR dialog: the name over
 * the QR and the code it encodes.
 *
 * Re-derived rather than stored — the same claims under the same key are the
 * same QR, and the row's hash proves it — so the database holds nothing that
 * can be printed. A QR that is revoked, expired, or whose holder has left is
 * not printed; one signed under a key this deployment no longer holds cannot
 * be, and the administrator is told to issue a new one.
 */
export async function benefitCredentialQr(
  db: Db,
  operatorId: string,
  credentialId: string,
  env: Env,
  now: Date = new Date(),
): Promise<BenefitQrPayload> {
  const settings = requireSettings(env);
  const row = await loadCredential(db, operatorId, credentialId);
  const person = await loadEmployee(db, operatorId, row.employeeId);
  if (row.revokedAt) {
    throw new AppError(
      409,
      BENEFIT_CREDENTIAL_REFUSALS.REVOKED,
      BENEFIT_WORDS.revoked(person.name),
    );
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new AppError(409, BENEFIT_CREDENTIAL_REFUSALS.EXPIRED, BENEFIT_WORDS.expired);
  }
  if (person.archivedAt) {
    throw new AppError(
      409,
      BENEFIT_CREDENTIAL_REFUSALS.EMPLOYEE_LEFT,
      BENEFIT_WORDS.employeeLeft(person.name),
    );
  }
  if (row.kid !== settings.kid) {
    throw new AppError(
      409,
      'BENEFIT_QR_KEY_ROTATED',
      'This QR was signed with a key this deployment no longer holds, so it cannot be shown again. Revoke it and issue a new one.',
    );
  }
  const code = encodeBenefitCredential(
    {
      employeeId: row.employeeId,
      credentialId: row.id,
      exp: Math.floor(row.expiresAt.getTime() / 1000),
    },
    { kid: settings.kid, privateKeyPem: settings.privateKeyPem },
  );
  if (benefitCredentialHash(code) !== row.codeHash) {
    // Never expected: Ed25519 is deterministic. Refused rather than printed,
    // because a QR the row does not describe is one the cloud would refuse.
    throw new AppError(
      500,
      'BENEFIT_QR_MISMATCH',
      'This QR could not be reproduced. Revoke it and issue a new one.',
    );
  }
  return {
    credentialId: row.id,
    employeeId: row.employeeId,
    name: person.name,
    code,
    expiresAt: row.expiresAt.toISOString(),
  };
}

// --- Revoke -----------------------------------------------------------------

/**
 * Revoke a benefit QR. The cloud refuses it from this moment; every box from
 * its next pull of the `benefits` scope. Revoking one already revoked changes
 * nothing and records nothing (`changed: false`). Audited
 * `benefit.credential_revoke`, with no key material.
 */
export async function revokeBenefitCredential(
  db: Db,
  ctx: OpContext,
  actor: Actor,
  credentialId: string,
  now: Date = new Date(),
): Promise<{ changed: boolean; credential: BenefitCredentialView }> {
  return withTx(db, ctx, 'benefit.credential_revoke', async (tx) => {
    const row = await loadCredential(tx, actor.operatorId, credentialId);
    if (row.revokedAt) {
      const [view] = await viewsOf(tx, [row], now);
      return { changed: false, credential: view! };
    }
    const [updated] = await tx
      .update(benefitCredential)
      .set({ revokedAt: now, revokedByAccountId: actor.accountId })
      .where(and(eq(benefitCredential.id, row.id), isNull(benefitCredential.revokedAt)))
      .returning();
    if (!updated) {
      // Revoked by somebody else between the read and the write.
      const again = await loadCredential(tx, actor.operatorId, credentialId);
      const [view] = await viewsOf(tx, [again], now);
      return { changed: false, credential: view! };
    }
    const [person] = await tx
      .select({ name: employee.name })
      .from(employee)
      .where(eq(employee.id, row.employeeId))
      .limit(1);
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      action: 'benefit.credential_revoke',
      entityType: 'benefit_credential',
      entityId: row.id,
      before: { id: row.id, revokedAt: null },
      after: {
        id: row.id,
        employeeId: row.employeeId,
        employeeName: person?.name ?? null,
        kid: row.kid,
        revokedAt: now.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        // It was still good when revoked, or had already run out: the row says
        // which, so an expired card revoked for tidiness is not read as an
        // emergency.
        wasExpired: row.expiresAt.getTime() <= now.getTime(),
      },
      requestId: ctx.requestId,
    });
    const [view] = await viewsOf(tx, [updated], now);
    return { changed: true, credential: view! };
  });
}

// --- Resolve ----------------------------------------------------------------

export interface ResolvedBenefit {
  employeeId: string;
  name: string;
  credentialId: string;
  /** The trading day it was resolved for. */
  on: string;
  benefitRole: BenefitRole;
  hasOverride: boolean;
  /** The whole profile that applies today: what the till previews and applies. */
  profile: BenefitProfile;
  /** What a box may apply offline of it — the comp and the standing percent. */
  offline: Pick<BenefitScopeDay, 'comp' | 'standingDiscount' | 'onlineOnly'>;
  expiresAt: string;
}

/**
 * A scanned or typed benefit QR, resolved online: the person it names and
 * their effective profile for today (`POST /benefits/resolve`). The cloud's
 * half of what a box does offline (`checkBenefitOnBox` in `@oto/box-agent`),
 * with the cloud's own rows behind it — so a revocation is honoured here from
 * the moment it is made, without waiting for any pull.
 *
 * Refusals keep the prototype's words where it had them
 * (`BenefitScanModal.tsx:34-38`): anything that is not a QR this park issued is
 * `No staff benefit found for "<code>".` — a benefit QR echoed only up to its
 * signature (`benefitCodeShown`), since a refused QR may still be a live one —
 * and a person with nothing set up is `<name> has no benefit configured.`
 *
 * It applies nothing, uses up nothing and writes nothing — the quota is round
 * 3's, claimed inside the sale's own transaction, which is also where
 * `last_seen_at` is set.
 */
export async function resolveBenefitCredential(
  db: Exec,
  input: { operatorId: string; code: string; today: string; now?: Date },
): Promise<ResolvedBenefit> {
  const now = input.now ?? new Date();
  const code = input.code.trim();
  const notFound = (errorCode: string): AppError =>
    new AppError(404, errorCode, BENEFIT_WORDS.notFound(code));
  if (!hasBenefitCredentialHeader(code)) throw notFound(BENEFIT_CREDENTIAL_REFUSALS.NOT_FOUND);

  // Read inside the caller's transaction when there is one (a sale's commit):
  // the select is the same on either handle.
  const keys = await usableSigningKeys(db as Db, {
    operatorId: input.operatorId,
    purpose: BENEFIT_CREDENTIAL_KEY_PURPOSE,
    now,
  });
  const verified = verifyBenefitCredential(code, { keys, now });
  if (!verified.ok) {
    if (verified.refusal === BENEFIT_CREDENTIAL_REFUSALS.EXPIRED) {
      throw new AppError(409, verified.refusal, BENEFIT_WORDS.expired);
    }
    throw notFound(verified.refusal);
  }
  const claims = verified.credential;
  const [row] = await db
    .select()
    .from(benefitCredential)
    .where(
      and(
        eq(benefitCredential.id, claims.credentialId),
        eq(benefitCredential.operatorId, input.operatorId),
      ),
    )
    .limit(1);
  // Signed, and not one this park issued — another operator's, or a row the
  // code does not match. Either way it names nobody here.
  if (
    !row ||
    row.employeeId !== claims.employeeId ||
    row.codeHash !== benefitCredentialHash(code)
  ) {
    throw notFound(BENEFIT_CREDENTIAL_REFUSALS.NOT_FOUND);
  }
  const person = await loadEmployee(db, input.operatorId, row.employeeId);
  if (row.revokedAt) {
    throw new AppError(
      409,
      BENEFIT_CREDENTIAL_REFUSALS.REVOKED,
      BENEFIT_WORDS.revoked(person.name),
    );
  }
  if (person.archivedAt) {
    throw new AppError(
      409,
      BENEFIT_CREDENTIAL_REFUSALS.EMPLOYEE_LEFT,
      BENEFIT_WORDS.employeeLeft(person.name),
    );
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new AppError(409, BENEFIT_CREDENTIAL_REFUSALS.EXPIRED, BENEFIT_WORDS.expired);
  }
  const effective = await effectiveBenefitOn(db, input.operatorId, person.id, input.today);
  if (effective.isEmpty || !effective.benefitRole) {
    throw new AppError(
      409,
      BENEFIT_CREDENTIAL_REFUSALS.NOT_CONFIGURED,
      BENEFIT_WORDS.notConfigured(person.name),
    );
  }
  return {
    employeeId: person.id,
    name: person.name,
    credentialId: row.id,
    on: input.today,
    benefitRole: effective.benefitRole,
    hasOverride: effective.hasOverride,
    profile: effective.profile,
    offline: offlineBenefitFacts(effective.profile),
    expiresAt: row.expiresAt.toISOString(),
  };
}

// --- The `benefits` cache scope ----------------------------------------------

/**
 * Each person's offline facts by trading day, from `today` on: the runs of
 * days over which their comp, standing percent and online-only stages stay
 * the same. Every day a version of theirs or of any template starts or ends
 * is a boundary; adjacent runs that read the same are joined.
 */
function scopeDaysFrom(
  personRows: Parameters<typeof effectiveOn>[0],
  templates: Parameters<typeof effectiveOn>[1],
  today: string,
): BenefitScopeDay[] {
  const points = new Set<string>([today]);
  for (const r of [...personRows, ...templates]) {
    if (r.effectiveFrom > today) points.add(r.effectiveFrom);
    if (r.effectiveTo && r.effectiveTo > today) points.add(r.effectiveTo);
  }
  const sorted = [...points].sort();
  const out: BenefitScopeDay[] = [];
  sorted.forEach((from, i) => {
    const to = sorted[i + 1] ?? null;
    const { version, profile } = effectiveOn(personRows, templates, from);
    const role = version?.benefitRole ?? null;
    const facts = role
      ? offlineBenefitFacts(compact(profile))
      : { comp: false, standingDiscount: null, onlineOnly: [] };
    const day: BenefitScopeDay = { from, to, benefitRole: role, ...facts };
    const prev = out[out.length - 1];
    if (
      prev &&
      JSON.stringify({ ...prev, from: '', to: '' }) === JSON.stringify({ ...day, from: '', to: '' })
    ) {
      prev.to = to;
      return;
    }
    out.push(day);
  });
  return out;
}

/**
 * THE `benefits` SCOPE'S ONE ITEM (plan §7): what a box needs to check a
 * benefit QR with the link down, and nothing more.
 *
 *   - the `benefit_qr` public halves — `usableSigningKeys`, the same filter the
 *     config bundle applies, so a retired key leaves every box with its next
 *     pull;
 *   - the revocation list: every QR of the operator revoked and still inside
 *     its own expiry (past it, the QR refuses itself), and the people who have
 *     left and hold a QR not yet expired;
 *   - each current person with a benefit version from today on: their name
 *     and, by trading day, their benefit role, comp and standing percent, and
 *     WHETHER they have free items or credit — never the quotas, never the
 *     amounts, which stay in the cloud.
 *
 * Operator-wide, like the templates: a staff member's QR works at every
 * branch's F&B station.
 */
export async function benefitsCacheItem(
  db: Db,
  operatorId: string,
  branchId: string,
  now: Date = new Date(),
): Promise<BenefitScopeItem> {
  const today = await benefitToday(db, { operatorId, branchId }, now);
  const keys = (
    await usableSigningKeys(db, { operatorId, purpose: BENEFIT_CREDENTIAL_KEY_PURPOSE, now })
  ).map((k) => ({
    purpose: k.purpose,
    kid: k.kid,
    algorithm: k.algorithm,
    publicKey: k.publicKey,
  }));

  const revoked = await db
    .select({ id: benefitCredential.id })
    .from(benefitCredential)
    .where(
      and(
        eq(benefitCredential.operatorId, operatorId),
        isNotNull(benefitCredential.revokedAt),
        gt(benefitCredential.expiresAt, now),
      ),
    )
    .orderBy(asc(benefitCredential.id));

  const left = await db
    .selectDistinct({ id: employee.id })
    .from(benefitCredential)
    .innerJoin(employee, eq(employee.id, benefitCredential.employeeId))
    .where(
      and(
        eq(benefitCredential.operatorId, operatorId),
        isNotNull(employee.archivedAt),
        gt(benefitCredential.expiresAt, now),
      ),
    )
    .orderBy(asc(employee.id));

  const people = await db
    .select({ id: employee.id, name: employee.name })
    .from(employee)
    .where(and(eq(employee.operatorId, operatorId), isNull(employee.archivedAt)))
    .orderBy(asc(employee.name), asc(employee.id));
  const [rows, templates] = await Promise.all([
    profileRows(
      db,
      operatorId,
      people.map((p) => p.id),
    ),
    templateRows(db, operatorId),
  ]);
  const employees: BenefitScopeEmployee[] = [];
  for (const person of people) {
    const mine = rows.filter((r) => r.employeeId === person.id);
    if (mine.length === 0) continue;
    const days = scopeDaysFrom(mine, templates, today);
    // Nobody with no benefit on any day from today on: a QR of theirs (there
    // can be none issued, but one could predate a role being taken away) is
    // answered "no staff benefit found" on the box and "has no benefit
    // configured" by the cloud, both refusals.
    if (days.every((d) => d.benefitRole === null)) continue;
    employees.push({ employeeId: person.id, name: person.name, days });
  }

  const item = {
    keys,
    revokedCredentialIds: revoked.map((r) => r.id),
    revokedEmployeeIds: left.map((r) => r.id),
    employees,
  };
  return {
    ...item,
    version: createHash('sha256').update(JSON.stringify(item), 'utf8').digest('hex').slice(0, 16),
  };
}

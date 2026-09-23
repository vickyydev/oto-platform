import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { deviceCredential, station, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { limitPrincipal } from './throttle';
import { withTx, type OpContext } from './tx';
import type { BoothStationRow } from './booth';

/**
 * The credential a booth television holds (SCRUM-244).
 *
 * **What this closes, and what it deliberately does not reopen.** The six
 * `/booth/*` routes were open: on a deployment that runs the virtual box —
 * which staging is — `POST /booth/spin` was a URL a stranger could press, and
 * pressing it minted a voucher the park would honour. That is the same shape
 * as the flaw the intake recorded against the outgoing game (`POST /api/wins`
 * was open), and the note at the top of `routes/booth.ts` said as much while
 * leaving it standing.
 *
 * D15 is the rule that shaped it, and it stands: **nothing on a screen in a
 * shopping centre carries a bundled token.** A secret shipped inside
 * `apps/booth`'s build would be readable by anybody who opened the page, on
 * every booth at once, for as long as the build lived. A PAIRED credential is
 * a different object and breaks none of that:
 *
 *   - it is minted for ONE screen, by a member of staff who is signed in to
 *     the Console and holds `admin:booth:manage` at that booth's branch;
 *   - it is never in a build, a repository or a bundle — it is typed once, at
 *     the booth, and lives in that browser's `localStorage`;
 *   - it names one booth station, so a credential lifted off one television
 *     cannot press another booth's button;
 *   - it is revocable from the Console, and the screen falls back to asking
 *     for a new code on its next call.
 *
 * **Where it is weaker than a box's secret, stated rather than glossed.** A
 * browser's `localStorage` is readable by anybody who reaches the device's
 * developer tools, and a television in a mall is physically reachable. So this
 * is a credential that can be stolen off the glass, and the answer to that is
 * revocation plus the box's own limits (caps, stock, eligibility per draw),
 * not the credential. What it removes is the anonymous caller from the public
 * internet, which is the one that costs a voucher per request.
 *
 * ---
 *
 * **The code, and the arithmetic behind six digits.**
 *
 * Six digits is what the rest of the platform's one-time codes use
 * (`mintCode` in `services/auth.ts`), and the reason to keep it here rather
 * than reach for the ten-character claim-code alphabet is the device: a booth
 * television has a number pad on its sign-in panel and frequently no keyboard
 * at all, so an alphanumeric code is one a member of staff cannot type.
 *
 * What that costs: the redeem route takes a code and nothing else — the page
 * cannot name a booth, it does not know which one it is — so a guess is tried
 * against every outstanding code at once. Two things bound it:
 *
 *   - **at most one outstanding code per booth.** Minting revokes the booth's
 *     previous unredeemed code, so the live set is the number of booths
 *     somebody is pairing right now, which is normally zero and occasionally
 *     one. A guess has about `k / 1,000,000` of hitting, for that `k`;
 *   - **`PAIR_ATTEMPTS_MAX` wrong guesses per address per ten minutes**
 *     (`rl:booth-pair:<ip>`, counted only on failure, in Postgres so a deploy
 *     does not clear it). At a hundred, one address expects to need on the
 *     order of 10^4 ten-minute windows to land one hit on a single outstanding
 *     code — and the window is only open while a member of staff is standing
 *     at a booth pairing it. See the constant for why it is not ten.
 *
 * If a booth is ever paired unattended over a long window, the answer is a
 * shorter TTL or a booth-scoped redeem URL, not more digits on a number pad.
 */

/** Ten minutes: long enough to walk to the booth, short enough to matter. */
export const BOOTH_PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong codes tolerated from one address, and the window they are counted in.
 *
 * SCRUM-376 — RAISED FROM TEN, because of what an address turned out to be.
 * A pairing code NAMES NOTHING: the redeem route takes six digits and nothing
 * else, by design (the page cannot say which booth it is), so there is no
 * identity to count a wrong guess against and the address is all there is. The
 * measurement on 23 Sep 2026
 * (docs/qa/TRUST_PROXY_REWRITE_MEASUREMENT_2026-09-23.md) found the address is
 * never one caller: a television pairs through the booth site's own `/booth/*`
 * rewrite, so every screen in the estate arrives from Render's shared regional
 * proxy fleet and ten wrong digits anywhere stopped all of them pairing for
 * ten minutes — at exactly the moment a member of staff is standing at a booth
 * typing.
 *
 * What bounds a guess is unchanged and is stated in full above: at most one
 * outstanding code per booth, six digits, ten minutes, and the window only
 * open while somebody is pairing. A hundred wrong guesses per address per ten
 * minutes still leaves that on the order of 10^4 windows for one hit.
 */
const PAIR_ATTEMPTS_MAX = 100;
const PAIR_ATTEMPT_WINDOW_S = 600;

/**
 * One refusal for every way of not being a paired booth.
 *
 * Absent, malformed, unknown, expired, revoked, or paired to a DIFFERENT
 * booth than the one this process serves — all 401 `BOOTH_UNPAIRED` with the
 * same body. The page does one thing with any of them (ask staff to pair the
 * screen), and telling a caller which of the six it got is telling it whether
 * the secret it tried exists.
 */
export const boothUnpaired = (): AppError =>
  new AppError(401, 'BOOTH_UNPAIRED', 'This screen is not paired to a booth');

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Both halves are hex of one length, so only timing is left to leak. */
function hashesMatch(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Six digits, zero-padded — `000123` is a code, and a number is not. */
function mintPairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Spaces and dashes are how it was read out, not part of the code. */
function normalisePairingCode(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * The secret the screen keeps. 256 bits, never typed by anybody — a person
 * types the six digits, and this is what those digits are exchanged for.
 */
function mintDeviceSecret(): string {
  return randomBytes(32).toString('hex');
}

// --- What the Console sees --------------------------------------------------

/** One screen paired (or being paired) at a booth. Never a code, never a hash. */
export interface BoothScreenView {
  id: string;
  label: string | null;
  /** A code has been minted and nobody has redeemed it yet. */
  pairingOutstanding: boolean;
  pairingCodeExpiresAt: string | null;
  pairedAt: string | null;
  pairedByAccountId: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

function screenView(row: typeof deviceCredential.$inferSelect): BoothScreenView {
  return {
    id: row.id,
    label: row.label,
    pairingOutstanding: row.pairingCodeHash !== null,
    pairingCodeExpiresAt: row.pairingCodeExpiresAt?.toISOString() ?? null,
    pairedAt: row.pairedAt?.toISOString() ?? null,
    pairedByAccountId: row.pairedByAccountId,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: row.revokedReason,
  };
}

/**
 * Every screen this booth has had, newest first, revoked ones included.
 *
 * The revoked rows are kept and shown because "which screen was unpaired, and
 * when" is a question a manager asks after a television goes missing, and a
 * list that quietly dropped them could not answer it.
 */
export async function listBoothScreens(db: Db, stationId: string): Promise<BoothScreenView[]> {
  const rows = await db
    .select()
    .from(deviceCredential)
    .where(and(eq(deviceCredential.stationId, stationId), eq(deviceCredential.kind, 'booth')))
    .orderBy(desc(deviceCredential.createdAt));
  return rows.map(screenView);
}

/** One booth screen credential of this operator, or 404. */
export async function loadBoothScreen(
  db: Db,
  operatorId: string,
  stationId: string,
  credentialId: string,
): Promise<typeof deviceCredential.$inferSelect> {
  const [row] = await db
    .select()
    .from(deviceCredential)
    .where(
      and(
        eq(deviceCredential.id, credentialId),
        eq(deviceCredential.operatorId, operatorId),
        eq(deviceCredential.stationId, stationId),
        eq(deviceCredential.kind, 'booth'),
      ),
    )
    .limit(1);
  if (!row) throw new AppError(404, 'BOOTH_SCREEN_NOT_FOUND', 'No such screen on this booth');
  return row;
}

// --- Minting the code an administrator reads out ----------------------------

export interface MintedPairingCode {
  credential: BoothScreenView;
  /** Returned ONCE. Only its hash is stored. */
  pairingCode: string;
  expiresAt: string;
}

/**
 * Mint the six digits a member of staff types into a booth.
 *
 * **A second press replaces the first code rather than adding one.** Every
 * outstanding, unredeemed code for this booth is revoked in the same
 * transaction, so the booth has at most one live code at any moment. That is
 * the property the replay store cannot supply here: the answer carries a
 * credential, so the route declares `secretResponse` and the idempotency
 * plugin claims no key at all (`plugins/idempotency.ts`) — a retry genuinely
 * re-runs. What must therefore be true is that re-running is SAFE, and it is:
 * the code a manager is now looking at is the only one that works, and the one
 * they pressed past is dead rather than lying around for ten minutes.
 */
export async function mintBoothPairingCode(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  booth: BoothStationRow,
  input: { label?: string | null } = {},
): Promise<MintedPairingCode> {
  const id = newId();
  const code = mintPairingCode();
  const expiresAt = new Date(Date.now() + BOOTH_PAIRING_CODE_TTL_MS);

  const created = await withTx(db, ctx, 'booth.pairing_code_mint', async (tx) => {
    const superseded = await tx
      .update(deviceCredential)
      .set({
        revokedAt: new Date(),
        revokedReason: 'superseded by a newer pairing code',
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
      })
      .where(
        and(
          eq(deviceCredential.stationId, booth.stationId),
          eq(deviceCredential.kind, 'booth'),
          isNull(deviceCredential.revokedAt),
          isNull(deviceCredential.secretHash),
          isNotNull(deviceCredential.pairingCodeHash),
        ),
      )
      .returning({ id: deviceCredential.id });

    await tx.insert(deviceCredential).values({
      id,
      operatorId: booth.operatorId,
      branchId: booth.branchId,
      kind: 'booth',
      stationId: booth.stationId,
      label: input.label ?? null,
      pairingCodeHash: sha256Hex(code),
      pairingCodeExpiresAt: expiresAt,
      /**
       * Set at the MINT, not at the redemption, and that is the honest place
       * for it: whoever types the code into a television is anonymous by
       * design — there is no account at a booth — so the person answerable for
       * a screen being allowed to press the button is the administrator who
       * issued the digits. `paired_at` still marks when a screen actually
       * took them up, so the two answer different questions and a row where
       * this is set and that is null reads correctly: authorised, not yet
       * used.
       */
      pairedByAccountId: actor.accountId,
    });
    const [row] = await tx
      .select()
      .from(deviceCredential)
      .where(eq(deviceCredential.id, id))
      .limit(1);

    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: booth.operatorId,
      branchId: booth.branchId,
      action: 'booth.pairing_code_mint',
      entityType: 'device_credential',
      entityId: id,
      // The expiry, the booth and what it superseded. Never the code, and
      // never a prefix or a length of it.
      after: {
        stationId: booth.stationId,
        label: input.label ?? null,
        expiresAt: expiresAt.toISOString(),
        supersededCredentialIds: superseded.map((r) => r.id),
      },
      requestId: ctx.requestId,
    });
    return { credential: screenView(row!) };
  });

  return { ...created, pairingCode: code, expiresAt: expiresAt.toISOString() };
}

// --- Redeeming it, at the booth ---------------------------------------------

export interface PairedDevice {
  /** The long secret the screen keeps. Returned once and stored only as a hash. */
  deviceSecret: string;
  credentialId: string;
  stationId: string;
}

/**
 * Exchange the six digits for the screen's own credential.
 *
 * Open, because the caller by definition holds nothing yet — that is what
 * "not paired" means. The code IS the credential for this one call, exactly
 * as a box's claim code is on `POST /box/v1/register`, and it is fenced the
 * same way: single use, short-lived, and counted per address on failure.
 *
 * **Single use is enforced by the UPDATE's own predicate**, not by a read
 * followed by a write. `pairing_code_hash = <hash>` is in the WHERE clause of
 * the statement that nulls it, and `device_credential_pairing_unique` makes
 * that hash name at most one row — so two screens racing on the same code
 * produce one update of one row and one update of none, and the loser is
 * refused. A read-then-write would hand both of them a working credential.
 */
export async function redeemBoothPairingCode(
  db: Db,
  ctx: OpContext,
  input: { code: string },
  who: { ip: string; log?: FastifyBaseLogger },
): Promise<PairedDevice> {
  const code = normalisePairingCode(input.code);

  /**
   * Counted on failure only, so a booth being paired never approaches it and
   * somebody working through six-digit codes does. It also bounds the audit
   * rows below: past the ceiling nothing reaches them.
   */
  const deny = async (reason: 'malformed' | 'unknown' | 'raced'): Promise<never> => {
    who.log?.warn({ reason, ip: who.ip }, 'booth pairing code refused');
    await limitPrincipal(db, `booth-pair:${who.ip}`, PAIR_ATTEMPTS_MAX, PAIR_ATTEMPT_WINDOW_S);
    throw boothUnpaired();
  };

  if (!/^\d{6}$/.test(code)) return deny('malformed');

  const hash = sha256Hex(code);
  const [candidate] = await db
    .select()
    .from(deviceCredential)
    .where(and(eq(deviceCredential.pairingCodeHash, hash), eq(deviceCredential.kind, 'booth')))
    .limit(1);
  if (
    !candidate ||
    candidate.revokedAt !== null ||
    candidate.stationId === null ||
    candidate.pairingCodeExpiresAt === null ||
    candidate.pairingCodeExpiresAt.getTime() <= Date.now()
  ) {
    return deny('unknown');
  }

  const secret = mintDeviceSecret();
  const claimed = await withTx(db, ctx, 'booth.pair', async (tx) => {
    /**
     * The code is spent and the secret set in one statement, conditional on
     * the code still being there. A second redemption of the same code
     * updates no rows and is refused below.
     */
    const [row] = await tx
      .update(deviceCredential)
      .set({
        secretHash: sha256Hex(secret),
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
        pairedAt: new Date(),
        lastSeenAt: new Date(),
      })
      .where(
        and(
          eq(deviceCredential.id, candidate.id),
          eq(deviceCredential.pairingCodeHash, hash),
          isNull(deviceCredential.revokedAt),
        ),
      )
      .returning({ id: deviceCredential.id, stationId: deviceCredential.stationId });
    if (!row) return null;

    await audit.record(tx, {
      // Nobody is signed in at a booth: the actor is the code, and who issued
      // it is on the mint row this one points back to.
      actorAccountId: null,
      operatorId: candidate.operatorId,
      branchId: candidate.branchId,
      action: 'booth.pair',
      entityType: 'device_credential',
      entityId: candidate.id,
      after: { stationId: candidate.stationId, ip: who.ip },
      requestId: ctx.requestId,
    });
    return row;
  });

  if (!claimed) return deny('raced');
  return { deviceSecret: secret, credentialId: claimed.id, stationId: claimed.stationId! };
}

// --- Authenticating a paired screen -----------------------------------------

/** The screen behind a `/booth/*` call, for the route that declared one. */
export interface BoothDeviceAuth {
  credentialId: string;
  stationId: string;
  operatorId: string;
  branchId: string;
}

/**
 * Who is calling `/booth/*`, from the header the page sends.
 *
 * Not `Authorization: Bearer`: a booth page is served same-origin behind a
 * rewrite and sends `credentials: 'omit'`, and its own header keeps the two
 * kinds of caller visibly apart in a log and in a proxy rule. The name is
 * `@oto/shared`'s (`BOOTH_DEVICE_HEADER`) so the page and this cannot drift.
 *
 * The lookup is one indexed read on `device_credential_secret_unique`. There
 * is no id in the header to make it a primary-key read, deliberately: an id
 * beside the secret is one more thing kept in a browser on a television, and
 * it buys nothing here because the unique partial index on the hash is exactly
 * as good.
 *
 * **`last_seen_at` is written on a hit, and it is written outside any
 * transaction the request opens.** It is a fact about the device rather than
 * about the operation, so a spin that rolls back must not un-see the screen.
 */
export async function authenticateBoothDevice(
  db: Db,
  presented: string | undefined,
  who: { ip: string; log?: FastifyBaseLogger },
): Promise<BoothDeviceAuth> {
  const secret = typeof presented === 'string' ? presented.trim() : '';
  // Shaped like a minted secret before a query runs: anything else is somebody
  // probing, and probing should not cost a read.
  if (!/^[0-9a-f]{64}$/.test(secret)) throw boothUnpaired();

  const hash = sha256Hex(secret);
  const [row] = await db
    .select({
      id: deviceCredential.id,
      secretHash: deviceCredential.secretHash,
      stationId: deviceCredential.stationId,
      operatorId: deviceCredential.operatorId,
      branchId: deviceCredential.branchId,
      revokedAt: deviceCredential.revokedAt,
      /** A booth taken out of service takes its screens with it. */
      stationArchivedAt: station.archivedAt,
    })
    .from(deviceCredential)
    .innerJoin(station, eq(deviceCredential.stationId, station.id))
    .where(and(eq(deviceCredential.secretHash, hash), eq(deviceCredential.kind, 'booth')))
    .limit(1);
  if (
    !row ||
    row.revokedAt !== null ||
    row.stationId === null ||
    row.stationArchivedAt !== null ||
    !hashesMatch(row.secretHash, hash)
  ) {
    who.log?.warn({ ip: who.ip }, 'booth device credential refused');
    throw boothUnpaired();
  }

  await db
    .update(deviceCredential)
    .set({ lastSeenAt: new Date() })
    .where(eq(deviceCredential.id, row.id));

  return {
    credentialId: row.id,
    stationId: row.stationId,
    operatorId: row.operatorId,
    branchId: row.branchId,
  };
}

// --- Taking a screen off a booth --------------------------------------------

/**
 * Unpair a screen.
 *
 * The row stays, with who revoked it and why — "which television was unpaired
 * and when" is the question this exists to answer. What goes is everything
 * that could still authenticate: the live secret and any code nobody redeemed.
 * The screen itself finds out on its next call, which is within five seconds:
 * the page polls status on a timer and falls back to the pairing prompt on a
 * 401.
 */
export async function revokeBoothScreen(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: typeof deviceCredential.$inferSelect,
  reason: string | null,
): Promise<BoothScreenView> {
  if (before.revokedAt) {
    throw new AppError(409, 'BOOTH_SCREEN_ALREADY_REVOKED', 'That screen is already unpaired');
  }
  return withTx(db, ctx, 'booth.screen_revoke', async (tx) => {
    const [after] = await tx
      .update(deviceCredential)
      .set({
        revokedAt: new Date(),
        revokedReason: reason,
        secretHash: null,
        pairingCodeHash: null,
        pairingCodeExpiresAt: null,
      })
      .where(eq(deviceCredential.id, before.id))
      .returning();
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: before.operatorId,
      branchId: before.branchId,
      action: 'booth.screen_revoke',
      entityType: 'device_credential',
      entityId: before.id,
      before: screenView(before),
      after: screenView(after!),
      requestId: ctx.requestId,
    });
    return screenView(after!);
  });
}

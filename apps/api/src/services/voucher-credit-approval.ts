import { verify } from '@node-rs/argon2';
import type { FastifyBaseLogger } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { account, voucherDefinition, type Db } from '@oto/db';
import { VOUCHER_CREDIT_MESSAGES, normalizePhone, type VoucherCreditApproval } from '@oto/shared';
import { AppError } from '../lib/errors';
import { phoneHash } from '../lib/scrub';
import { audit } from './audit';
import { equalizeVerifyCost, throttleCheck, throttleClear, throttleFail } from './auth';
import { hasPermission, resolveEffectivePermissions, type EffectivePermission } from './permissions';
import type { Exec } from './tx';

/**
 * SCRUM-482 — A CREDIT VOUCHER IS A MANAGER'S (the owner's rulings of 18 and
 * 19 November: "Managers only"; reception asks and a manager approves "on the
 * same till, on the spot"; a manager issues one "alone, named on the record";
 * "credit vouchers only").
 *
 * A credit voucher is a voucher type of kind `wallet_credit`: rung up at ฿0,
 * it loads its amount onto a new wallet when that sale closes. Every other
 * kind is issued at the till exactly as before, with `pos:print:voucher`.
 *
 *   - An account holding `pos:voucher:issue_credit` at the till's branch (a
 *     branch manager; the administrators through `ALL`) issues one alone. It
 *     is recorded as theirs, with no approver.
 *   - Anyone else is refused `VOUCHER_CREDIT_NEEDS_MANAGER` unless the issue
 *     carries a manager's approval: that manager's own phone number and
 *     password, typed on the same till. Nobody is signed in or out; the
 *     receptionist stays on the till. The platform checks, in this order: a
 *     phone that is not the asker's own; the per-phone and per-address throttle
 *     sign-in uses (the SAME buckets, so guesses here and at the lock screen
 *     share one budget); an active account with a password, verified with
 *     argon2 — every refusal before the real verification spends a dummy one,
 *     so the answer takes the same time whichever it was; then, only once the
 *     password is proven, an account not holding a temporary password and the
 *     permission at this branch. The approver is stored on the voucher
 *     (`approved_by_account_id`) and in its `voucher.issue` audit row.
 *   - The shared fixed code of a credit type is refused at the till to the
 *     same accounts (`findForRedemption` in `vouchers.ts`), and a credit type
 *     cannot be saved with a fixed code (`voucher-definitions.ts`).
 *
 * THE PASSWORD. It is read from the request body for this one check and goes
 * nowhere else: not into a log line (the refusal logs carry a reason, the
 * phone's hash and an account id), not into an audit row, not into an error
 * (each refusal is a fixed sentence), not into the idempotency store (the
 * route declares `credentialInBody`, so the request hash is taken with the
 * password replaced — `plugins/idempotency.ts`), and not into the issue's
 * service call, which never receives the approval. The till clears its field
 * once the platform has answered. `s482-credit-voucher-review.test.ts` pins it.
 */

export const CREDIT_VOUCHER_KIND = 'wallet_credit';

/** Does this account issue credit vouchers alone at this branch? */
export function mayIssueCredit(
  effective: EffectivePermission[],
  operatorId: string,
  branchId: string,
): boolean {
  return hasPermission(effective, 'pos:voucher:issue_credit', { operatorId, branchId });
}

/** The refusals, by code and in the counter's words (`VOUCHER_CREDIT_MESSAGES`). 403, never 401: a 401 signs the till out. */
export const creditVoucherErrors = {
  needsManager: () => new AppError(403, 'VOUCHER_CREDIT_NEEDS_MANAGER', VOUCHER_CREDIT_MESSAGES.needsManager),
  approvalIncorrect: () =>
    new AppError(403, 'VOUCHER_APPROVAL_INCORRECT', VOUCHER_CREDIT_MESSAGES.approvalIncorrect),
  approverIsAsker: () => new AppError(403, 'VOUCHER_APPROVER_IS_ASKER', VOUCHER_CREDIT_MESSAGES.approverIsAsker),
  approverNotManager: () =>
    new AppError(403, 'VOUCHER_APPROVER_NOT_MANAGER', VOUCHER_CREDIT_MESSAGES.approverNotManager),
  approverMustChangePassword: () =>
    new AppError(
      403,
      'VOUCHER_APPROVER_MUST_CHANGE_PASSWORD',
      VOUCHER_CREDIT_MESSAGES.approverMustChangePassword,
    ),
};

/** The kind of one of this operator's voucher types, or null when there is no such type. */
export async function definitionKindOf(
  db: Exec,
  operatorId: string,
  definitionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ kind: voucherDefinition.kind })
    .from(voucherDefinition)
    .where(and(eq(voucherDefinition.id, definitionId), eq(voucherDefinition.operatorId, operatorId)))
    .limit(1);
  return row?.kind ?? null;
}

/** The audit reason for an approver refused for their account's status rather than their password. */
const STATUS_REASON: Record<string, string> = {
  invited: 'setup_required',
  inactive: 'account_inactive',
};

export interface CreditApprovalRequest {
  operatorId: string;
  branchId: string;
  stationId: string;
  definitionId: string;
  /** The person at the till. */
  askerAccountId: string;
  approval: VoucherCreditApproval;
  ip: string;
  maxFailures: number;
  maxFailuresPerAddress: number;
  cooldownSeconds: number;
  requestId?: string;
  log?: FastifyBaseLogger;
}

/**
 * Check a manager's approval typed on the till, and answer the approver's
 * account id — or refuse. Runs on the pool, never inside the issue's
 * transaction: a refused attempt is counted and recorded whatever happens to
 * the issue, exactly as a refused sign-in is (`signIn` in `auth.ts`).
 */
export async function verifyCreditApproval(db: Db, req: CreditApprovalRequest): Promise<string> {
  const { password } = req.approval;
  const phone = normalizePhone(req.approval.phone);
  // Not a phone number at all: there is no account and no bucket to count it
  // against, and nothing about anybody to give away. Same sentence.
  if (!phone) throw creditVoucherErrors.approvalIncorrect();
  const keys = { phone: `phone:${phone}`, address: `ip:${req.ip}` };
  await throttleCheck(db, [keys.phone, keys.address]);

  const [approver] = await db
    .select()
    .from(account)
    .where(and(eq(account.phone, phone), eq(account.operatorId, req.operatorId)))
    .limit(1);

  /**
   * Written on the pool, and swallowed on error, as a refused sign-in's are:
   * a refusal that cannot be written down is still a refusal. The phone is
   * its hash; the password is never here.
   */
  const record = async (reason: string, lockedBuckets: string[] = []): Promise<void> => {
    req.log?.warn(
      {
        reason,
        phoneHash: phoneHash(phone),
        approverAccountId: approver?.id ?? null,
        reqId: req.requestId,
      },
      'credit voucher approval refused',
    );
    try {
      await audit.record(db, {
        actorAccountId: req.askerAccountId,
        operatorId: req.operatorId,
        branchId: req.branchId,
        action: 'voucher.credit_approval_refused',
        entityType: 'voucher_definition',
        entityId: req.definitionId,
        after: {
          reason,
          approverAccountId: approver?.id ?? null,
          phoneHash: phoneHash(phone),
          stationId: req.stationId,
        },
        requestId: req.requestId ?? null,
      });
      for (const bucket of lockedBuckets) {
        await audit.record(db, {
          actorAccountId: req.askerAccountId,
          operatorId: req.operatorId,
          branchId: req.branchId,
          action: 'auth.locked_out',
          entityType: 'account',
          entityId: approver?.id ?? phoneHash(phone),
          // The bucket's kind, never its key: the key holds a phone or an address.
          after: { bucket: bucket.split(':')[0], cooldownSeconds: req.cooldownSeconds },
          requestId: req.requestId ?? null,
        });
      }
    } catch (err) {
      req.log?.error(
        { code: (err as { code?: string }).code, reqId: req.requestId },
        'credit voucher approval refusal could not be recorded',
      );
    }
  };

  // The person at the till typed their own phone: refused before any password
  // work and counted against nobody — it tells them only what they know.
  if (approver && approver.id === req.askerAccountId) {
    await record('approver_is_asker');
    throw creditVoucherErrors.approverIsAsker();
  }

  let verifySpent = false;
  const fail = async (reason: string): Promise<never> => {
    // The verification this refusal skipped, paid here (SCRUM-325's rule).
    if (!verifySpent) await equalizeVerifyCost(password);
    const lockedBuckets = [
      ...(await throttleFail(db, [keys.phone], req.maxFailures, req.cooldownSeconds)),
      ...(await throttleFail(db, [keys.address], req.maxFailuresPerAddress, req.cooldownSeconds)),
    ];
    await record(reason, lockedBuckets);
    throw creditVoucherErrors.approvalIncorrect();
  };

  if (!approver) return fail('no_account');
  if (approver.status !== 'active') return fail(STATUS_REASON[approver.status] ?? `status_${approver.status}`);
  if (!approver.passwordHash) return fail('no_password');
  verifySpent = true;
  if (!(await verify(approver.passwordHash, password))) return fail('bad_password');

  // The password is proven: the counters go, as a good sign-in clears them.
  await throttleClear(db, [keys.phone, keys.address]);
  if (approver.mustChangePassword) {
    await record('must_change_password');
    throw creditVoucherErrors.approverMustChangePassword();
  }
  if (!mayIssueCredit(await resolveEffectivePermissions(db, approver.id), req.operatorId, req.branchId)) {
    await record('not_permitted');
    throw creditVoucherErrors.approverNotManager();
  }
  return approver.id;
}

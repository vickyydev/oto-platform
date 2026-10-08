import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { account, appTenantAnchors, benefitCredential, branch, employee, opsRun, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { recordRun } from './ops';
import { listAppEmployees, otoAppEmployeesInstalled, type AppEmployee } from './otoapp-employees';
import { withTx, type Exec, type Tx } from './tx';

/**
 * THE EMPLOYEE COPY — the OTO App's staff into `core.employee` (S2-17b round 2;
 * PLAN section 5, hazards H2-H7 and H23-H25; conflict C13).
 *
 * The OTO App is the employee master. Every fifteen minutes, and at once from
 * Health's "Copy the OTO App's staff now", this reads the app's employee view
 * through the read-only repository and keeps the platform's copy in step:
 * `source = 'otoapp'`, `external_id` = the app's id, read-only everywhere else
 * on the platform (`PATCH /me` refuses the four mirrored fields). What it
 * does, per app park group (tenant):
 *
 *  - **Whose.** The park group's operator is the one its mapped branches belong
 *    to — the anchor rule of `mapCoreBranchIntoApp`, through
 *    `appTenantAnchors`. A park group with no anchor, or anchored to two
 *    operators, is skipped, named in the run, and raised: its people reach no
 *    operator, and none of its copies is archived for it (H4). An unreadable
 *    park group is not an empty one.
 *  - **Create** a copy for an employee the platform has never seen, unless the
 *    app says they have LEFT (a leaver is never copied).
 *  - **Adopt** instead, when the app links the employee to a user whose
 *    platform account already has a platform `core.employee` (no
 *    `external_id`): that row becomes the copy — same id, so the person's
 *    benefit profile, overrides and cards stay (H2). A copy that already
 *    exists is never merged with such a row: the case is raised with both ids.
 *  - **Update** the four mirrored fields and the branch when the app changed
 *    them; nothing when it did not, so a second run writes nothing.
 *  - **Archive** when the app says LEFT, or the employee is gone from the app.
 *    Archiving revokes the person's live benefit cards (a system
 *    `benefit.credential_revoke`), so a scan is refused and a rehire is given
 *    a new card (H6).
 *  - **Restore** on a rehire: the same app id active again un-archives the
 *    SAME row, so the person keeps one id and their history; the old cards
 *    stay revoked (H25).
 *  - **The account link (H23).** The view names the platform account the
 *    app's own rule links to the employee. It counts only when that account
 *    belongs to the operator the park group is anchored to — the app's email
 *    match crosses park groups — and any other is treated as no link and
 *    raised. An account of the operator with no employee record is given this
 *    copy (`core.account.employee_id`, audited `account.employee_link`, in the
 *    same transaction as the copy). One already pointing at a different
 *    employee row keeps it, and the case is raised.
 *
 * Raised means an `ops_run` of kind `integration` named
 * `otoapp:employee.sync`, failed, with ids and no names: on the Failures page
 * for an administrator, one group per kind of case. They are facts about the
 * data as it stands, so they are raised by every run that finds them.
 *
 * Every write is audited with a system actor (`actorAccountId` null) and the
 * app's id in the record. One transaction per operator, under an advisory lock
 * on that operator's copy, so "Run now" pressed beside the schedule waits for
 * it rather than copying the same person twice.
 */

export const OTOAPP_EMPLOYEE_SYNC_JOB = 'job:otoapp.employee_sync';
/** The integration record every raised case is filed under. */
export const OTOAPP_EMPLOYEE_SYNC_RUN = 'otoapp:employee.sync';

/**
 * The advisory lock namespace for one operator's copy. Ours, beside the
 * others in this api (`0x070a` the job runner … `0x070f` a booth's roster).
 */
const EMPLOYEE_SYNC_LOCK_NAMESPACE = 0x0710;

/** Why a case was raised: the `error_code` its Failures group is keyed by. */
export const EMPLOYEE_SYNC_CASES = {
  /** A park group no operator's branch is mapped into. */
  NO_ANCHOR: 'OTOAPP_TENANT_NO_ANCHOR',
  /** A park group mapped into two operators' branches. */
  TWO_OPERATORS: 'OTOAPP_TENANT_TWO_OPERATORS',
  /** The app links the employee to an account of another operator, or to none that exists. */
  FOREIGN_ACCOUNT: 'OTOAPP_FOREIGN_ACCOUNT_LINK',
  /** The employee has a copy, and its account points at a different platform row: not merged (H2). */
  ADOPTION_CONFLICT: 'OTOAPP_ADOPTION_CONFLICT',
  /** The account already points at a different employee row (H23). */
  ACCOUNT_CLASH: 'OTOAPP_ACCOUNT_EMPLOYEE_CLASH',
  /** The view answered no employee at all while copies are live: nothing archived. */
  EMPTY_SOURCE: 'OTOAPP_EMPLOYEES_EMPTY',
  /** A benefit scan named an employee the platform does not have (benefits H17). */
  UNKNOWN_EMPLOYEE: 'OTOAPP_EMPLOYEE_UNKNOWN',
} as const;
export type EmployeeSyncCase = (typeof EMPLOYEE_SYNC_CASES)[keyof typeof EMPLOYEE_SYNC_CASES];

const CASE_WORDS: Record<EmployeeSyncCase, string> = {
  OTOAPP_TENANT_NO_ANCHOR:
    'An OTO App park group is mapped to no branch of any operator, so its staff were not copied. Join one of its branches on the Console (Branches > OTO App).',
  OTOAPP_TENANT_TWO_OPERATORS:
    'An OTO App park group is mapped to branches of two operators, so its staff were not copied to either. Settle which operator it belongs to.',
  OTOAPP_FOREIGN_ACCOUNT_LINK:
    "The OTO App links this employee to a platform account outside the operator its park group belongs to. Copied with no account link; correct the person's login or email in the OTO App.",
  OTOAPP_ADOPTION_CONFLICT:
    "This employee already has a copied record, and their account points at a different platform employee record. The two were not merged; an administrator decides which is the person's.",
  OTOAPP_ACCOUNT_EMPLOYEE_CLASH:
    "The OTO App links this employee to an account that already belongs to a different employee record. The account was left as it is; an administrator decides which is the person's.",
  OTOAPP_EMPLOYEES_EMPTY:
    'The OTO App answered no employees at all while copied staff are on record, so nobody was archived. Check the OTO App before the next run.',
  OTOAPP_EMPLOYEE_UNKNOWN:
    'A staff benefit QR named an employee the platform does not have. They may not have been copied from the OTO App yet.',
};

/** One case to raise, gathered during a run and filed after its transactions. */
export interface EmployeeSyncRaise {
  case: EmployeeSyncCase;
  operatorId: string | null;
  detail: Record<string, unknown>;
}

/**
 * File one case on the Failures page. On the pool, never inside a
 * transaction that could still roll back: the record of a case outlives the
 * attempt that found it. A failure to file is logged by the caller, never
 * allowed to replace what it was filing.
 */
export async function raiseEmployeeSync(db: Exec, raise: EmployeeSyncRaise): Promise<void> {
  const now = new Date();
  // The run and its `ops_last` line together or not at all.
  await withTx(
    db,
    { actorAccountId: null, operatorId: raise.operatorId },
    'otoapp.employee_sync_raise',
    (tx) =>
      recordRun(tx, {
        kind: 'integration',
        name: OTOAPP_EMPLOYEE_SYNC_RUN,
        outcome: 'failed',
        startedAt: now,
        finishedAt: now,
        operatorId: raise.operatorId,
        detail: { case: raise.case, ...raise.detail },
        error: new AppError(409, raise.case, CASE_WORDS[raise.case]),
      }),
  );
}

export interface EmployeeSyncSummary extends Record<string, unknown> {
  /** False on a database with no employee seam: nothing was read or written. */
  installed: boolean;
  /** App employees read. */
  employees: number;
  /** Park groups read, and those skipped with why. */
  tenants: number;
  skipped: Array<{ tenantId: string; reason: 'no_anchor' | 'two_operators'; employees: number }>;
  operators: number;
  created: number;
  adopted: number;
  updated: number;
  archived: number;
  restored: number;
  accountsLinked: number;
  cardsRevoked: number;
  raised: number;
}

const emptySummary = (installed: boolean): EmployeeSyncSummary => ({
  installed,
  employees: 0,
  tenants: 0,
  skipped: [],
  operators: 0,
  created: 0,
  adopted: 0,
  updated: 0,
  archived: 0,
  restored: 0,
  accountsLinked: 0,
  cardsRevoked: 0,
  raised: 0,
});

type EmployeeRow = typeof employee.$inferSelect;

/** The fields the copy owns on a `core.employee` row. */
interface MirroredFields {
  name: string;
  nickname: string | null;
  phone: string | null;
  email: string | null;
  branchId: string | null;
}

const fieldsOf = (r: Pick<EmployeeRow, keyof MirroredFields>): MirroredFields => ({
  name: r.name,
  nickname: r.nickname,
  phone: r.phone,
  email: r.email,
  branchId: r.branchId,
});

const sameFields = (a: MirroredFields, b: MirroredFields): boolean =>
  a.name === b.name &&
  a.nickname === b.nickname &&
  a.phone === b.phone &&
  a.email === b.email &&
  a.branchId === b.branchId;

/**
 * Run the copy once, for every park group. What `job:otoapp.employee_sync`
 * runs; its answer is the run's detail — counts and ids, never a name.
 */
export async function runOtoAppEmployeeSync(
  db: Db,
  now: Date = new Date(),
): Promise<EmployeeSyncSummary> {
  if (!(await otoAppEmployeesInstalled(db))) return emptySummary(false);
  const summary = emptySummary(true);
  const raises: EmployeeSyncRaise[] = [];

  const rows = await listAppEmployees(db);
  const anchors = await appTenantAnchors(db);
  summary.employees = rows.length;

  const byTenant = new Map<string, AppEmployee[]>();
  for (const r of rows) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);
  summary.tenants = byTenant.size;

  /** App ids whose park group was not read this run: their copies are left exactly as they are. */
  const unread = new Set<string>();
  const byOperator = new Map<string, AppEmployee[]>();
  for (const [tenantId, list] of [...byTenant].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const operators = anchors.get(tenantId) ?? [];
    if (operators.length !== 1) {
      const reason = operators.length === 0 ? 'no_anchor' : 'two_operators';
      summary.skipped.push({ tenantId, reason, employees: list.length });
      for (const r of list) unread.add(r.id);
      raises.push({
        case: reason === 'no_anchor' ? EMPLOYEE_SYNC_CASES.NO_ANCHOR : EMPLOYEE_SYNC_CASES.TWO_OPERATORS,
        operatorId: null,
        detail: { tenantId, employees: list.length, operatorIds: operators },
      });
      continue;
    }
    const operatorId = operators[0]!;
    byOperator.set(operatorId, [...(byOperator.get(operatorId) ?? []), ...list]);
  }

  // Every operator with something to copy, and every operator holding live
  // copies (whose people may all be gone from the app).
  const holding = await db
    .selectDistinct({ operatorId: employee.operatorId })
    .from(employee)
    .where(and(eq(employee.source, 'otoapp'), isNull(employee.archivedAt)));
  const operators = [...new Set([...byOperator.keys(), ...holding.map((h) => h.operatorId)])].sort();
  summary.operators = operators.length;

  /**
   * An app that answers nobody at all while copies are live is far more likely
   * to be an app mid-restore than a park whose every member of staff left in
   * the same quarter of an hour. Archiving on that would revoke every staff
   * card in the estate; it is raised instead, and nothing is archived as gone.
   */
  const emptySource = rows.length === 0 && holding.length > 0;
  if (emptySource) {
    raises.push({
      case: EMPLOYEE_SYNC_CASES.EMPTY_SOURCE,
      operatorId: null,
      detail: { operatorsHoldingCopies: holding.length },
    });
  }

  for (const operatorId of operators) {
    const counts = await syncOperator(db, {
      operatorId,
      rows: byOperator.get(operatorId) ?? [],
      unread,
      archiveGone: !emptySource,
      now,
      raises,
    });
    summary.created += counts.created;
    summary.adopted += counts.adopted;
    summary.updated += counts.updated;
    summary.archived += counts.archived;
    summary.restored += counts.restored;
    summary.accountsLinked += counts.accountsLinked;
    summary.cardsRevoked += counts.cardsRevoked;
  }

  for (const raise of raises) await raiseEmployeeSync(db, raise);
  summary.raised = raises.length;
  return summary;
}

interface OperatorCounts {
  created: number;
  adopted: number;
  updated: number;
  archived: number;
  restored: number;
  accountsLinked: number;
  cardsRevoked: number;
}

/** One operator's copy, in one transaction under its lock. */
async function syncOperator(
  db: Db,
  input: {
    operatorId: string;
    rows: AppEmployee[];
    unread: ReadonlySet<string>;
    archiveGone: boolean;
    now: Date;
    raises: EmployeeSyncRaise[];
  },
): Promise<OperatorCounts> {
  const { operatorId, now } = input;
  const counts: OperatorCounts = {
    created: 0,
    adopted: 0,
    updated: 0,
    archived: 0,
    restored: 0,
    accountsLinked: 0,
    cardsRevoked: 0,
  };
  // Raised only once the transaction commits: a rolled-back run raised nothing.
  const pending: EmployeeSyncRaise[] = [];
  const raise = (c: EmployeeSyncCase, detail: Record<string, unknown>) =>
    pending.push({ case: c, operatorId, detail });

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${EMPLOYEE_SYNC_LOCK_NAMESPACE}::int4, hashtext(${`employee_sync:${operatorId}`})::int4)`,
    );

    const copies = await tx
      .select()
      .from(employee)
      .where(
        and(
          eq(employee.operatorId, operatorId),
          eq(employee.source, 'otoapp'),
          isNotNull(employee.externalId),
        ),
      );
    const live = new Map<string, EmployeeRow>();
    /** Archived copies by app id, the most recently archived first. */
    const archived = new Map<string, EmployeeRow[]>();
    for (const c of copies) {
      if (c.archivedAt === null) live.set(c.externalId!, c);
      else archived.set(c.externalId!, [...(archived.get(c.externalId!) ?? []), c]);
    }
    for (const list of archived.values()) {
      list.sort((a, b) => b.archivedAt!.getTime() - a.archivedAt!.getTime());
    }

    const ourBranches = new Set(
      (
        await tx
          .select({ id: branch.id })
          .from(branch)
          .where(eq(branch.operatorId, operatorId))
      ).map((b) => b.id),
    );

    // The accounts the view names, whichever operator they belong to.
    const named = [...new Set(input.rows.flatMap((r) => (r.platformUserId ? [r.platformUserId] : [])))];
    const accounts = new Map(
      (named.length
        ? await tx
            .select({ id: account.id, operatorId: account.operatorId, employeeId: account.employeeId })
            .from(account)
            .where(inArray(account.id, named))
        : []
      ).map((a) => [a.id, { ...a }]),
    );
    // The employee rows those accounts point at, for adoption.
    const pointedAt = [
      ...new Set(
        [...accounts.values()].flatMap((a) =>
          a.operatorId === operatorId && a.employeeId ? [a.employeeId] : [],
        ),
      ),
    ];
    const pointed = new Map(
      (pointedAt.length
        ? await tx.select().from(employee).where(inArray(employee.id, pointedAt))
        : []
      ).map((e) => [e.id, e]),
    );

    for (const r of [...input.rows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const fields: MirroredFields = {
        name: r.fullName,
        nickname: r.nickname,
        phone: r.phone,
        email: r.email,
        branchId: r.branchId !== null && ourBranches.has(r.branchId) ? r.branchId : null,
      };
      const left = r.employmentState === 'LEFT';

      // H23 — the link counts only inside the anchored operator.
      const linked = r.platformUserId ? accounts.get(r.platformUserId) : undefined;
      const ours = linked && linked.operatorId === operatorId ? linked : null;
      if (r.platformUserId && !ours) {
        raise(EMPLOYEE_SYNC_CASES.FOREIGN_ACCOUNT, {
          externalId: r.id,
          tenantId: r.tenantId,
          accountFound: Boolean(linked),
        });
      }

      const copy = live.get(r.id) ?? null;
      if (copy) {
        if (ours && ours.employeeId !== null && ours.employeeId !== copy.id) {
          const other = pointed.get(ours.employeeId);
          const conflict = other && other.externalId === null && other.operatorId === operatorId;
          raise(conflict ? EMPLOYEE_SYNC_CASES.ADOPTION_CONFLICT : EMPLOYEE_SYNC_CASES.ACCOUNT_CLASH, {
            externalId: r.id,
            employeeId: copy.id,
            accountId: ours.id,
            accountEmployeeId: ours.employeeId,
          });
        }
        if (left) {
          await archiveCopy(tx, copy, { reason: 'left', now, counts });
          continue;
        }
        if (!sameFields(fieldsOf(copy), fields)) {
          await tx
            .update(employee)
            .set({ ...fields, updatedAt: now })
            .where(eq(employee.id, copy.id));
          await audit.record(tx, {
            actorAccountId: null,
            operatorId,
            branchId: fields.branchId,
            action: 'employee.mirror_update',
            entityType: 'employee',
            entityId: copy.id,
            before: { ...fieldsOf(copy), externalId: r.id },
            after: { ...fields, externalId: r.id },
          });
          counts.updated += 1;
        }
        await linkAccount(tx, ours, copy.id, { externalId: r.id, operatorId, counts });
        continue;
      }

      // No live copy. First, the person's own platform row, when their
      // account has one (H2): adopted, never duplicated.
      const own = ours?.employeeId ? pointed.get(ours.employeeId) : undefined;
      if (
        own &&
        own.operatorId === operatorId &&
        own.externalId === null &&
        own.archivedAt === null
      ) {
        await tx
          .update(employee)
          .set({ ...fields, source: 'otoapp', externalId: r.id, updatedAt: now })
          .where(eq(employee.id, own.id));
        await audit.record(tx, {
          actorAccountId: null,
          operatorId,
          branchId: fields.branchId,
          action: 'employee.mirror_adopt',
          entityType: 'employee',
          entityId: own.id,
          before: { ...fieldsOf(own), source: own.source, externalId: null },
          after: { ...fields, source: 'otoapp', externalId: r.id, accountId: ours!.id },
        });
        counts.adopted += 1;
        const adopted = { ...own, ...fields, source: 'otoapp' as const, externalId: r.id };
        live.set(r.id, adopted);
        if (left) await archiveCopy(tx, adopted, { reason: 'left', now, counts });
        continue;
      }

      // A rehire: the same app id active again takes back the same row (H25).
      const previous = archived.get(r.id)?.[0];
      if (previous) {
        if (left) continue; // Still gone; the archived row stays as it was.
        await tx
          .update(employee)
          .set({ ...fields, archivedAt: null, updatedAt: now })
          .where(eq(employee.id, previous.id));
        await audit.record(tx, {
          actorAccountId: null,
          operatorId,
          branchId: fields.branchId,
          action: 'employee.mirror_restore',
          entityType: 'employee',
          entityId: previous.id,
          before: { ...fieldsOf(previous), archivedAt: previous.archivedAt!.toISOString(), externalId: r.id },
          after: { ...fields, archivedAt: null, externalId: r.id },
        });
        counts.restored += 1;
        live.set(r.id, { ...previous, ...fields, archivedAt: null });
        await linkAccount(tx, ours, previous.id, { externalId: r.id, operatorId, counts, raise });
        continue;
      }

      // Never seen, and not a leaver: a new copy.
      if (left) continue;
      const id = newId();
      await tx.insert(employee).values({
        id,
        operatorId,
        ...fields,
        source: 'otoapp',
        externalId: r.id,
        createdAt: now,
        updatedAt: now,
      });
      await audit.record(tx, {
        actorAccountId: null,
        operatorId,
        branchId: fields.branchId,
        action: 'employee.mirror_create',
        entityType: 'employee',
        entityId: id,
        after: { ...fields, source: 'otoapp', externalId: r.id },
      });
      counts.created += 1;
      live.set(r.id, {
        id,
        operatorId,
        ...fields,
        departmentId: null,
        source: 'otoapp',
        externalId: r.id,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      });
      await linkAccount(tx, ours, id, { externalId: r.id, operatorId, counts, raise });
    }

    // Gone from the app: archived, unless its park group was not read.
    if (!input.archiveGone) return;
    const present = new Set(input.rows.map((r) => r.id));
    for (const [externalId, copy] of live) {
      if (copy.archivedAt !== null) continue;
      if (present.has(externalId) || input.unread.has(externalId)) continue;
      await archiveCopy(tx, copy, { reason: 'gone', now, counts });
    }
  });

  input.raises.push(...pending);
  return counts;
}

/**
 * An account of this operator with no employee record of its own is given
 * this copy, audited `account.employee_link` with its before and after (H23).
 * One already pointing at a different row keeps it, and the case is raised —
 * unless the caller has raised it already (an existing copy).
 */
async function linkAccount(
  tx: Tx,
  ours: { id: string; employeeId: string | null } | null,
  employeeId: string,
  ctx: {
    externalId: string;
    operatorId: string;
    counts: OperatorCounts;
    raise?: (c: EmployeeSyncCase, detail: Record<string, unknown>) => void;
  },
): Promise<void> {
  if (!ours || ours.employeeId === employeeId) return;
  if (ours.employeeId !== null) {
    ctx.raise?.(EMPLOYEE_SYNC_CASES.ACCOUNT_CLASH, {
      externalId: ctx.externalId,
      employeeId,
      accountId: ours.id,
      accountEmployeeId: ours.employeeId,
    });
    return;
  }
  const [linked] = await tx
    .update(account)
    .set({ employeeId, updatedAt: new Date() })
    .where(and(eq(account.id, ours.id), isNull(account.employeeId)))
    .returning({ id: account.id });
  if (!linked) return;
  await audit.record(tx, {
    actorAccountId: null,
    operatorId: ctx.operatorId,
    action: 'account.employee_link',
    entityType: 'account',
    entityId: ours.id,
    before: { employeeId: null },
    after: { employeeId, externalId: ctx.externalId, source: 'otoapp' },
  });
  ours.employeeId = employeeId;
  ctx.counts.accountsLinked += 1;
}

/**
 * Archive a copy and revoke the person's live benefit cards with it (H6): the
 * cloud refuses them from this moment and every box from its next pull. Cards
 * already revoked or past their expiry are left as they are.
 */
async function archiveCopy(
  tx: Tx,
  copy: EmployeeRow,
  opts: { reason: 'left' | 'gone'; now: Date; counts: OperatorCounts },
): Promise<void> {
  const { now } = opts;
  const [done] = await tx
    .update(employee)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(employee.id, copy.id), isNull(employee.archivedAt)))
    .returning({ id: employee.id });
  if (!done) return;
  copy.archivedAt = now;
  await audit.record(tx, {
    actorAccountId: null,
    operatorId: copy.operatorId,
    branchId: copy.branchId,
    action: 'employee.mirror_archive',
    entityType: 'employee',
    entityId: copy.id,
    before: { archivedAt: null, externalId: copy.externalId },
    after: { archivedAt: now.toISOString(), externalId: copy.externalId, reason: opts.reason },
  });
  opts.counts.archived += 1;

  const revoked = await tx
    .update(benefitCredential)
    .set({ revokedAt: now, revokedByAccountId: null, updatedAt: now })
    .where(
      and(
        eq(benefitCredential.employeeId, copy.id),
        isNull(benefitCredential.revokedAt),
        gt(benefitCredential.expiresAt, now),
      ),
    )
    .returning();
  for (const card of revoked) {
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: card.operatorId,
      action: 'benefit.credential_revoke',
      entityType: 'benefit_credential',
      entityId: card.id,
      before: { id: card.id, revokedAt: null },
      after: {
        id: card.id,
        employeeId: card.employeeId,
        employeeName: copy.name,
        kid: card.kid,
        revokedAt: now.toISOString(),
        expiresAt: card.expiresAt.toISOString(),
        wasExpired: false,
        // Not an administrator's act: the OTO App said this person left.
        reason: opts.reason === 'left' ? 'employee_left' : 'employee_gone',
        externalId: copy.externalId,
      },
    });
    opts.counts.cardsRevoked += 1;
  }
}

/**
 * Benefits H17's other half: a benefit QR signed with this deployment's key
 * that names an employee the platform does not have. The scan is refused as
 * any unknown QR is; this files the case, because the likeliest reason is a
 * person the copy has not reached yet.
 */
export async function raiseUnknownBenefitEmployee(
  db: Exec,
  input: { operatorId: string; employeeId: string; credentialId: string },
): Promise<void> {
  // One case per credential. The scan that finds it is the one write on a
  // route whose answers stay out of the replay store (`secretResponse`), so a
  // till retrying with the same Idempotency-Key reaches here again — and the
  // same unknown card presented twice tells the Failures page nothing new
  // either. The credential id in the run's detail is the key.
  const [already] = await db
    .select({ id: opsRun.id })
    .from(opsRun)
    .where(
      and(
        eq(opsRun.name, OTOAPP_EMPLOYEE_SYNC_RUN),
        eq(opsRun.errorCode, EMPLOYEE_SYNC_CASES.UNKNOWN_EMPLOYEE),
        sql`${opsRun.detail} ->> 'credentialId' = ${input.credentialId}`,
      ),
    )
    .limit(1);
  if (already) return;
  await raiseEmployeeSync(db, {
    case: EMPLOYEE_SYNC_CASES.UNKNOWN_EMPLOYEE,
    operatorId: input.operatorId,
    detail: { employeeId: input.employeeId, credentialId: input.credentialId },
  });
}

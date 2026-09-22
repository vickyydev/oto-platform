import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, employee, operator, otoappUserBranchAccess, otoappUsers } from '@oto/db';
import { newId, normalizePhone } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-268 — the seam between the platform's branches and the OTO App's.
 *
 * The two systems carry two branch lists with the same three real names, their
 * own ids and nothing keeping them in step. `otoapp.branches.core_branch_id`
 * was put there to join them and was written and read by nothing, so everybody
 * provisioned from the launcher landed in NO branch of the app at either park:
 * the tile opened onto screens that answered with nothing, and somebody had to
 * go into the OTO App and set their branch access by hand.
 *
 * What is asserted here is provisioning being honest about that — the person is
 * seated where the two lists agree, and where they do not the answer SAYS they
 * landed nowhere rather than leaving it to be discovered. The full mapping
 * (direction, a stable key, Head Office, reconciling the rows that exist
 * unmapped today) is written up on the ticket and is not this.
 *
 * The OTO App's rows are inserted with SQL rather than through Drizzle: the
 * platform's declaration of that table is narrow on purpose — the columns it
 * reads — and the app's `branches` also requires an address the platform has
 * no business filling in.
 */

let ctx: TestContext;
let adminCookie: string;
let operatorId: string;
/** The app's own tenant, which every one of its branch rows belongs to. */
let appTenantId: string;

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [op] = await ctx.db.select().from(operator).limit(1);
  operatorId = op!.id;

  appTenantId = newId();
  await ctx.db.execute(
    sql`insert into otoapp.tenants (id, name, slug) values (${appTenantId}, 'OTO', 'oto')`,
  );
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** A branch of the park, made the way an administrator makes one. */
async function platformBranch(name: string, code: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/branches',
    headers: { cookie: adminCookie },
    payload: { name, code, timezone: 'Asia/Bangkok' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id as string;
}

/** A branch of the OTO App, written as that app's own migrator left it. */
async function appBranch(opts: { name: string; coreBranchId?: string }): Promise<string> {
  const id = newId();
  await ctx.db.execute(
    sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
        values (${id}, ${appTenantId}, ${opts.name}, 'A mall in Phuket', ${opts.coreBranchId ?? null})`,
  );
  return id;
}

/**
 * Somebody who works at a branch, as the platform records it: an employee row
 * carrying the branch, and an account linked to it. This is what "the branch
 * they are seated at" means — not the session branch of whoever is doing the
 * provisioning, which is a value that caller sets for themselves.
 */
async function seatedAccount(opts: {
  phone: string;
  name: string;
  branchId: string | null;
}): Promise<string> {
  const employeeId = newId();
  await ctx.db.insert(employee).values({
    id: employeeId,
    operatorId,
    name: opts.name,
    branchId: opts.branchId,
  });
  const accountId = newId();
  await ctx.db.insert(account).values({
    id: accountId,
    operatorId,
    employeeId,
    phone: normalizePhone(opts.phone)!,
    status: 'invited',
  });
  return accountId;
}

/** Provision that person into the OTO App, the way the console does. */
async function provision(accountId: string, email: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/admin/apps/oto_app/users',
    headers: { cookie: adminCookie },
    payload: { accountId, otoApp: { email, role: 'staff' } },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    externalUserId: string;
    appUserCreated: boolean;
    appBranch: {
      branchId: string | null;
      branchName: string | null;
      matchedBy: string | null;
      unplacedReason: string | null;
    };
  };
}

const branchAccessOf = async (userId: string) =>
  ctx.db.select().from(otoappUserBranchAccess).where(eq(otoappUserBranchAccess.userId, userId));

describe('a person provisioned into the OTO App lands in a branch (SCRUM-268)', () => {
  it('seats them by core_branch_id, even when the two names have drifted apart', async () => {
    const platform = await platformBranch('Oto Play Park, Central Floresta', 'seam-floresta');
    // The name deliberately does NOT match: the id is what joins the two
    // lists, and a park renamed on one side has to keep working.
    const app = await appBranch({ name: 'Central Floresta (old name)', coreBranchId: platform });

    const accountId = await seatedAccount({
      phone: '+66900000401',
      name: 'Seated By Id',
      branchId: platform,
    });
    const result = await provision(accountId, 'seated.by.id@otopark.test');

    expect(result.appUserCreated).toBe(true);
    expect(result.appBranch).toMatchObject({
      branchId: app,
      matchedBy: 'core_branch_id',
      unplacedReason: null,
    });

    const rows = await branchAccessOf(result.externalUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branchId).toBe(app);
    // `selected_branches` and not `all_branches`: seating somebody at their own
    // park must not hand them every park.
    expect(rows[0]!.accessScope).toBe('selected_branches');
    // The app takes a session's tenant from the first of these rows, so it
    // comes off the branch they were seated in.
    expect(rows[0]!.tenantId).toBe(appTenantId);
  });

  it('falls back to an exact name when no row carries the id', async () => {
    const platform = await platformBranch('Oto Play Park, Robinson Chalong', 'seam-chalong');
    const app = await appBranch({ name: 'Oto Play Park, Robinson Chalong' });

    const accountId = await seatedAccount({
      phone: '+66900000402',
      name: 'Seated By Name',
      branchId: platform,
    });
    const result = await provision(accountId, 'seated.by.name@otopark.test');

    expect(result.appBranch).toMatchObject({
      branchId: app,
      branchName: 'Oto Play Park, Robinson Chalong',
      matchedBy: 'name',
    });
    expect(await branchAccessOf(result.externalUserId)).toHaveLength(1);
  });

  it('records the seating on the audit row for the link', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/audit?action=app_identity.link',
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().entries as Array<{ after: Record<string, unknown> }>;
    const seated = rows.filter(
      (r) => (r.after.appBranch as { matchedBy?: string } | null)?.matchedBy,
    );
    expect(seated.length).toBeGreaterThan(0);
  });
});

describe('and when it cannot be resolved, the answer says so (SCRUM-268)', () => {
  it('provisions them anyway when the app has no branch of that name', async () => {
    const platform = await platformBranch('Oto Play Park, Phuket Town', 'seam-town');
    const accountId = await seatedAccount({
      phone: '+66900000403',
      name: 'Nowhere To Sit',
      branchId: platform,
    });
    const result = await provision(accountId, 'nowhere.to.sit@otopark.test');

    // The user exists and the tile is granted — a refusal here would leave an
    // administrator with half a person and nothing to do about it.
    expect(result.appUserCreated).toBe(true);
    expect(
      await ctx.db.select().from(otoappUsers).where(eq(otoappUsers.id, result.externalUserId)),
    ).toHaveLength(1);

    expect(result.appBranch).toEqual({
      branchId: null,
      branchName: null,
      matchedBy: null,
      unplacedReason: 'no_app_branch',
    });
    expect(await branchAccessOf(result.externalUserId)).toHaveLength(0);
  });

  it('says so when the platform does not know where the person works', async () => {
    const accountId = await seatedAccount({
      phone: '+66900000404',
      name: 'No Branch On Record',
      branchId: null,
    });
    const result = await provision(accountId, 'no.branch.on.record@otopark.test');

    expect(result.appBranch.unplacedReason).toBe('no_platform_branch');
    expect(await branchAccessOf(result.externalUserId)).toHaveLength(0);
  });

  it('declines to guess between two app branches of the same name', async () => {
    const platform = await platformBranch('Oto Play Park, Kata', 'seam-kata');
    await appBranch({ name: 'Oto Play Park, Kata' });
    await appBranch({ name: 'Oto Play Park, Kata' });

    const accountId = await seatedAccount({
      phone: '+66900000405',
      name: 'Two Of Those',
      branchId: platform,
    });
    const result = await provision(accountId, 'two.of.those@otopark.test');

    // Seating somebody in the wrong park's data is worse than seating them in
    // none: one is visible in the answer, the other is not visible at all.
    expect(result.appBranch.unplacedReason).toBe('ambiguous_name');
    expect(await branchAccessOf(result.externalUserId)).toHaveLength(0);
  });

  it('leaves no branch access behind when a later step fails', async () => {
    const platform = await platformBranch('Oto Play Park, Rawai', 'seam-rawai');
    await appBranch({ name: 'Oto Play Park, Rawai', coreBranchId: platform });
    const accountId = await seatedAccount({
      phone: '+66900000406',
      name: 'Rolled Back',
      branchId: platform,
    });

    // The link is refused on the second attempt — the account is already
    // linked — and the transaction takes the seating with it.
    const first = await provision(accountId, 'rolled.back@otopark.test');
    expect(first.appBranch.matchedBy).toBe('core_branch_id');

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: { accountId, otoApp: { email: 'rolled.back.2@otopark.test', role: 'staff' } },
    });
    expect(second.statusCode).toBe(409);

    const stray = await ctx.db
      .select()
      .from(otoappUsers)
      .where(eq(otoappUsers.email, 'rolled.back.2@otopark.test'));
    expect(stray).toHaveLength(0);
    // One seating for the one user that was actually created.
    expect(await branchAccessOf(first.externalUserId)).toHaveLength(1);
  });
});

describe('the branch seam does not move anybody who was already in the app', () => {
  it('leaves a linked user’s branch access alone', async () => {
    const platform = await platformBranch('Oto Play Park, Kamala', 'seam-kamala');
    await appBranch({ name: 'Oto Play Park, Kamala', coreBranchId: platform });

    const existingUserId = newId();
    await ctx.db.insert(otoappUsers).values({
      id: existingUserId,
      email: 'already.there@otopark.test',
      password: 'not-a-real-hash',
      fullName: 'Already In The OTO App',
      role: 'manager',
      isActive: true,
      mustChangePassword: true,
    });

    const accountId = await seatedAccount({
      phone: '+66900000407',
      name: 'Already There',
      branchId: platform,
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/admin/apps/oto_app/users',
      headers: { cookie: adminCookie },
      payload: { accountId, externalUserId: existingUserId },
    });
    expect(res.statusCode, res.body).toBe(200);

    // Their branch access is the app's own record of where they work, set by
    // whoever set it. The link writes the stamp and nothing else — this route
    // has no business moving somebody between parks.
    expect(res.json().appBranch).toBeNull();
    expect(await branchAccessOf(existingUserId)).toHaveLength(0);
  });
});

/**
 * Which branch is "theirs" is the whole question, and there are two candidates
 * in the request: where the person works, and where the administrator doing
 * the provisioning happens to be standing.
 */
describe('the branch is the person’s, not the administrator’s (SCRUM-268)', () => {
  it('seats them where they work, with the administrator standing somewhere else', async () => {
    const theirs = await platformBranch('Oto Play Park, Kalim', 'seam-kalim');
    const elsewhere = await platformBranch('Oto Play Park, Rawai Two', 'seam-rawai-two');
    const theirAppBranch = await appBranch({ name: 'Kalim', coreBranchId: theirs });
    await appBranch({ name: 'Rawai Two', coreBranchId: elsewhere });

    // The administrator moves their own session to the other park first. A
    // session branch is a value the caller sets for themselves (SCRUM-264), so
    // anything resolved from it would seat this hire at whichever park the
    // administrator last looked at.
    const moved = await ctx.app.inject({
      method: 'PUT',
      url: '/me/session/branch',
      headers: { cookie: adminCookie },
      payload: { branchId: elsewhere },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const accountId = await seatedAccount({
      phone: '+66900000408',
      name: 'Works At Kalim',
      branchId: theirs,
    });
    const result = await provision(accountId, 'works.at.kalim@otopark.test');

    expect(result.appBranch.branchId).toBe(theirAppBranch);
    expect(result.appBranch.branchName).toBe('Kalim');
  });
});

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, alert, auditLog, branch, employee, roleAssignment, station } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-265 and SCRUM-266 — the Console's fleet reads, and the account writes.
 *
 * Both defects were found by driving the api as a manager at each of the two
 * parks, and both are invisible with one branch open: with one branch, "every
 * box in the operator" IS your branch's boxes and there is nobody at another
 * park to take over. So every case here is a manager of one park aimed at the
 * other, and every one of them is followed by the operator administrator doing
 * the same thing successfully. A scoping fix that only refuses is half a fix —
 * the half that locks the estate's administrator out of their own estate is
 * the one that gets reverted in a hurry on a Saturday.
 *
 * The two parks are the seed's, not fixtures: what is being asserted is that a
 * manager seeded at Robinson Chalong cannot read Central Floresta's equipment,
 * and the seed is where that pairing is defined.
 */

let ctx: TestContext;

let florestaId: string;
let chalongId: string;
/** The parks as they are NAMED, which is what a refusal and a page heading say. */
let florestaName: string;
let chalongName: string;
/** A seeded till at each park, for the station refusals (SCRUM-300). */
let florestaStation: string;
let chalongStation: string;
let adminCookie: string;
let lek: string; // manager, Central Floresta
let dao: string; // manager, Robinson Chalong

/** A new hire: an account with an employee record at one park and no role yet. */
let hireAtChalong: string;
let hireAtFloresta: string;
/** An account tied to no branch at all — no employee record, no grant. */
let hireNowhere: string;

/** Raised about a printer at Central Floresta. */
let florestaAlert: string;
/** The deployment's own — a job that stopped. It is about no branch. */
let platformAlert: string;

interface BoxRow {
  name: string;
  branchName: string;
  devices: { label: string }[];
}
interface HealthBody {
  boxes: BoxRow[];
  alerts: { id: string }[];
}

/**
 * Sign in, then put the session on the branch this person actually manages.
 *
 * Deliberate, and not decoration: sign-in seats every account on the
 * operator's first branch whatever their grants say (SCRUM-263, another
 * slice's to fix), so Chalong's manager lands at Floresta and the guard on
 * `admin:health:read` — which has no target and falls back to the session
 * branch — refuses her before any of this is reached.
 */
async function signInAtBranch(
  phone: string,
  password: string,
  branchId: string,
): Promise<string> {
  const cookie = await signInAs(ctx.app, phone, password);
  const moved = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/branch',
    headers: { cookie },
    payload: { branchId },
  });
  expect(moved.statusCode).toBe(200);
  return cookie;
}

/** A roleless account, optionally with an employee record at one park. */
async function makeHire(opts: {
  operatorId: string;
  phone: string;
  name: string;
  branchId: string | null;
}): Promise<string> {
  let employeeId: string | null = null;
  if (opts.branchId) {
    employeeId = newId();
    await ctx.db.insert(employee).values({
      id: employeeId,
      operatorId: opts.operatorId,
      name: opts.name,
      phone: opts.phone,
      branchId: opts.branchId,
    });
  }
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId: opts.operatorId,
    employeeId,
    phone: opts.phone,
    status: 'invited',
  });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();

  const branches = await ctx.db.select().from(branch);
  const floresta = branches.find((b) => b.code === CENTRAL_BRANCH_CODE)!;
  const chalong = branches.find((b) => b.code === CHALONG_BRANCH_CODE)!;
  florestaId = floresta.id;
  chalongId = chalong.id;
  florestaName = floresta.name;
  chalongName = chalong.name;
  const operatorId = floresta.operatorId;

  // The seed puts a till on a box at each park. Read rather than named: what
  // matters is that one stands at the OTHER park from the caller.
  const stations = await ctx.db.select().from(station);
  florestaStation = stations.find((s) => s.branchId === florestaId && s.boxId !== null)!.id;
  chalongStation = stations.find((s) => s.branchId === chalongId && s.boxId !== null)!.id;

  adminCookie = await signInAtBranch(ADMIN.phone, ADMIN.password, florestaId);
  lek = await signInAtBranch(BRANCH_MANAGER.phone, BRANCH_MANAGER.password, florestaId);
  dao = await signInAtBranch(CHALONG_MANAGER.phone, CHALONG_MANAGER.password, chalongId);

  hireAtChalong = await makeHire({
    operatorId,
    phone: '+66900000401',
    name: 'Chalong New Hire',
    branchId: chalongId,
  });
  hireAtFloresta = await makeHire({
    operatorId,
    phone: '+66900000402',
    name: 'Floresta New Hire',
    branchId: florestaId,
  });
  hireNowhere = await makeHire({
    operatorId,
    phone: '+66900000403',
    name: 'Unplaced New Hire',
    branchId: null,
  });

  florestaAlert = newId();
  await ctx.db.insert(alert).values({
    id: florestaAlert,
    key: 'device.paper:floresta-receipt-1',
    category: 'device.paper',
    severity: 'warning',
    subject: 'Receipt Printer 1',
    summary: 'Receipt Printer 1 is out of paper',
    operatorId,
    branchId: florestaId,
  });

  platformAlert = newId();
  await ctx.db.insert(alert).values({
    id: platformAlert,
    key: 'ops.missing:job:housekeeping.retention',
    category: 'ops.missing',
    severity: 'warning',
    subject: 'job:housekeeping.retention',
    summary: 'job:housekeeping.retention has not succeeded for an hour',
    operatorId,
  });
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const health = async (cookie: string): Promise<HealthBody> => {
  const res = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json<HealthBody>();
};

// ---------------------------------------------------------------------------

describe("SCRUM-265 — the Health page stops at the caller's branches", () => {
  it("gives Chalong's manager her own box and nothing from the other park", async () => {
    const body = await health(dao);

    expect(body.boxes.map((b) => b.name)).toEqual(['Virtual box 3']);
    expect(new Set(body.boxes.map((b) => b.branchName))).toEqual(
      new Set(['Oto Play Park, Robinson Chalong']),
    );
  });

  it("names none of Central Floresta's boxes, devices or park in her answer", async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/ops/health',
      headers: { cookie: dao },
    });
    // Not merely absent from the box list — absent from the payload. The
    // register's finding was byte-identical answers for the two managers, and
    // what leaked was the device inventory inside each box.
    expect(res.body).not.toContain('Virtual box 1');
    expect(res.body).not.toContain('Virtual box 2');
    expect(res.body).not.toContain('Kitchen Printer');
    expect(res.body).not.toContain('Band Printer');
    expect(res.body).not.toContain('Central Floresta');
  });

  it("gives Floresta's manager her two boxes and not Chalong's", async () => {
    const body = await health(lek);
    expect(body.boxes.map((b) => b.name).sort()).toEqual(['Virtual box 1', 'Virtual box 2']);
    expect(body.boxes.some((b) => b.devices.some((d) => d.label === 'Kitchen Printer'))).toBe(true);
    expect(body.boxes.map((b) => b.name)).not.toContain('Virtual box 3');
  });

  it('still gives the operator administrator the whole fleet', async () => {
    const body = await health(adminCookie);
    expect(body.boxes.map((b) => b.name).sort()).toEqual([
      'Virtual box 1',
      'Virtual box 2',
      'Virtual box 3',
    ]);
    expect(new Set(body.boxes.map((b) => b.branchName)).size).toBe(2);
  });

  it("keeps an alert about one park's printer off the other park's Health page", async () => {
    expect((await health(lek)).alerts.map((a) => a.id)).toContain(florestaAlert);
    expect((await health(dao)).alerts.map((a) => a.id)).not.toContain(florestaAlert);
    expect((await health(adminCookie)).alerts.map((a) => a.id)).toContain(florestaAlert);
  });

  it("keeps the deployment's own alerts to whoever administers the deployment", async () => {
    // An alert carrying no branch is about the platform, not about a park —
    // the same ruling the audit log makes for a branchless row (SCRUM-249).
    const ids = (await health(adminCookie)).alerts.map((a) => a.id);
    expect(ids).toContain(platformAlert);
    expect((await health(lek)).alerts.map((a) => a.id)).not.toContain(platformAlert);
    expect((await health(dao)).alerts.map((a) => a.id)).not.toContain(platformAlert);
  });
});

// ---------------------------------------------------------------------------

describe('SCRUM-266 — a roleless account is still somebody, at one branch', () => {
  /**
   * The shape of the defect: `assertDominatesAccount` walks the roles the
   * target holds and refuses what the caller could not have granted. A new
   * hire who has an account and no role yet holds nothing, so the walk is over
   * an empty list and the check returns without refusing anything. Dominance
   * asks whether the target is above the caller; it never asked whether the
   * target is theirs.
   */

  it("refuses a manager a temporary password for a hire at the other park, and mints none", async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${hireAtChalong}/temp-password`,
      headers: { cookie: lek },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');

    const [row] = await ctx.db.select().from(account).where(eq(account.id, hireAtChalong));
    // The finding was that a live password came back. Nothing was set here.
    expect(row!.passwordHash).toBeNull();
    expect(row!.mustChangePassword).toBe(false);
    expect(row!.status).toBe('invited');
  });

  it("refuses to change that hire's phone number or end their working day", async () => {
    const phoned = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${hireAtChalong}`,
      headers: { cookie: lek },
      payload: { phone: '+66900000499' },
    });
    expect(phoned.statusCode).toBe(403);

    const deactivated = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${hireAtChalong}`,
      headers: { cookie: lek },
      payload: { status: 'inactive' },
    });
    expect(deactivated.statusCode).toBe(403);

    const [row] = await ctx.db.select().from(account).where(eq(account.id, hireAtChalong));
    expect(row!.phone).toBe('+66900000401');
    expect(row!.status).toBe('invited');
  });

  it('refuses to end their sessions or to read where they can act', async () => {
    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${hireAtChalong}/sessions/revoke`,
      headers: { cookie: lek },
    });
    expect(revoked.statusCode).toBe(403);

    const permissions = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${hireAtChalong}/permissions`,
      headers: { cookie: lek },
    });
    expect(permissions.statusCode).toBe(403);
  });

  it('refuses to grant that hire a role — including one at the caller’s own branch', async () => {
    // The register's last step, and the one that turns a leak into a login: a
    // grant scoped to the caller's OWN park passes both scope-ownership and
    // dominance, because neither of those is about the person.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${hireAtChalong}/role-assignments`,
      headers: { cookie: lek },
      payload: { roleName: 'reception', scopeType: 'branch', scopeId: florestaId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');

    const rows = await ctx.db
      .select()
      .from(roleAssignment)
      .where(eq(roleAssignment.accountId, hireAtChalong));
    expect(rows).toEqual([]);
  });

  it('refuses an account tied to no branch at all', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${hireNowhere}/temp-password`,
      headers: { cookie: lek },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets the manager do all of it for a hire at their own park", async () => {
    const granted = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${hireAtFloresta}/role-assignments`,
      headers: { cookie: lek },
      payload: { roleName: 'reception', scopeType: 'branch', scopeId: florestaId },
    });
    expect(granted.statusCode).toBe(200);

    const permissions = await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${hireAtFloresta}/permissions`,
      headers: { cookie: lek },
    });
    expect(permissions.statusCode).toBe(200);

    const temp = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${hireAtFloresta}/temp-password`,
      headers: { cookie: lek },
    });
    expect(temp.statusCode).toBe(200);
    expect(temp.json().temporaryPassword).toBeTruthy();
  });

  it("lets Chalong's manager take over the hire at Chalong", async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/accounts/${hireAtChalong}/temp-password`,
      headers: { cookie: dao },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().temporaryPassword).toBeTruthy();
  });

  it('leaves the operator administrator able to administer everybody', async () => {
    for (const id of [hireAtChalong, hireAtFloresta, hireNowhere]) {
      const permissions = await ctx.app.inject({
        method: 'GET',
        url: `/accounts/${id}/permissions`,
        headers: { cookie: adminCookie },
      });
      expect(permissions.statusCode).toBe(200);

      const temp = await ctx.app.inject({
        method: 'POST',
        url: `/accounts/${id}/temp-password`,
        headers: { cookie: adminCookie },
      });
      expect(temp.statusCode).toBe(200);
    }

    const deactivated = await ctx.app.inject({
      method: 'PATCH',
      url: `/accounts/${hireNowhere}`,
      headers: { cookie: adminCookie },
      payload: { status: 'inactive' },
    });
    expect(deactivated.statusCode).toBe(200);

    const [row] = await ctx.db
      .select()
      .from(account)
      .where(and(eq(account.id, hireNowhere), eq(account.status, 'inactive')));
    expect(row).toBeDefined();
  });
});

// ---------------------------------------------------------------------------

/** A refusal, flattened: the status, the code and the sentence a person reads. */
async function refusal(
  method: 'GET' | 'POST',
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; code: string | null; message: string }> {
  const res = payload
    ? await ctx.app.inject({ method, url, headers: { cookie }, payload })
    : await ctx.app.inject({ method, url, headers: { cookie } });
  const body = res.json<{ error?: { code?: string; message?: string } }>();
  return {
    status: res.statusCode,
    code: body.error?.code ?? null,
    message: body.error?.message ?? '',
  };
}

const ok = async (url: string, cookie: string): Promise<number> =>
  (await ctx.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode;

describe('SCRUM-300 — a refusal that names the park, not a permission she holds', () => {
  /**
   * Found by driving the api as each park's manager. Every one of these
   * refusals was correct and every one of them gave the wrong reason: a
   * manager who holds `admin:station:read` at her own park was told she was
   * missing it, which reads as "ask somebody for this role" and ends with the
   * role being granted a second time at the branch where she already had it.
   *
   * What she was actually refused is the OTHER park, and that is now what the
   * answer says — the refusal the session-branch switch and the account writes
   * have given since SCRUM-264 and SCRUM-266.
   */
  it('names the park when she asks to look at a till standing at it', async () => {
    const seen = await refusal('GET', `/stations/${florestaStation}/session`, dao);
    expect(seen.status).toBe(403);
    expect(seen.code).toBe('OUT_OF_BRANCH_SCOPE');
    expect(seen.message).toContain(florestaName);
    expect(seen.message).toContain('admin:station:read');
  });

  it('says the same thing when she tries to take that till', async () => {
    const claim = await refusal('POST', `/stations/${florestaStation}/lease`, dao, {
      holder: 'ipad-chalong-1',
    });
    expect(claim.status).toBe(403);
    expect(claim.code).toBe('OUT_OF_BRANCH_SCOPE');
    expect(claim.message).toContain(florestaName);
  });

  it('names the park on the audit trail she asked for', async () => {
    const trail = await refusal('GET', `/audit?branchId=${florestaId}`, dao);
    expect(trail.status).toBe(403);
    expect(trail.code).toBe('OUT_OF_BRANCH_SCOPE');
    expect(trail.message).toContain(florestaName);
    expect(trail.message).toContain('admin:audit:read');
  });

  it('stops naming a station-UPDATE permission for a staff read', async () => {
    const staff = await refusal('GET', `/branches/${florestaId}/staff`, dao);
    expect(staff.status).toBe(403);
    expect(staff.code).toBe('OUT_OF_BRANCH_SCOPE');
    expect(staff.message).toContain(florestaName);
    // The second half of the finding: a read that asked to be granted the
    // permission to CHANGE stations.
    expect(staff.message).not.toContain('admin:station:update');
    expect(staff.message).toContain('admin:station:read');
  });

  it('leaves the ordinary refusal — genuinely not holding it — exactly as it was', async () => {
    // Reception holds `admin:audit:read` at no branch at all, so for them the
    // missing thing really is the permission and the sentence must still say
    // so. This is the case the new refusal must not swallow.
    const receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const trail = await refusal('GET', '/audit', receptionCookie);
    expect(trail.status).toBe(403);
    expect(trail.code).toBe('FORBIDDEN');
    expect(trail.message).toBe('Missing permission admin:audit:read');
  });

  it('still writes the refusal down, which the more precise code nearly cost', async () => {
    /**
     * The trap this ticket walked into, found by reading the trail rather than
     * the answer: the error handler audits a denial only when its CODE is one
     * it knows, and `OUT_OF_BRANCH_SCOPE` was not one. Every one of these
     * refusals had been recorded as `auth.permission_denied` while it was a
     * plain FORBIDDEN, and making the sentence more accurate would have made
     * the event disappear — a manager probing the other park's tills would
     * have left no mark at all.
     *
     * The same hole had already swallowed the account writes and the
     * session-branch switch, which moved to this code in earlier tickets. So
     * the assertion is on the row, not on the sentence.
     */
    const before = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, 'access.denied'));

    const refused = await refusal('GET', `/branches/${florestaId}/staff`, dao);
    expect(refused.code).toBe('OUT_OF_BRANCH_SCOPE');

    const after = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'access.denied'));
    expect(after.length).toBe(before.length + 1);

    const row = after.find((r) => !before.some((b) => b.id === r.id))!;
    expect(row.entityType).toBe('request');
    const detail = row.after as { code?: string; url?: string; method?: string };
    expect(detail.code).toBe('OUT_OF_BRANCH_SCOPE');
    expect(detail.method).toBe('GET');
    expect(detail.url).toContain('/staff');
  });

  it('refuses nothing at her own park, and nothing anywhere to the administrator', async () => {
    expect(await ok(`/branches/${chalongId}/staff`, dao)).toBe(200);
    expect(await ok(`/audit?branchId=${chalongId}`, dao)).toBe(200);
    expect(await ok(`/stations/${chalongStation}/session`, dao)).toBe(200);

    expect(await ok(`/branches/${florestaId}/staff`, adminCookie)).toBe(200);
    expect(await ok(`/audit?branchId=${florestaId}`, adminCookie)).toBe(200);
    expect(await ok(`/stations/${florestaStation}/session`, adminCookie)).toBe(200);
  });
});

// ---------------------------------------------------------------------------

interface ReachBody {
  reach: { scope: string; branches: Array<{ id: string; name: string }> };
}

const reachOf = async (url: string, cookie: string): Promise<ReachBody['reach']> => {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json<ReachBody>().reach;
};

describe('SCRUM-299 — an empty list says which parks it was answering for', () => {
  /**
   * Both lists were already scoped and neither said so, which made "your park
   * has nothing wrong" and "this page is not showing you your park"
   * indistinguishable — and only the administrator, who has rows, could tell
   * the page worked at all.
   */
  it("tells Chalong's manager the failure list covers her park and no other", async () => {
    const reach = await reachOf('/ops/failures?windowHours=24', dao);
    expect(reach.scope).toBe('branch');
    expect(reach.branches.map((b) => b.name)).toEqual([chalongName]);
    expect(reach.branches.map((b) => b.id)).toEqual([chalongId]);
  });

  it('says the same on the anomaly list', async () => {
    const reach = await reachOf('/ops/anomalies', dao);
    expect(reach.scope).toBe('branch');
    expect(reach.branches.map((b) => b.name)).toEqual([chalongName]);
  });

  it("names Floresta's manager's own park, and never the other one", async () => {
    const reach = await reachOf('/ops/failures?windowHours=24', lek);
    expect(reach.branches.map((b) => b.name)).toEqual([florestaName]);
    expect(reach.branches.map((b) => b.name)).not.toContain(chalongName);
  });

  it('tells the administrator the answer covers the whole operator', async () => {
    for (const url of ['/ops/failures?windowHours=24', '/ops/anomalies']) {
      const reach = await reachOf(url, adminCookie);
      expect(reach.scope).toBe('operator');
      // Deliberately no list: an operator-wide reach includes the parks that
      // open next year, which no list of ids can say.
      expect(reach.branches).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

interface HealthShape extends ReachBody {
  checks: Array<{ key: string }>;
  jobs: Array<{ name: string }>;
  boxes: Array<{ name: string }>;
}

const healthShape = async (cookie: string): Promise<HealthShape> => {
  const res = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json<HealthShape>();
};

describe('SCRUM-301 — the Health page stops handing a manager the deployment', () => {
  it("answers a branch manager with her boxes and none of the platform's state", async () => {
    const body = await healthShape(dao);

    /**
     * Asserted ahead of the reach below, so that this is the line that goes
     * red when the trimming is missing rather than the one reading a field
     * that would not be there either.
     *
     * The database probe, the pool, the watchdog and the job register are the
     * deployment's. The acknowledge and retry paths ask for `admin:ops:manage`
     * at the row's own branch, and a row belonging to no branch is asked about
     * with none — so she could only ever have read these and been unable to
     * act on them.
     */
    expect(body.checks).toEqual([]);
    expect(body.jobs).toEqual([]);

    // Her own park is still there, which is the half of the page that is hers.
    expect(body.boxes.map((b) => b.name)).toEqual(['Virtual box 3']);

    expect(body.reach.scope).toBe('branch');
    expect(body.reach.branches.map((b) => b.name)).toEqual([chalongName]);
  });

  it('still answers the administrator with every dependency check', async () => {
    const body = await healthShape(adminCookie);
    expect(body.reach.scope).toBe('operator');
    const keys = body.checks.map((c) => c.key);
    expect(keys).toContain('database');
    expect(keys).toContain('pool');
    expect(keys).toContain('watchdog');
    expect(body.boxes.length).toBeGreaterThan(1);
  });
});

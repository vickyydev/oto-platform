import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { account, branch, operator, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import {
  BRANCH_MANAGER, CENTRAL_BRANCH_CODE, CHALONG_BRANCH_CODE, branchIdByCode,
  createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

const datedPaths = [
  '/aggregates/members', '/aggregates/bookings',
  '/aggregates/assistant-usage', '/aggregates/inbox-ai-usage',
] as const;
const paths = [...datedPaths, '/aggregates/fleet'] as const;
type AggregatePath = typeof paths[number];

let ctx: TestContext;
let cookie: string;
let accountId: string;
let operatorId: string;
let central: string;
let chalong: string;
let foreignOperator: string;
let foreignBranch: string;
let archivedBranch: string;
let overviewRole: string;

const queryOf = (path: AggregatePath) => path === '/aggregates/fleet'
  ? '' : '?from=2026-10-01&to=2026-10-02';
const read = (path: AggregatePath, query = queryOf(path), authenticated = true) => ctx.app.inject({
  method: 'GET', url: `${path}${query}`, headers: authenticated ? { cookie } : {},
});
const branchQuery = (path: AggregatePath, id: string) => `${queryOf(path)}${queryOf(path) ? '&' : '?'}branchId=${id}`;

async function grant(scopeType: 'operator' | 'branch' | 'department', scopeIds: string[]) {
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, accountId));
  if (scopeIds.length) await ctx.db.insert(roleAssignment).values(scopeIds.map((scopeId) => ({
    id: newId(), accountId, roleId: overviewRole, scopeType, scopeId,
  })));
}

function assertNoPrivateDetails(value: unknown) {
  const privateKeys = new Set([
    'accountId', 'memberId', 'conversationId', 'triggerMessageId', 'question', 'answer',
    'phone', 'email', 'password', 'secret', 'cookie', 'apiKey', 'token',
  ]);
  if (Array.isArray(value)) {
    for (const entry of value) assertNoPrivateDetails(entry);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      expect(privateKeys.has(key), `private detail key: ${key}`).toBe(false);
      assertNoPrivateDetails(entry);
    }
  }
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [person] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  accountId = person!.id;
  operatorId = person!.operatorId!;
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  foreignOperator = newId();
  foreignBranch = newId();
  archivedBranch = newId();
  overviewRole = newId();
  await ctx.db.insert(operator).values({ id: foreignOperator, name: 'ZZ TEST Aggregates foreign operator' });
  await ctx.db.insert(branch).values([
    { id: foreignBranch, operatorId: foreignOperator, name: 'ZZ TEST Aggregates foreign park', code: 'zz-aggregate-foreign' },
    { id: archivedBranch, operatorId, name: 'ZZ TEST Aggregates archived park', code: 'zz-aggregate-archived', archivedAt: new Date() },
  ]);
  await ctx.db.insert(role).values({ id: overviewRole, operatorId, name: 'ZZ TEST Aggregates Overview only' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: overviewRole, permission: 'console:overview:read' });
});

beforeEach(async () => { await grant('branch', [chalong]); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

/** SCRUM-636 house review. Q17/Q18 payload choices are deliberately outside these shared-contract pins. */
describe.each(paths)('SCRUM-636 %s adversarial review', (path) => {
  it('FINDING R1 high: the read must exist and authenticate before returning aggregates; reject an anonymous caller', async () => {
    expect((await read(path, queryOf(path), false)).statusCode).toBe(401);
  });

  it('FINDING R2 high: Overview reach alone governs the read, independently of the session seat and detail-screen grants', async () => {
    const response = await read(path);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.branches.map((entry: { id: string }) => entry.id)).toEqual([chalong]);
    expect(body.selectedBranchIds).toEqual([chalong]);
    expect(body.parks.map((entry: { branchId: string }) => entry.branchId)).toEqual([chalong]);
    expect(Object.keys(body.branches[0]).sort()).toEqual(['businessDate', 'businessDayStart', 'id', 'name', 'timezone']);
    expect(body.branches[0].businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isFinite(Date.parse(body.generatedAt))).toBe(true);
    if (path !== '/aggregates/fleet') expect(body.period).toEqual({ from: '2026-10-01', to: '2026-10-02' });
    assertNoPrivateDetails(body);
    for (const hidden of [central, foreignBranch, archivedBranch, accountId]) {
      expect(JSON.stringify(body)).not.toContain(hidden);
    }
  });

  it('FINDING R3 high: foreign and absent parks must be indistinguishable, while an owned unreachable park is forbidden', async () => {
    const foreign = await read(path, branchQuery(path, foreignBranch));
    const absent = await read(path, branchQuery(path, newId()));
    expect(foreign.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(absent.json().error.code);
    expect(foreign.json().error.message).toBe(absent.json().error.message);
    expect((await read(path, branchQuery(path, central))).statusCode).toBe(403);
  });

  it('FINDING R4 high: changing or removing grants must affect the next request; never reuse an earlier broad reach', async () => {
    await grant('operator', [operatorId]);
    expect((await read(path, branchQuery(path, central))).statusCode).toBe(200);
    await grant('branch', [chalong]);
    expect((await read(path, branchQuery(path, central))).statusCode).toBe(403);
    await grant('branch', []);
    expect((await read(path)).statusCode).toBe(403);
  });

  it('FINDING R5 high: another operator or a department grant cannot imply park-wide aggregate authority', async () => {
    await grant('operator', [foreignOperator]);
    expect((await read(path)).statusCode).toBe(403);
    await grant('department', [newId()]);
    expect((await read(path)).statusCode).toBe(403);
  });

  it('FINDING R6 medium: malformed or duplicate park filters must not fall back to all reachable parks', async () => {
    expect((await read(path, branchQuery(path, 'invalid'))).statusCode).toBe(400);
    expect((await read(path, `${branchQuery(path, chalong)}&branchId=${central}`)).statusCode).toBe(400);
  });

  it('FINDING R7 high: archived parks must be absent from both the picker and aggregates even for operator-wide reach', async () => {
    await grant('operator', [operatorId]);
    const response = await read(path);
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json())).not.toContain(archivedBranch);
    expect((await read(path, branchQuery(path, archivedBranch))).statusCode).toBe(404);
    const expected = await ctx.db.select({ id: branch.id }).from(branch)
      .where(and(eq(branch.operatorId, operatorId), isNull(branch.archivedAt)));
    expect(response.json().branches.map((entry: { id: string }) => entry.id).sort())
      .toEqual(expected.map((entry) => entry.id).sort());
  });
});

describe.each(datedPaths)('SCRUM-636 %s bounded calendar contract', (path) => {
  it('FINDING R8 medium: require real, ordered dates and at most 31 inclusive days; reject ambiguous or extra query fields', async () => {
    for (const query of [
      '', '?from=2026-10-01', '?to=2026-10-02',
      '?from=2026-02-29&to=2026-03-01', '?from=2026-02-30&to=2026-03-01',
      '?from=2026-10-02&to=2026-10-01', '?from=2026-10-01&to=2026-11-01',
      '?from=2026-10-01&from=2026-10-02&to=2026-10-02',
      `?from=2026-10-01&to=2026-10-02&operatorId=${foreignOperator}`,
    ]) {
      expect((await read(path, query)).statusCode, query).toBe(400);
    }
  });

  it('FINDING R9 medium: accept both a real leap day and the exact 31-day boundary with a typed explicit period', async () => {
    for (const period of [
      { from: '2024-02-29', to: '2024-02-29' },
      { from: '2026-10-01', to: '2026-10-31' },
    ]) {
      const response = await read(path, `?from=${period.from}&to=${period.to}`);
      expect(response.statusCode).toBe(200);
      expect(response.json().period).toEqual(period);
    }
  });
});

describe('SCRUM-636 current fleet contract', () => {
  it('FINDING R10 medium: fleet is a current snapshot and must refuse historical date filters', async () => {
    const response = await read('/aggregates/fleet');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.basis).toBe('current-snapshot');
    expect(Number.isFinite(Date.parse(body.asOf))).toBe(true);
    expect(Object.keys(body.totals).sort()).toEqual(['boxes', 'disabled', 'offline', 'online', 'unclaimed']);
    for (const value of Object.values(body.totals)) expect(Number.isSafeInteger(value)).toBe(true);
    expect(body.parks[0]).toEqual({ branchId: chalong, ...body.totals });
    expect((await read('/aggregates/fleet', '?from=2026-10-01&to=2026-10-02')).statusCode).toBe(400);
  });
});

describe.each(datedPaths)('SCRUM-636 %s accepted calendar formatting', path => {
  it('FINDING R11 medium: preserve four-digit years on every dense row accepted by the date contract', async () => {
    const response = await read(path, '?from=0100-01-01&to=0100-01-01');
    expect(response.statusCode).toBe(200);
    expect(response.json().parks[0].rows[0].date).toBe('0100-01-01');
  });
});

describe.each(['/aggregates/assistant-usage', '/aggregates/inbox-ai-usage'] as const)(
  'SCRUM-636 %s operator-wide bucket authority', (path) => {
    it('FINDING R11 high: only an unfiltered genuine operator grant may expose the separate unassigned bucket', async () => {
      await grant('operator', [operatorId]);
      const response = await read(path);
      expect(response.statusCode).toBe(200);
      const bucket = response.json().operatorWide;
      expect(bucket).not.toBeNull();
      expect(Object.keys(bucket).sort()).toEqual(['rows', 'totals']);
      expect(bucket.rows.map((row: { date: string }) => row.date)).toEqual(['2026-10-01', '2026-10-02']);
      expect(Object.keys(bucket.totals).sort()).toEqual(['cacheReadTokens', 'count', 'inputTokens', 'outputTokens', 'totalTokens']);
    });

    it('FINDING R12 high: a union covering every live owned park must not become operator-wide authority', async () => {
      const live = await ctx.db.select({ id: branch.id }).from(branch)
        .where(and(eq(branch.operatorId, operatorId), isNull(branch.archivedAt)));
      await grant('branch', live.map(park => park.id));
      const response = await read(path);
      expect(response.statusCode).toBe(200);
      expect(response.json().selectedBranchIds.sort()).toEqual(live.map(park => park.id).sort());
      expect(response.json().operatorWide).toBeNull();
    });

    it('FINDING R13 high: explicitly selecting a park must hide the unassigned bucket even under an operator grant', async () => {
      await grant('operator', [operatorId]);
      const response = await read(path, branchQuery(path, chalong));
      expect(response.statusCode).toBe(200);
      expect(response.json().selectedBranchIds).toEqual([chalong]);
      expect(response.json().operatorWide).toBeNull();
    });
  },
);

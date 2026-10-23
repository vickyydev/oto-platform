import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema as s } from '@oto/db';
import { syncInboxSetup } from '@oto/db/seed';
import { newId } from '@oto/shared';
import { pickRule } from '../src/services/inbox/router';
import {
  ADMIN, BRANCH_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN,
  createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

/**
 * SCRUM-626 independent review of the acting-user management seam.
 *
 * New-route 404s before this story mean NOT BUILT, not an existing data defect.
 * Each pin states the failure it prevents and its prescribed fix. Confirmed
 * implementation findings stay it.fails until corrected; no engine is changed.
 * The database belongs to this file and every synthetic record says ZZ TEST.
 */
let ctx: TestContext;
let admin: string, manager: string, counter: string;
let operatorId: string, foreignOperator: string, managerId: string, administratorId: string;
let foreignAccount: string, roleId: string, globalTeam: string, foreignTeam: string;
let seatedPark: string, foreignPark: string;
let accountSequence = 0;

interface TeamView {
  id: string; key: string; name: string; colour: string; sortOrder: number;
  branchId: string | null; branchName: string | null;
  departmentId: string | null; departmentName: string | null;
  createdAt: string; updatedAt: string;
}
interface RuleView {
  id: string; teamId: string; teamName: string | null; category: string;
  language: string | null; branchId: string | null; branchName: string | null;
  primaryKind: string; primaryAccountId: string | null; primaryAccountName: string | null;
  backupAccountId: string | null; backupAccountName: string | null;
  autoAddBackup: boolean; priority: number; active: boolean; archivedAt: string | null;
  createdAt: string; updatedAt: string;
}
interface TeamsAnswer {
  teams: TeamView[]; operatorWide: boolean;
  branches: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string; branchId: string | null }>;
  accounts: Array<{ id: string; displayName: string; status: string }>;
  teamReferences: Array<{ id: string; key: string; name: string; branchId: string | null }>;
}
type RuleRow = typeof s.routingRule.$inferSelect;

const read = (path: string, cookie = admin) => ctx.app.inject({ method: 'GET', url: path, headers: { cookie } });
const write = (method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: Record<string, unknown>, cookie = admin, key = newId()) =>
  ctx.app.inject({ method, url: path, headers: { cookie, 'idempotency-key': key }, ...(body === undefined ? {} : { payload: body }) });
const teamRow = async (id: string) => (await ctx.db.select().from(s.team).where(eq(s.team.id, id)))[0];
const ruleRow = async (id: string) => (await ctx.db.select().from(s.routingRule).where(eq(s.routingRule.id, id)))[0];
const trail = (id: string, action: string) => ctx.db.select().from(s.auditLog).where(and(eq(s.auditLog.entityId, id), eq(s.auditLog.action, action)));

async function park(label: string, owner = operatorId) {
  const id = newId();
  await ctx.db.insert(s.branch).values({ id, operatorId: owner, code: 'zz-626-' + id, name: 'ZZ TEST ' + label });
  return id;
}
async function department(label: string, branchId: string | null, owner = operatorId) {
  const id = newId();
  await ctx.db.insert(s.department).values({ id, operatorId: owner, branchId, name: 'ZZ TEST ' + label });
  return id;
}
async function desk(label: string, branchId: string, owner = operatorId, departmentId: string | null = null) {
  const id = newId();
  await ctx.db.insert(s.team).values({ id, operatorId: owner, key: 'reception', branchId, departmentId, name: 'ZZ TEST ' + label, colour: 'sky', sortOrder: 20 });
  return id;
}
async function person(label: string, owner = operatorId, employeeOwner = owner) {
  const id = newId(), employeeId = newId();
  await ctx.db.insert(s.employee).values({ id: employeeId, operatorId: employeeOwner, name: 'ZZ TEST ' + label });
  await ctx.db.insert(s.account).values({ id, operatorId: owner, employeeId, phone: '+66896' + String(++accountSequence).padStart(6, '0'), status: 'active' });
  return { id, employeeId };
}
async function grant(scopeId: string | null) {
  const id = newId();
  await ctx.db.insert(s.roleAssignment).values({ id, roleId, accountId: managerId, scopeType: scopeId === null ? 'operator' : 'branch', scopeId: scopeId ?? operatorId });
  return id;
}
async function directRule(teamId: string, branchId: string | null, extra: Partial<RuleRow> = {}) {
  const id = newId();
  await ctx.db.insert(s.routingRule).values({ id, operatorId, teamId, category: 'general', branchId, primaryKind: 'team', ...extra });
  return id;
}
const teamInput = (branchId: string, extra: Record<string, unknown> = {}) => ({ key: 'reception', branchId, name: 'ZZ TEST New routing desk', colour: 'sky', ...extra });
const ruleInput = (teamId: string, branchId: string | null, extra: Record<string, unknown> = {}) => ({ teamId, category: 'general', branchId, primaryKind: 'team', ...extra });
async function newRule(branchId: string | null, extra: Record<string, unknown> = {}, teamId = globalTeam) {
  const response = await write('POST', '/inbox/routing-rules', ruleInput(teamId, branchId, extra));
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ rule: RuleView }>().rule;
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  counter = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const own = (await read('/me')).json(), seated = (await read('/me', manager)).json();
  const [outside] = await ctx.db.select().from(s.account).where(eq(s.account.phone, SECOND_OPERATOR_ADMIN.phone));
  operatorId = own.account.operatorId; administratorId = own.account.id; managerId = seated.account.id; seatedPark = seated.branch.id;
  foreignOperator = outside!.operatorId; foreignAccount = outside!.id;
  foreignPark = await park('Foreign routing park', foreignOperator);
  foreignTeam = await desk('Foreign routing team', foreignPark, foreignOperator);
  const [shared] = await ctx.db.select().from(s.team).where(and(eq(s.team.operatorId, operatorId), eq(s.team.key, 'birthdays'), isNull(s.team.branchId)));
  globalTeam = shared!.id;
  roleId = newId();
  await ctx.db.insert(s.role).values({ id: roleId, operatorId, name: 'ZZ TEST Routing review grant' });
  await ctx.db.insert(s.rolePermission).values({ id: newId(), roleId, permission: 'inbox:routing:manage' });
}, 180_000);

afterEach(async () => { await ctx.db.delete(s.roleAssignment).where(eq(s.roleAssignment.roleId, roleId)); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-626 acting-user routing review', () => {
  it('R1 [high] reads typed owned metadata without seed or mutation; fix: expose the existing model through read-only owned joins', async () => {
    const before = await Promise.all([ctx.db.select().from(s.team), ctx.db.select().from(s.routingRule)]);
    const response = await read('/inbox/teams'), rules = await read('/inbox/routing-rules');
    expect(response.statusCode, response.body).toBe(200); expect(rules.statusCode, rules.body).toBe(200);
    const body = response.json<TeamsAnswer>();
    expect(body.operatorWide).toBe(true); expect(body.teams.some(t => t.id === globalTeam)).toBe(true);
    expect(body.accounts.some(a => a.id === administratorId)).toBe(true);
    expect(body.branches.some(b => b.id === foreignPark)).toBe(false);
    expect(body.teamReferences.some(t => t.id === foreignTeam)).toBe(false);
    expect(body.accounts.some(a => a.id === foreignAccount)).toBe(false);
    expect(response.body).not.toMatch(/passwordHash|phone|email|credential|sessionToken/);
    expect(await Promise.all([ctx.db.select().from(s.team), ctx.db.select().from(s.routingRule)])).toEqual(before);
  });

  it('R2 [critical] filters by actual grant reach instead of seating or a directory grant; fix: return only editable park rows and minimal global team references', async () => {
    const allowed = await park('Unseated reachable park'), other = await park('Unreachable sibling');
    const a = await desk('Allowed editable desk', allowed), b = await desk('Unreachable editable desk', other);
    await directRule(globalTeam, allowed); await directRule(globalTeam, other); await grant(allowed);
    expect(allowed).not.toBe(seatedPark);
    const listed = await read('/inbox/teams', manager), rules = await read('/inbox/routing-rules', manager);
    expect(listed.statusCode, listed.body).toBe(200); expect(rules.statusCode, rules.body).toBe(200);
    const body = listed.json<TeamsAnswer>();
    expect(body.operatorWide).toBe(false); expect(body.branches.map(x => x.id)).toEqual([allowed]);
    expect(body.teams.map(x => x.id)).toEqual([a]);
    expect(body.teams.some(x => x.id === globalTeam || x.id === b)).toBe(false);
    const ref = body.teamReferences.find(x => x.id === globalTeam)!;
    expect(ref).toMatchObject({ id: globalTeam, branchId: null });
    expect(Object.keys(ref).sort()).toEqual(['branchId', 'id', 'key', 'name']);
    expect(rules.json<{ rules: RuleView[] }>().rules.every(x => x.branchId === allowed)).toBe(true);
  });

  it('R3 [critical] never turns a session, department or record grant into routing authority; fix: require an actual operator/branch routing grant', async () => {
    for (const path of ['/inbox/teams', '/inbox/routing-rules']) {
      expect((await ctx.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
      expect((await read(path, counter)).statusCode).toBe(403);
    }
    const dept = await department('Grant does not become park', seatedPark);
    for (const scopeType of ['department', 'record'] as const) {
      const assignmentId = newId();
      await ctx.db.insert(s.roleAssignment).values({ id: assignmentId, roleId, accountId: managerId, scopeType, scopeId: scopeType === 'department' ? dept : globalTeam });
      expect((await read('/inbox/teams', manager)).statusCode).toBe(403);
      expect((await read('/inbox/routing-rules', manager)).statusCode).toBe(403);
      await ctx.db.delete(s.roleAssignment).where(eq(s.roleAssignment.id, assignmentId));
    }
  });

  it('R4 [high] creates and edits native team fields atomically; fix: keep identity immutable and commit one success audit per change', async () => {
    const branchId = await park('Team editor'), dept = await department('Team department', branchId), id = newId();
    const made = await write('POST', '/inbox/teams', teamInput(branchId, { id, departmentId: dept, name: '  ZZ TEST Trimmed team  ', colour: '  violet  ', sortOrder: -12 }));
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json<{ team: TeamView }>().team).toMatchObject({ id, name: 'ZZ TEST Trimmed team', colour: 'violet', sortOrder: -12, departmentId: dept, branchId });
    const changed = await write('PATCH', '/inbox/teams/' + id, { name: 'ZZ TEST Changed team', colour: 'pink', sortOrder: 9, departmentId: null });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await teamRow(id)).toMatchObject({ key: 'reception', branchId, name: 'ZZ TEST Changed team', colour: 'pink', sortOrder: 9, departmentId: null });
    expect(await trail(id, 'inbox.team.create')).toHaveLength(1); expect(await trail(id, 'inbox.team.update')).toHaveLength(1);
  });

  it('R5 [critical] keeps global teams operator-wide and park writes at the named park; fix: use explicit branch/operator targets before saving', async () => {
    const own = await park('Granted desk'), sibling = await park('Refused desk'); await grant(own);
    const response = await write('POST', '/inbox/teams', teamInput(own), manager);
    expect(response.statusCode, response.body).toBe(200);
    expect((await write('POST', '/inbox/teams', teamInput(sibling), manager)).statusCode).toBe(403);
    expect((await write('POST', '/inbox/teams', { key: 'marketing', branchId: null, name: 'ZZ TEST Global denied', colour: 'pink' }, manager)).statusCode).toBe(403);
    expect((await write('PATCH', '/inbox/teams/' + globalTeam, { name: 'ZZ TEST Global denied' }, manager)).statusCode).toBe(403);
    expect((await write('POST', '/inbox/teams', teamInput(foreignPark))).statusCode).toBe(404);
  });

  it('R6 [high] refuses unknown/identity fields and duplicate canonical teams; fix: retain strict Zod and immutable key/branch semantics', async () => {
    const branchId = await park('Strict team'), id = await desk('Strict team', branchId), before = await teamRow(id);
    for (const body of [{ key: 'marketing' }, { branchId: foreignPark }, { id: newId() }, { name: '' }, { sortOrder: 1.5 }, { archivedAt: new Date().toISOString() }]) {
      expect((await write('PATCH', '/inbox/teams/' + id, body)).statusCode).toBe(400);
    }
    const duplicate = await write('POST', '/inbox/teams', teamInput(branchId));
    expect(duplicate.statusCode).toBe(409); expect(duplicate.json().error.code).toBe('INBOX_TEAM_EXISTS');
    expect(await teamRow(id)).toEqual(before); expect(await trail(id, 'inbox.team.update')).toHaveLength(0);
  });

  it('R7 [critical] treats the soft department as an owned authority link; fix: reject foreign/sibling departments and preserve valid global links', async () => {
    const branchId = await park('Department fence'), sibling = await park('Department sibling'), id = await desk('Department fence', branchId);
    const foreign = await department('Foreign private department', foreignPark, foreignOperator), siblingDept = await department('Sibling department', sibling), wide = await department('Shared department', null);
    for (const departmentId of [foreign, siblingDept, newId()]) expect((await write('PATCH', '/inbox/teams/' + id, { departmentId })).statusCode).toBe(404);
    const changed = await write('PATCH', '/inbox/teams/' + id, { departmentId: wide }); expect(changed.statusCode, changed.body).toBe(200);
    expect((await teamRow(id))?.departmentId).toBe(wide);
    expect((await write('PATCH', '/inbox/teams/' + globalTeam, { departmentId: siblingDept })).statusCode).toBe(404);
  });

  it('R8 [critical] hides corrupt foreign park and soft-department labels on reads; fix: tenant-fence joins and null unsafe optional IDs', async () => {
    const branchId = await park('Safe metadata'), foreignDept = await department('Foreign secret department label', foreignPark, foreignOperator);
    const id = await desk('Safe metadata', branchId, operatorId, foreignDept), corrupt = await desk('Foreign park attachment', foreignPark);
    const listed = await read('/inbox/teams'); expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json<TeamsAnswer>();
    expect(body.teams.find(x => x.id === id)).toMatchObject({ departmentId: null, departmentName: null });
    expect(body.teams.some(x => x.id === corrupt)).toBe(false);
    expect(listed.body).not.toContain('ZZ TEST Foreign secret department label'); expect(listed.body).not.toContain(foreignDept);
  });

  it('R9 [high] stores signed-priority rules and explicit primary/backup fields; fix: expose existing fields without inventing routing eligibility', async () => {
    const branchId = await park('Rule fields'), primary = await person('Rule primary'), backup = await person('Rule backup');
    const made = await newRule(branchId, { category: 'birthdays', language: '  RU  ', primaryKind: 'account', primaryAccountId: primary.id, backupAccountId: backup.id, priority: -10, autoAddBackup: false });
    expect(made).toMatchObject({ category: 'birthdays', language: 'RU', branchId, primaryKind: 'account', primaryAccountId: primary.id, backupAccountId: backup.id, priority: -10, autoAddBackup: false, active: true, archivedAt: null });
    expect(made.primaryAccountName).toBe('ZZ TEST Rule primary'); expect(made.backupAccountName).toBe('ZZ TEST Rule backup');
    expect(await trail(made.id, 'inbox.routing_rule.create')).toHaveLength(1);
  });

  it('R10 [critical] allows a reachable park rule with a minimal global team but refuses wildcard/other-park authority; fix: check actual rule and referenced-team targets', async () => {
    const own = await park('Rule grant'), sibling = await park('Rule sibling'), siblingTeam = await desk('Sibling target', sibling); await grant(own);
    const accepted = await write('POST', '/inbox/routing-rules', ruleInput(globalTeam, own), manager);
    expect(accepted.statusCode, accepted.body).toBe(200);
    for (const body of [ruleInput(globalTeam, null), ruleInput(globalTeam, sibling), ruleInput(siblingTeam, own)]) {
      expect((await write('POST', '/inbox/routing-rules', body, manager)).statusCode).toBe(403);
    }
    expect((await write('POST', '/inbox/routing-rules', ruleInput(globalTeam, foreignPark))).statusCode).toBe(404);
  });

  it('R11 [critical] checks old and new park/null targets in both directions; fix: lock the old rule and authorize the merged destination before a move', async () => {
    const own = await park('Move grant'), sibling = await park('Move other'), a = await newRule(own), b = await newRule(sibling), wide = await newRule(null); await grant(own);
    for (const [id, branchId] of [[a.id, sibling], [b.id, own], [a.id, null], [wide.id, own]] as const) {
      const before = await ruleRow(id);
      expect((await write('PATCH', '/inbox/routing-rules/' + id, { branchId }, manager)).statusCode).toBe(403);
      expect(await ruleRow(id)).toEqual(before);
    }
    const secondGrant = await grant(sibling);
    expect((await write('PATCH', '/inbox/routing-rules/' + a.id, { branchId: sibling }, manager)).statusCode).toBe(200);
    expect((await write('PATCH', '/inbox/routing-rules/' + a.id, { branchId: own }, manager)).statusCode).toBe(200);
    await ctx.db.delete(s.roleAssignment).where(eq(s.roleAssignment.id, secondGrant));
    expect((await write('PATCH', '/inbox/routing-rules/' + a.id, { branchId: null })).statusCode).toBe(200);
    expect((await write('PATCH', '/inbox/routing-rules/' + a.id, { branchId: own })).statusCode).toBe(200);
    expect((await ruleRow(a.id))?.createdAt.toISOString()).toBe(a.createdAt);
  });

  it('R12 [high] validates the merged person/backup shape rather than isolated PATCH fields; fix: refuse invalid combinations without partial changes', async () => {
    const branchId = await park('Merged rule'), personId = (await person('Merged primary')).id;
    const made = await newRule(branchId, { primaryKind: 'account', primaryAccountId: personId });
    for (const body of [{ primaryKind: 'team' }, { primaryAccountId: null }, { backupAccountId: personId }, { priority: 2147483648 }, { language: '' }, { createdAt: new Date().toISOString() }]) {
      const before = await ruleRow(made.id);
      expect((await write('PATCH', '/inbox/routing-rules/' + made.id, body)).statusCode).toBe(400);
      expect(await ruleRow(made.id)).toEqual(before);
    }
    expect((await write('PATCH', '/inbox/routing-rules/' + made.id, { primaryKind: 'team', primaryAccountId: null, language: null, backupAccountId: personId })).statusCode).toBe(200);
  });

  it('R13 [critical] refuses foreign reference IDs without returning labels or writing rules; fix: fence team, branch and each account by owning operator', async () => {
    const branchId = await park('Reference fence');
    const bodies = [
      { body: ruleInput(foreignTeam, branchId), code: 'INBOX_TEAM_NOT_FOUND' },
      { body: ruleInput(globalTeam, foreignPark), code: 'INBOX_ROUTING_REFERENCE_NOT_FOUND' },
      { body: ruleInput(globalTeam, branchId, { primaryKind: 'account', primaryAccountId: foreignAccount }), code: 'INBOX_ROUTING_REFERENCE_NOT_FOUND' },
      { body: ruleInput(globalTeam, branchId, { backupAccountId: foreignAccount }), code: 'INBOX_ROUTING_REFERENCE_NOT_FOUND' },
    ];
    for (const { body, code } of bodies) {
      const id = newId(), response = await write('POST', '/inbox/routing-rules', { ...body, id });
      expect(response.statusCode).toBe(404); expect(response.json().error.code).toBe(code);
      expect(response.body).not.toContain('ZZ TEST Foreign routing'); expect(await ruleRow(id)).toBeUndefined();
      expect(await trail(id, 'inbox.routing_rule.create')).toHaveLength(0);
    }
  });

  it('R14 [critical] projects only owned person IDs and employee labels; fix: null foreign account references and use a safe fallback for corrupt employee joins', async () => {
    const branchId = await park('Label fence'), owned = await person('Foreign employee label must stay private', operatorId, foreignOperator);
    const corrupt = await directRule(globalTeam, branchId, { primaryKind: 'account', primaryAccountId: foreignAccount, backupAccountId: owned.id });
    const response = await read('/inbox/routing-rules'); expect(response.statusCode, response.body).toBe(200);
    const row = response.json<{ rules: RuleView[] }>().rules.find(x => x.id === corrupt)!;
    expect(row).toMatchObject({ primaryAccountId: null, primaryAccountName: null, backupAccountId: owned.id, backupAccountName: 'Account ' + owned.id.slice(0, 8) });
    expect(response.body).not.toContain('ZZ TEST Foreign employee label must stay private');
    const options = await read('/inbox/teams'); expect(options.statusCode, options.body).toBe(200);
    expect(options.json<TeamsAnswer>().accounts.find(x => x.id === owned.id)?.displayName).toBe('Account ' + owned.id.slice(0, 8));
    expect(options.body).not.toContain('ZZ TEST Foreign employee label must stay private');
  });

  it('R15 [high] refuses team deletion clearly once per idempotent attempt and never deletes; fix: preserve canonical team identity under the Q10 ruling', async () => {
    const branchId = await park('Deletion refusal'), id = await desk('Deletion refusal', branchId), key = newId(), before = await teamRow(id);
    const first = await write('DELETE', '/inbox/teams/' + id, undefined, admin, key), replay = await write('DELETE', '/inbox/teams/' + id, undefined, admin, key);
    expect(first.statusCode).toBe(409); expect(first.json().error.code).toBe('INBOX_TEAM_DELETE_REFUSED');
    expect(first.json().error.message).toBe('Teams cannot be deleted. Edit the team or archive its routing rules instead.');
    expect(replay.statusCode).toBe(409); expect(replay.json()).toEqual(first.json()); expect(replay.headers['x-oto-replay']).toBe('true');
    expect(await teamRow(id)).toEqual(before);
    const refusals = await ctx.db.select().from(s.auditLog).where(and(eq(s.auditLog.action, 'inbox.team.delete.failed'), eq(s.auditLog.actorAccountId, administratorId)));
    expect(refusals).toHaveLength(1);
    await grant(branchId);
    expect((await write('DELETE', '/inbox/teams/' + globalTeam, undefined, manager)).statusCode).toBe(403);
    expect((await write('DELETE', '/inbox/teams/' + foreignTeam)).statusCode).toBe(404);
  });

  it('R16 [high] archives rules without changing existing ownership or reseeding; fix: retain the existing row as the sync tombstone and preserve conversations', async () => {
    const branchId = await park('Archive history'), teamId = await desk('Archive history', branchId), dept = await department('Preserved edit', branchId);
    const made = await newRule(branchId, { priority: -10, language: null }, teamId), contactId = newId(), channelId = newId(), conversationId = newId(), assignmentId = newId();
    await ctx.db.insert(s.contact).values({ id: contactId, operatorId, channel: 'telegram', externalHandle: 'ZZ TEST ' + newId() });
    await ctx.db.insert(s.channelAccount).values({ id: channelId, operatorId, branchId, channel: 'telegram', provider: 'console', canReply: false, externalId: 'ZZ TEST ' + newId(), displayName: 'ZZ TEST Archive channel' });
    await ctx.db.insert(s.conversation).values({ id: conversationId, operatorId, contactId, channelAccountId: channelId, teamId, branchId });
    await ctx.db.insert(s.assignment).values({ id: assignmentId, operatorId, conversationId, slot: 'primary', slotIndex: 0, assigneeKind: 'team', teamId, assignedByKind: 'system', reason: 'auto' });
    const before = await Promise.all([ctx.db.select().from(s.conversation).where(eq(s.conversation.id, conversationId)), ctx.db.select().from(s.assignment).where(eq(s.assignment.id, assignmentId))]);
    expect((await write('PATCH', '/inbox/teams/' + teamId, { name: 'ZZ TEST Preserved team edit', colour: 'violet', sortOrder: -31, departmentId: dept })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await write('DELETE', '/inbox/routing-rules/' + made.id);
      expect(response.statusCode, response.body).toBe(200); expect(response.json()).toEqual({ ok: true });
    }
    const archived = await ruleRow(made.id); expect(archived?.active).toBe(false); expect(archived?.archivedAt).toBeInstanceOf(Date);
    expect(await trail(made.id, 'inbox.routing_rule.archive')).toHaveLength(1);
    await syncInboxSetup(ctx.db);
    const after = await ctx.db.select().from(s.routingRule).where(eq(s.routingRule.teamId, teamId));
    expect(after).toHaveLength(1); expect(after[0]).toEqual(archived);
    expect(await teamRow(teamId)).toMatchObject({ name: 'ZZ TEST Preserved team edit', colour: 'violet', sortOrder: -31, departmentId: dept });
    expect(await Promise.all([ctx.db.select().from(s.conversation).where(eq(s.conversation.id, conversationId)), ctx.db.select().from(s.assignment).where(eq(s.assignment.id, assignmentId))])).toEqual(before);
  });

  it('R17 [high] lists archived history but refuses edits to it; fix: retain archive identity and require a separate new rule', async () => {
    const branchId = await park('Archived editor'), made = await newRule(branchId);
    expect((await write('DELETE', '/inbox/routing-rules/' + made.id)).statusCode).toBe(200);
    const before = await ruleRow(made.id), response = await write('PATCH', '/inbox/routing-rules/' + made.id, { active: true });
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('INBOX_ROUTING_RULE_ARCHIVED');
    expect(await ruleRow(made.id)).toEqual(before); expect(await trail(made.id, 'inbox.routing_rule.update')).toHaveLength(0);
    const listed = await read('/inbox/routing-rules'); expect(listed.statusCode).toBe(200);
    expect(listed.json<{ rules: RuleView[] }>().rules.find(x => x.id === made.id)).toMatchObject({ active: false, archivedAt: before?.archivedAt?.toISOString() });
  });

  it('R18 [high] honors a caller-named team ID across fresh header keys; fix: replay the same canonical record without another create audit', async () => {
    const branchId = await park('Body team replay'), id = newId(), body = teamInput(branchId, { id });
    const first = await write('POST', '/inbox/teams', body), replay = await write('POST', '/inbox/teams', { ...body, name: 'ZZ TEST Ignored replay rename' });
    expect(first.statusCode, first.body).toBe(200); expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true'); expect(replay.json()).toEqual(first.json());
    expect(await trail(id, 'inbox.team.create')).toHaveLength(1); expect((await teamRow(id))?.name).toBe(body.name);
  });

  it('R19 [high] honors a caller-named rule ID across fresh header keys; fix: replay only its original operator/team/branch parent', async () => {
    const branchId = await park('Body rule replay'), id = newId(), body = ruleInput(globalTeam, branchId, { id, priority: -10 });
    const first = await write('POST', '/inbox/routing-rules', body), replay = await write('POST', '/inbox/routing-rules', { ...body, priority: 81 });
    expect(first.statusCode, first.body).toBe(200); expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true'); expect(replay.json()).toEqual(first.json());
    expect(await trail(id, 'inbox.routing_rule.create')).toHaveLength(1); expect((await ruleRow(id))?.priority).toBe(-10);
  });

  it('R20 [critical] refuses foreign or different-parent body IDs without leaking rows; fix: use claimClientId ownership and parent checks before replay', async () => {
    const a = await park('ID parent one'), b = await park('ID parent two'), ownTeam = await desk('ID parent one', a);
    const foreignRule = await directRule(foreignTeam, foreignPark, { operatorId: foreignOperator }), ownRule = await directRule(globalTeam, a);
    for (const [path, body] of [
      ['/inbox/teams', teamInput(b, { id: foreignTeam })], ['/inbox/teams', teamInput(b, { id: ownTeam })],
      ['/inbox/routing-rules', ruleInput(globalTeam, b, { id: foreignRule })], ['/inbox/routing-rules', ruleInput(globalTeam, b, { id: ownRule })],
    ] as const) {
      const response = await write('POST', path, body);
      expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('ID_IN_USE');
      expect(response.body).not.toContain('ZZ TEST Foreign routing');
    }
    expect((await ruleRow(ownRule))?.branchId).toBe(a); expect((await teamRow(ownTeam))?.branchId).toBe(a);
  });

  it('R21 [critical] revocation beats a globally stored create replay; fix: recheck actual body and existing targets in preValidation before idempotency preHandler', async () => {
    const branchId = await park('Revoked create'), assignmentId = await grant(branchId), teamId = newId(), ruleId = newId();
    // A second valid routing grant remains: an any-scope guard is insufficient.
    await grant(await park('Remaining create routing reach'));
    const requests = [
      { path: '/inbox/teams', body: teamInput(branchId, { id: teamId }), key: newId() },
      { path: '/inbox/routing-rules', body: ruleInput(globalTeam, branchId, { id: ruleId }), key: newId() },
    ];
    for (const request of requests) expect((await write('POST', request.path, request.body, manager, request.key)).statusCode).toBe(200);
    await ctx.db.delete(s.roleAssignment).where(eq(s.roleAssignment.id, assignmentId));
    for (const request of requests) {
      const refused = await write('POST', request.path, request.body, manager, request.key);
      expect(refused.statusCode).toBe(403); expect(refused.headers['x-oto-replay']).toBeUndefined();
    }
    expect(await trail(teamId, 'inbox.team.create')).toHaveLength(1); expect(await trail(ruleId, 'inbox.routing_rule.create')).toHaveLength(1);
  });

  it('R22 [critical] revocation beats stored PATCH, archive and team-refusal replays; fix: authorize each path row before replaying any cached response', async () => {
    const branchId = await park('Revoked path'), teamId = await desk('Revoked path', branchId), rule = await newRule(branchId), assignmentId = await grant(branchId);
    await grant(await park('Remaining path routing reach'));
    const requests = [
      { method: 'PATCH' as const, path: '/inbox/teams/' + teamId, body: { name: 'ZZ TEST Revoked path change' }, key: newId(), status: 200 },
      { method: 'PATCH' as const, path: '/inbox/routing-rules/' + rule.id, body: { priority: 26 }, key: newId(), status: 200 },
      { method: 'DELETE' as const, path: '/inbox/routing-rules/' + rule.id, body: undefined, key: newId(), status: 200 },
      { method: 'DELETE' as const, path: '/inbox/teams/' + teamId, body: undefined, key: newId(), status: 409 },
    ];
    for (const request of requests) expect((await write(request.method, request.path, request.body, manager, request.key)).statusCode).toBe(request.status);
    await ctx.db.delete(s.roleAssignment).where(eq(s.roleAssignment.id, assignmentId));
    for (const request of requests) expect((await write(request.method, request.path, request.body, manager, request.key)).statusCode).toBe(403);
  });

  it('R23 [high] replays exact header retries but rejects different payloads; fix: store the whole envelope once in the ordinary transaction', async () => {
    const branchId = await park('Header rule replay'), id = newId(), key = newId(), body = ruleInput(globalTeam, branchId, { id, priority: 7 });
    const first = await write('POST', '/inbox/routing-rules', body, admin, key), replay = await write('POST', '/inbox/routing-rules', body, admin, key);
    expect(first.statusCode, first.body).toBe(200); expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(first.json());
    expect(replay.headers['x-oto-replay']).toBe('true'); expect(await trail(id, 'inbox.routing_rule.create')).toHaveLength(1);
    const mismatch = await write('POST', '/inbox/routing-rules', { ...body, priority: 8 }, admin, key);
    expect(mismatch.statusCode).toBe(409); expect(mismatch.json().error.code).toBe('IDEMPOTENCY_MISMATCH'); expect((await ruleRow(id))?.priority).toBe(7);
  });

  it('R24 [critical] rolls back a team or rule when its success audit fails and permits the same-key retry; fix: keep row, audit and stored response in one transaction', async () => {
    const branchId = await park('Audit rollback'), teamId = newId(), ruleId = newId();
    await ctx.db.execute(sql`create function core.zz_test_626_refuse_audit() returns trigger language plpgsql as $$ begin if NEW.action in ('inbox.team.create', 'inbox.routing_rule.create') then raise exception 'ZZ TEST controlled audit refusal'; end if; return NEW; end $$`);
    await ctx.db.execute(sql`create trigger zz_test_626_refuse_audit before insert on core.audit_log for each row execute function core.zz_test_626_refuse_audit()`);
    const requests = [
      { path: '/inbox/teams', body: teamInput(branchId, { id: teamId }), key: newId() },
      { path: '/inbox/routing-rules', body: ruleInput(globalTeam, branchId, { id: ruleId }), key: newId() },
    ];
    try {
      for (const request of requests) {
        expect((await write('POST', request.path, request.body, admin, request.key)).statusCode).toBe(500);
        expect(await ctx.db.select().from(s.idempotencyKey).where(and(eq(s.idempotencyKey.accountId, administratorId), eq(s.idempotencyKey.key, request.key)))).toHaveLength(0);
      }
      expect(await teamRow(teamId)).toBeUndefined(); expect(await ruleRow(ruleId)).toBeUndefined();
      expect(await trail(teamId, 'inbox.team.create')).toHaveLength(0); expect(await trail(ruleId, 'inbox.routing_rule.create')).toHaveLength(0);
    } finally {
      await ctx.db.execute(sql`drop trigger zz_test_626_refuse_audit on core.audit_log`);
      await ctx.db.execute(sql`drop function core.zz_test_626_refuse_audit()`);
    }
    for (const request of requests) expect((await write('POST', request.path, request.body, admin, request.key)).statusCode).toBe(200);
    expect(await trail(teamId, 'inbox.team.create')).toHaveLength(1); expect(await trail(ruleId, 'inbox.routing_rule.create')).toHaveLength(1);
  });

  it('R25 [critical] a fresh header cannot use a body ID to rename or move an unheld original parent; fix: check existing caller-ID scope as well as the submitted destination', async () => {
    const oldPark = await park('Body original parent'), destination = await park('Body proposed parent');
    const oldTeam = await desk('Body original parent', oldPark), oldRule = await directRule(globalTeam, oldPark);
    await grant(destination);
    const teamBefore = await teamRow(oldTeam), ruleBefore = await ruleRow(oldRule);
    const teamAttempt = await write('POST', '/inbox/teams', teamInput(destination, { id: oldTeam }), manager);
    const ruleAttempt = await write('POST', '/inbox/routing-rules', ruleInput(globalTeam, destination, { id: oldRule }), manager);
    expect(teamAttempt.statusCode).toBe(403); expect(ruleAttempt.statusCode).toBe(403);
    expect(await teamRow(oldTeam)).toEqual(teamBefore); expect(await ruleRow(oldRule)).toEqual(ruleBefore);
  });
});

describe('SCRUM-626 existing router law, unchanged engine', () => {
  const row = (id: string, extra: Partial<RuleRow> = {}): RuleRow => ({
    id, operatorId: 'operator', teamId: 'team', category: 'birthdays', language: null, branchId: null,
    primaryKind: 'team', primaryAccountId: null, backupAccountId: null, autoAddBackup: true,
    priority: 0, active: true, archivedAt: null, createdAt: new Date('2000-01-01T00:00:00Z'), updatedAt: new Date('2000-01-01T00:00:00Z'), ...extra,
  });

  it('R26 [high] preserves signed priority, specificity and oldest/id ties; fix: present the existing comparator without re-ranking the engine', () => {
    const question = { category: 'birthdays' as const, language: 'RU', branchId: 'park' };
    const low = row('a', { priority: -10, language: 'ru', branchId: 'park' }), high = row('b', { priority: -1 });
    expect(pickRule([low, high], question)?.id).toBe('b');
    const global = row('global', { priority: 10 }), language = row('language', { priority: 10, language: 'ru' }), both = row('both', { priority: 10, language: 'ru', branchId: 'park' });
    expect(pickRule([global, language, both], question)?.id).toBe('both');
    const older = row('z', { language: 'ru', createdAt: new Date('1999-01-01T00:00:00Z') }), newer = row('a', { branchId: 'park' });
    expect(pickRule([newer, older], question)?.id).toBe('z');
    expect(pickRule([row('z', { language: 'ru' }), row('a', { branchId: 'park' })], question)?.id).toBe('a');
  });

  it('R27 [high] preserves null wildcards, case-insensitive language and inactive/archive exclusion; fix: keep the existing pure matcher and team fallback trigger', () => {
    const wildcard = row('wildcard'), specific = row('specific', { language: 'rU', branchId: 'park' });
    expect(pickRule([wildcard, specific], { category: 'birthdays', language: 'RU', branchId: 'park' })?.id).toBe('specific');
    expect(pickRule([wildcard, specific], { category: 'birthdays', language: 'th', branchId: null })?.id).toBe('wildcard');
    expect(pickRule([row('inactive', { active: false }), row('archived', { archivedAt: new Date() }), row('wrong', { category: 'general' }), specific], { category: 'birthdays', language: 'en', branchId: 'other' })).toBeNull();
  });
});

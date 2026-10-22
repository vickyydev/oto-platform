import { and, eq, or } from 'drizzle-orm';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, benefitCredential, benefitProfile, benefitRoleTemplate, branch, employee, printJob, printTemplate, role, roleAssignment, rolePermission } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, BRANCH_MANAGER, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string, scoped: string, outside: string;
let operatorId: string, park: string, sibling: string, foreignPark: string;
let ownPerson: string, remotePerson: string, unassignedPerson: string, foreignPerson: string, corruptPerson: string;
let ownCredential: string, remoteCredential: string, unassignedCredential: string, foreignCredential: string;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, cookie = admin, key = newId()) {
  return ctx.app.inject({ method, url, headers: { cookie, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
}
const trail = (id: string, action: string) => ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));
async function issue(employeeId: string, cookie = admin) {
  const result = await request('POST', '/benefits/credentials', { employeeId }, cookie);
  expect(result.statusCode).toBe(200);
  return result.json().credential.id as string;
}
beforeAll(async () => {
  const keys = generateKeyPairSync('ed25519');
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
  await ctx.app.ready();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  scoped = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  outside = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  operatorId = (await request('GET', '/me')).json().account.operatorId as string;
  park = (await request('GET', '/me', undefined, scoped)).json().branch.id as string;
  const otherMe = (await request('GET', '/me', undefined, outside)).json();
  foreignPark = otherMe.branch.id as string;
  sibling = newId();
  await ctx.db.insert(branch).values({ id: sibling, operatorId, code: 'zz-care-' + sibling, name: 'ZZ TEST Care sibling park' });
  const [caller] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  const roleId = newId();
  await ctx.db.insert(role).values({ id: roleId, operatorId, name: 'ZZ TEST Care branch-only reviewer' });
  await ctx.db.insert(rolePermission).values(['pos:checkin:read', 'catalog:package:update', 'admin:benefit:read', 'admin:benefit:manage', 'admin:benefit:credential_issue', 'pos:print:read', 'admin:branch:update'].map(permission => ({ id: newId(), roleId, permission })));
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, caller!.id));
  await ctx.db.insert(roleAssignment).values({ id: newId(), roleId, accountId: caller!.id, scopeType: 'branch', scopeId: park });
  ownPerson = newId(); remotePerson = newId(); unassignedPerson = newId(); foreignPerson = newId(); corruptPerson = newId();
  await ctx.db.insert(employee).values([
    { id: ownPerson, operatorId, branchId: park, name: 'ZZ TEST Care own employee' },
    { id: remotePerson, operatorId, branchId: sibling, name: 'ZZ TEST Care sibling employee' },
    { id: unassignedPerson, operatorId, branchId: null, name: 'ZZ TEST Care unassigned employee' },
    { id: foreignPerson, operatorId: otherMe.account.operatorId as string, branchId: foreignPark, name: 'ZZ TEST Care foreign employee' },
    { id: corruptPerson, operatorId, branchId: foreignPark, name: 'ZZ TEST Care corrupt-reference employee' },
  ]);
  await ctx.db.insert(printTemplate).values({ id: newId(), operatorId: otherMe.account.operatorId as string, branchId: foreignPark, type: 'receipt', name: 'ZZ TEST Care foreign receipt' });
  for (const [id, cookie] of [[ownPerson, admin], [remotePerson, admin], [unassignedPerson, admin], [foreignPerson, outside]] as const) {
    expect((await request('PUT', '/benefits/profiles/' + id, { benefitRole: 'staff', override: null }, cookie)).statusCode).toBe(200);
  }
  ownCredential = await issue(ownPerson); remoteCredential = await issue(remotePerson);
  unassignedCredential = await issue(unassignedPerson); foreignCredential = await issue(foreignPerson, outside);
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-624 independent care and print review', () => {
  it('R1 [high] all four existing care responses describe their actual JSON; fix: add outgoing schemas only, preserving inputs and service behavior', () => {
    const document = ctx.app.swagger();
    for (const [path, verb] of [['/checkin/config', 'get'], ['/checkin/config/pricing', 'put'], ['/checkin/config/policy', 'put'], ['/checkin/config/confirmations', 'put']] as const) {
      const response = document.paths?.[path]?.[verb]?.responses?.['200'];
      expect.soft(Boolean(response && 'content' in response && response.content), verb + ' ' + path).toBe(true);
    }
  });

  it('R2 [high] branch-only benefit grants do not authorize shared template or profile changes; fix: require operator management without narrowing metadata reads', async () => {
    const before = { templates: await ctx.db.select().from(benefitRoleTemplate), profiles: await ctx.db.select().from(benefitProfile) };
    expect.soft((await request('PUT', '/benefits/templates/staff', { profile: { credit: { amountSatang: 23456, period: 'daily' } } }, scoped)).statusCode).toBe(403);
    expect.soft((await request('PUT', '/benefits/profiles/' + ownPerson, { benefitRole: 'manager', override: null }, scoped)).statusCode).toBe(403);
    expect.soft(fingerprint(await ctx.db.select().from(benefitRoleTemplate))).toBe(fingerprint(before.templates));
    expect.soft(fingerprint(await ctx.db.select().from(benefitProfile))).toBe(fingerprint(before.profiles));
    for (const path of ['/benefits/templates', '/benefits/profiles', '/benefits/credentials']) expect((await request('GET', path, undefined, scoped)).statusCode).toBe(200);
  });

  it('R3 [critical] credential issue, QR and revoke target the owned employee park, with operator reach for unassigned staff; fix: resolve before any credential action', async () => {
    const qr = await request('GET', '/benefits/credentials/' + ownCredential + '/qr', undefined, scoped);
    expect(qr.statusCode).toBe(200); expect(qr.headers['cache-control']).toBe('no-store');
    // Compare booleans only: no assertion can print a credential payload.
    expect(typeof qr.json().code === 'string' && qr.json().code.length > 0).toBe(true);
    for (const id of [remoteCredential, unassignedCredential]) {
      const refused = await request('GET', '/benefits/credentials/' + id + '/qr', undefined, scoped);
      expect.soft(refused.statusCode).toBe(403); expect.soft(typeof refused.json().code === 'string').toBe(false);
      expect.soft((await request('POST', '/benefits/credentials/' + id + '/revoke', {}, scoped)).statusCode).toBe(403);
    }
    // These own-operator fixtures are now revoked only on the unfixed baseline.
    // The expected scope refusal must happen before the live-QR business rule.
    for (const employeeId of [remotePerson, unassignedPerson]) expect.soft((await request('POST', '/benefits/credentials', { employeeId }, scoped)).statusCode).toBe(403);
    for (const [method, path, body] of [
      ['GET', '/benefits/credentials/' + foreignCredential + '/qr', undefined],
      ['POST', '/benefits/credentials/' + foreignCredential + '/revoke', {}],
      ['POST', '/benefits/credentials', { employeeId: foreignPerson }],
    ] as const) expect((await request(method, path, body, scoped)).statusCode).toBe(404);
    const key = newId(), ownPath = '/benefits/credentials/' + ownCredential + '/revoke';
    expect((await request('POST', ownPath, {}, scoped, key)).statusCode).toBe(200);
    expect((await request('POST', ownPath, {}, scoped, key)).statusCode).toBe(200);
    expect(await trail(ownCredential, 'benefit.credential_revoke')).toHaveLength(1);
    const rows = await ctx.db.select({ id: benefitCredential.id, revokedAt: benefitCredential.revokedAt }).from(benefitCredential).where(eq(benefitCredential.employeeId, unassignedPerson));
    expect.soft(rows).toHaveLength(1); expect.soft(rows[0]?.revokedAt).toBeNull();
  });

  it('R4 [high] an owned employee cannot expose a foreign park through a corrupt reference; fix: constrain the employee-to-branch projection to its operator', async () => {
    const before = await ctx.db.select().from(employee).where(eq(employee.id, corruptPerson));
    const list = await request('GET', '/benefits/profiles', undefined, scoped);
    expect(list.statusCode).toBe(200);
    const row = list.json().staff.find((person: { employeeId: string }) => person.employeeId === corruptPerson);
    expect(row).toBeDefined(); expect.soft(row.branchId).toBeNull(); expect.soft(row.branchName).toBeNull();
    const detail = await request('GET', '/benefits/profiles/' + corruptPerson);
    expect(detail.statusCode).toBe(200); expect.soft(detail.json().staff.branchId).toBeNull(); expect.soft(detail.json().staff.branchName).toBeNull();
    expect(await ctx.db.select().from(employee).where(eq(employee.id, corruptPerson))).toEqual(before);
    expect((await request('GET', '/benefits/profiles/' + foreignPerson)).statusCode).toBe(404);
  });

  it('R5 [high] care writes retain exact target, satang, policy and one-key audit semantics; fix: preserve the existing per-park write contract', async () => {
    const pricing = { oneTimeFee: { weekday: 12345, weekend: 16789 }, nannyHourly: { weekday: 23456, weekend: 27890 }, extraHour: { weekday: 34567, weekend: 38901 }, fullDayHours: 8, nannyRatioSoftMax: 4, prepaidFoodUnused: 'refund' };
    const path = '/checkin/config/pricing?branchId=' + park, key = newId();
    const pricingTrail = () => ctx.db.select().from(auditLog).where(and(eq(auditLog.branchId, park), or(eq(auditLog.action, 'drop_off_pricing.update'), eq(auditLog.action, 'drop_off_pricing.create'))));
    const beforeAudits = await pricingTrail();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request('PUT', path, pricing, scoped, key);
      expect(response.statusCode).toBe(200); expect(response.json().pricing).toEqual(pricing); expect(response.json().policy).toBeDefined();
    }
    expect(await pricingTrail()).toHaveLength(beforeAudits.length + 1);
    const canonical = await request('GET', '/checkin/config?branchId=' + park, undefined, scoped);
    expect(canonical.statusCode).toBe(200); expect(canonical.json().pricing).toEqual(pricing); expect(Array.isArray(canonical.json().nannies)).toBe(true);
    for (const target of ['pricing', 'policy', 'confirmations']) {
      const body = target === 'pricing' ? pricing : target === 'policy' ? { bands: canonical.json().policy.bands, siblingWaiver: canonical.json().policy.siblingWaiver } : { items: canonical.json().policy.confirmations };
      expect((await request('PUT', '/checkin/config/' + target + '?branchId=' + sibling, body, scoped)).statusCode).toBe(403);
      expect((await request('PUT', '/checkin/config/' + target + '?branchId=' + foreignPark, body)).statusCode).toBe(404);
    }
    expect((await request('GET', '/checkin/config?branchId=' + sibling, undefined, scoped)).statusCode).toBe(403);
    expect((await request('GET', '/checkin/config?branchId=' + foreignPark)).statusCode).toBe(404);
    expect((await request('GET', '/checkin/config?branchId=' + park, undefined, scoped)).json().pricing).toEqual(pricing);
  });

  it('R6 [high] print editing and read-only PNG preview never grant physical-print authority; fix: retain separate resolved-row command permission and replay', async () => {
    const own = await request('GET', '/branches/' + park + '/print-templates', undefined, scoped);
    expect(own.statusCode).toBe(200); const template = own.json().templates[0] as { id: string };
    const foreign = (await request('GET', '/branches/' + foreignPark + '/print-templates', undefined, outside)).json().templates[0] as { id: string };
    const beforeJobs = await ctx.db.select({ id: printJob.id }).from(printJob), key = newId();
    for (let attempt = 0; attempt < 2; attempt++) expect((await request('PATCH', '/print-templates/' + template.id, { footerText: 'ZZ TEST Care print footer' }, scoped, key)).statusCode).toBe(200);
    expect(await trail(template.id, 'print_template.update')).toHaveLength(1);
    const preview = await request('POST', '/print-templates/' + template.id + '/preview.png', { footerText: 'ZZ TEST Unsaved read-only preview' }, scoped);
    expect(preview.statusCode).toBe(200); expect(preview.headers['content-type']).toContain('image/png');
    expect((await request('POST', '/print-templates/' + template.id + '/test-print', {}, scoped)).statusCode).toBe(403);
    expect((await request('POST', '/print-templates/' + foreign.id + '/test-print', {}, scoped)).statusCode).toBe(404);
    expect((await request('PATCH', '/print-templates/' + foreign.id, { footerText: 'ZZ TEST Refused foreign footer' }, scoped)).statusCode).toBe(404);
    expect(await ctx.db.select({ id: printJob.id }).from(printJob)).toEqual(beforeJobs);
  });
});

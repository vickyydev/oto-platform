// Complete only this proof's remaining synthetic pickup. No pickup UI claim.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../../../../..');
const { need } = await import(pathToFileURL('C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs'));
const { request } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const source = JSON.parse(readFileSync(resolve(import.meta.dirname, 'receipt.json'), 'utf8'));
const regId = source.created.find(x => x.kind === 'registration').id;
assert.equal(regId, '01a1c9ed-f349-7108-ac39-452a14a12500');
const proof = { startedAt: new Date().toISOString(), registrationId: regId, requests: [], cleanup: [] };
const save = () => writeFileSync(resolve(import.meta.dirname, 'cleanup-pickup.json'), JSON.stringify(proof, null, 2) + '\n');
const admin = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const call = async (method, path, data, headers = {}) => {
  const r = await admin.fetch('/api' + path, { method, ...(data === undefined ? {} : { data }), headers: { 'idempotency-key': randomUUID(), ...headers } });
  const body = await r.json().catch(() => null);
  proof.requests.push({ method, path, status: r.status(), ...(r.status() >= 400 ? { errorCode: body?.error?.code ?? body?.code } : {}) }); save();
  return { status: r.status(), body };
};
try {
  assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
  const reg = (await call('GET', '/checkin/registrations/' + regId)).body;
  assert.equal(reg.guardianName, 'ZZ TEST SCRUM-807 guardian');
  assert.equal(reg.children.length, 1);
  const child = reg.children[0];
  assert.equal(child.childName, 'ZZ TEST SCRUM-807 child');
  if (child.status === 'in_park') {
    const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: regId, filename: 'ZZ TEST SCRUM-807 synthetic pickup.png' });
    assert.equal(file.status, 200); proof.fileId = file.body.id; save();
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
    assert.equal((await call('PUT', '/files/' + proof.fileId + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
    const released = await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: proof.fileId });
    assert.equal(released.status, 200); proof.releaseId = released.body.release.id;
  }
  const after = (await call('GET', '/checkin/registrations/' + regId)).body;
  assert.ok(after.children.every(c => c.status === 'out'));
  proof.cleanup.push({ children: after.children.map(c => ({ id: c.id, status: c.status })), separateSyntheticPickupPhoto: true });
  proof.passed = true;
} catch (error) {
  proof.passed = false; proof.failureKind = error.name;
  process.exitCode = 1;
} finally {
  assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
  const me = (await admin.get('/api/me')).status(); assert.equal(me, 401);
  proof.cleanup.push({ adminSession: 'signed out', me });
  proof.finishedAt = new Date().toISOString(); save(); await admin.dispose();
}
console.log({ passed: proof.passed, cleanup: proof.cleanup, requests: proof.requests });

// SCRUM-853 and SCRUM-854 staging proof. Adapted from the committed SCRUM-847
// harness (docs/qa/proof-2026-11-11/SCRUM-847/staging: proof.mjs, flow.mjs).
// Own ZZ TEST till, ZZ TEST guardian and child, cash or zero only. No
// credentials, pairing code, voucher code or raw response bodies enter the
// receipt or the console.
//
//   node proof.mjs <sha> <out-dir> <steps> [voucher-sale-id]
//   steps: r,o,p,e,m  (SCRUM-853: refused, offline, pending, plain, member card)
//          854        (SCRUM-854: the two-account hand-over)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeSteps } from './flow.mjs';

const repo = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(repo, 'scripts/agent/env.mjs')));
const { chromium, request, expect } = createRequire(resolve(repo, 'apps/pos/package.json'))('@playwright/test');
const sha = process.argv[2];
assert.match(sha ?? '', /^[a-f0-9]{40}$/);
const out = resolve(import.meta.dirname, process.argv[3] ?? 'out');
mkdirSync(out, { recursive: true });
const wanted = (process.argv[4] ?? 'r,o,p,e,m').split(',');
const T = wanted.includes('854') ? '854' : '853';
const base = Number(process.env.ZZ_BASE ?? (T === '854' ? 60 : 52));
const zz = i => '08980200' + String(base + i).padStart(2, '0');
const pos = 'https://oto-pos-web-staging.onrender.com';
const deploysFile = resolve(import.meta.dirname, 'deploys.json');
const receipt = { ticket: `SCRUM-${T}`, sha, startedAt: new Date().toISOString(), phase: 'preflight',
  deployments: existsSync(deploysFile) ? JSON.parse(readFileSync(deploysFile, 'utf8')).state : null,
  steps: {}, requests: [], created: [], checks: {}, cleanup: [] };
const save = () => writeFileSync(resolve(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const phase = value => { receipt.phase = value; save(); console.log(new Date().toISOString(), value); };
for (const d of Object.values(receipt.deployments ?? {})) { assert.equal(d.status, 'live'); assert.equal(d.sha, sha); }

const admin = await request.newContext({ baseURL: pos });
const adminSignIn = async () => assert.equal((await admin.post('/api/auth/sign-in', { data: { phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') } })).status(), 200);
const call = async (method, path, data, headers = {}) => {
  const once = () => admin.fetch(`/api${path}`, { method, ...(data === undefined ? {} : { data }), headers: method === 'GET' ? headers : { 'idempotency-key': randomUUID(), ...headers } });
  let response = await once();
  if (response.status() === 401) { receipt.checks.adminSignedInAgain = (receipt.checks.adminSignedInAgain ?? 0) + 1; await adminSignIn(); response = await once(); }
  const body = await response.json().catch(() => null);
  receipt.requests.push({ method, path: path.split('?')[0], status: response.status(), ...(response.status() >= 400 ? { errorCode: body?.error?.code ?? null } : {}) });
  return { status: response.status(), body };
};
// Shared, mutable state the steps read: the till page, the paired display, the voucher.
const ctx = { till: null, display: null, voucher: null, sold: null, station: null, branchId: null, browser: null, firstAccountId: null,
  // ZZ TEST only; confirmed unused before use. One number per pass: the family form saves its guardian as a member.
  numbers: T === '854' ? { h: zz(0) } : { r: zz(0), o: zz(1), p: zz(2), e: zz(3) },
  fixtureName: `ZZ TEST SCRUM-${T} proof till ${Date.now()}`,
  CHILD: `ZZ TEST SCRUM-${T} child`, GUARDIAN: `ZZ TEST SCRUM-${T} guardian`, T,
  knownSales: new Set(), pos, out, receipt, save, phase, call, expect };
receipt.numbers = ctx.numbers;
let failed = false;
const firstLine = error => {
  let line = String(error?.message ?? error).split('\n')[0].slice(0, 300);
  if (ctx.voucher?.code) line = line.split(ctx.voucher.code).join('[voucher]');
  return `${error?.name ?? 'Error'}: ${line}`;
};
ctx.shot = async (page, name, opts = {}) => {
  await page.screenshot({ path: resolve(out, name), animations: 'disabled',
    mask: [page.getByLabel('Lock screen').locator('..'), page.locator('input[type="password"]'),
      page.getByTestId('display-pairing-code'), page.locator('svg:not(.lucide), canvas'),
      // The voucher card: whole, or (SCRUM-854, where the card appearing is the point) only its small lines — the code, where it came from, who printed it.
      opts.cardInner ? page.getByTestId('voucher-card').locator('.text-xs') : page.getByTestId('voucher-card'),
      page.getByTestId('voucher-refusal').locator('.font-mono'),
      page.getByTestId('voucher-used'), page.getByTestId('sold-voucher-codes'), page.getByText(/^QR-[A-Z0-9]+$/), page.getByPlaceholder(/^Voucher code/)] });
  console.log('picture', name);
};
const steps = makeSteps(ctx);

const attempt = async (key, fn) => {
  try { await fn(); }
  catch (error) {
    failed = true;
    receipt.failures = [...(receipt.failures ?? []), { key, failedAt: receipt.phase, failure: firstLine(error) }];
    save(); console.log('STEP FAILED', key, '|', receipt.phase, '|', firstLine(error));
    if (ctx.till) await ctx.shot(ctx.till, `failed-${key}-till.png`).catch(() => {});
    if (ctx.display) await ctx.shot(ctx.display.page, `failed-${key}-display.png`).catch(() => {});
    // Leave the step: cancel what the screen still holds, unpair, start clean.
    try {
      const cancel = ctx.till.getByRole('button', { name: 'Cancel', exact: true }).first();
      if (await ctx.till.getByTestId('payment-step').isVisible().catch(() => false) && await cancel.isEnabled().catch(() => false)) { await cancel.click(); await ctx.till.waitForTimeout(3000); }
    } catch { /* cleanup below reads the sales back */ }
    await steps.dropDisplay().catch(() => {});
    await ctx.till.goto('/').catch(() => {});
  }
};

let definition = null, campaign = null, definitionMadeHere = null;
try {
  phase('sign in and create own till');
  await adminSignIn();
  const branches = (await call('GET', '/branches')).body;
  const branch = (branches.branches ?? branches).find(b => /Central Floresta/.test(b.name));
  assert.ok(branch); ctx.branchId = branch.id;
  const boxes = (await call('GET', `/branches/${ctx.branchId}/boxes`)).body.boxes;
  const box = boxes.find(b => b.role === 'virtual' && b.slot === 'virtual-1' && b.status === 'online' && !b.archived);
  assert.ok(box, 'simulated box is online');
  const stations = (await call('GET', `/branches/${ctx.branchId}/stations?includeArchived=true`)).body.stations;
  const printerSource = stations.find(s => s.boxId === box.id && !s.archived && ['kids_band', 'adult_band', 'receipt'].every(role => s.devices.some(d => d.role === role)));
  assert.ok(printerSource, 'simulated printers already configured');
  const devices = ['kids_band', 'adult_band', 'receipt'].map(role => ({ role, deviceId: printerSource.devices.find(d => d.role === role).deviceId }));
  const prefix = Array.from({ length: 99 }, (_, i) => `Z${T}${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
  assert.ok(prefix);
  for (const phone of Object.values(ctx.numbers)) assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null, 'ZZ TEST number must be unused');
  receipt.checks.testNumbersUnusedBefore = true;
  const made = await call('POST', `/branches/${ctx.branchId}/stations`, { name: ctx.fixtureName, kind: 'till', boxId: box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
  assert.equal(made.status, 200); ctx.station = made.body.station;
  assert.equal(ctx.station.name, ctx.fixtureName);
  receipt.created.push({ kind: 'station', id: ctx.station.id, name: ctx.fixtureName, prefix }); save();

  if (T === '854') {
    phase('issue one ZZ TEST money-off voucher as the administrator (voucher type + campaign, as voucher.spec.ts does)');
    const TYPE = { code: 'zz-test-s854-150-off', nameEn: 'ZZ TEST SCRUM-854 150 THB Voucher', kind: 'discount', valueType: 'amount', valueSatang: 15000, costSatang: 15000, expiryDays: 14 };
    definition = (await call('GET', '/voucher-definitions?includeArchived=true')).body.definitions.find(d => d.code === TYPE.code) ?? null;
    if (!definition) {
      const created = await call('POST', '/voucher-definitions', TYPE);
      assert.equal(created.status, 201); definition = created.body.definition; definitionMadeHere = 'created';
    } else if (definition.archivedAt) {
      const restored = await call('POST', `/voucher-definitions/${definition.id}/restore`, {});
      assert.equal(restored.status, 200); definition = restored.body.definition; definitionMadeHere = 'restored';
    } else definitionMadeHere = 'found live (left by an earlier pass of this proof)';
    assert.ok(definition.nameEn.startsWith('ZZ TEST SCRUM-854'));
    receipt.created.push({ kind: 'voucher-definition', id: definition.id, code: TYPE.code, name: TYPE.nameEn, how: definitionMadeHere }); save();
    const minted = await call('POST', '/voucher-campaigns', { definitionId: definition.id, branchId: ctx.branchId, name: `ZZ TEST SCRUM-854 proof ${Date.now()}`, quantity: 1 });
    assert.equal(minted.status, 200); campaign = minted.body.campaign;
    receipt.created.push({ kind: 'voucher-campaign', id: campaign.id, quantity: 1 }); save();
    const codes = async () => {
      const download = await admin.get(`/api/voucher-campaigns/${campaign.id}/codes`);
      assert.equal(download.status(), 200);
      const [header, ...rows] = (await download.text()).trim().split('\n');
      assert.equal(header.trim(), 'code,status,expires_at');
      return rows.map(row => row.split(',').map(c => c.trim()));
    };
    const rows = await codes();
    assert.equal(rows.length, 1); assert.equal(rows[0][1], 'issued');
    ctx.voucher = { code: rows[0][0] };
    ctx.voucherStatus = async () => ({ status: (await codes())[0][1] });
    receipt.checks.voucherIssued = { via: 'POST /api/voucher-definitions + POST /api/voucher-campaigns as the staging administrator', statusBefore: 'issued' }; save();
  }

  const video = resolve(import.meta.dirname, 'camera.y4m');
  const width = 320, height = 240;
  writeFileSync(video, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420\nFRAME\n`), Buffer.alloc(width * height, 150), Buffer.alloc(width * height / 2, 128)]));
  ctx.browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
  // A new browser profile: nothing cached, the bundle is fetched fresh.
  const tillContext = await ctx.browser.newContext({ baseURL: pos, viewport: { width: 1680, height: 1100 }, timezoneId: 'Asia/Bangkok', locale: 'en-GB', permissions: ['camera'] });
  tillContext.setDefaultTimeout(30000);
  const till = ctx.till = await tillContext.newPage();
  await till.goto(pos);
  phase('first account signs in at the own till (new browser profile)');
  await steps.signInAtTill(till, need('STAGING_RECEPTION_PHONE'), need('STAGING_RECEPTION_PASSWORD'));
  ctx.firstAccountId = (await (await till.request.get('/api/me')).json())?.account?.id ?? null;
  assert.ok(ctx.firstAccountId);
  phase('read the fresh bundle');
  receipt.checks.bundle = await till.evaluate(async () => {
    const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(n => /\.js(\?|$)/.test(n)))];
    const found = { files: urls.length, names: urls.map(u => u.split('/').pop().split('?')[0]), onlineOnlySentence: false, holdSaleReason: false, leftBehindSale: false, stillBeingSaved: false };
    for (const url of urls) {
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      if (text.includes('Vouchers can only be redeemed online')) found.onlineOnlySentence = true;
      if (text.includes('hold-sale-reason')) found.holdSaleReason = true;
      if (text.includes('left-behind-sale')) found.leftBehindSale = true;
      if (text.includes('The sale is still being saved')) found.stillBeingSaved = true;
    }
    return found;
  });
  save();
  console.log('bundle', JSON.stringify(receipt.checks.bundle));

  receipt.stepsRun = wanted; receipt.attempt = process.argv[3] ?? 'out';
  if (T === '853') {
    if (process.argv[5]) await steps.useVoucher(process.argv[5]); else if (wanted.some(w => ['r', 'o', 'p'].includes(w))) await steps.buyVoucher();
    if (wanted.includes('r')) await attempt('r', steps.stepRefused);
    if (wanted.includes('o')) await attempt('o', steps.stepOffline);
    if (wanted.includes('p')) await attempt('p', steps.stepPending);
    if (wanted.includes('e')) await attempt('e', steps.stepPlainSale);
    if (wanted.includes('m')) await attempt('m', steps.stepMemberCard);
  } else {
    await attempt('854', () => steps.stepLeftUnpaid({ phone: need('STAGING_ADMIN_PHONE'), password: need('STAGING_ADMIN_PASSWORD') }));
  }
  receipt.passed = Object.values(receipt.steps).every(v => v.pass === true);
} catch (error) {
  failed = true; receipt.passed = false; receipt.failure = { phase: receipt.phase, failure: firstLine(error) };
  console.log('RUN FAILED', '|', receipt.phase, '|', firstLine(error));
  if (ctx.till) await ctx.shot(ctx.till, 'failed-run-till.png').catch(() => {});
} finally {
  phase('clean up');
  const { station, branchId, fixtureName, CHILD, GUARDIAN, till } = ctx;
  const clean = async (step, action) => {
    try { await action(); }
    catch (error) { failed = true; (receipt.cleanupFailures ??= []).push({ step, failure: firstLine(error) }); console.log('CLEANUP FAILED', step, '|', firstLine(error)); }
    save();
  };
  await clean('unpair customer display', () => steps.dropDisplay(`ZZ TEST SCRUM-${T} proof complete`));
  let ownsStation = false;
  if (station) {
    await clean('verify own till', async () => {
      const own = (await call('GET', `/stations/${station.id}`)).body.station;
      assert.equal(own.name, fixtureName); ownsStation = true;
    });
    if (ownsStation) {
      for (const item of receipt.created.filter(i => i.kind === 'registration')) await clean(`pick up own test child (${item.step})`, async () => {
        const reg = (await call('GET', '/checkin/registrations/' + item.id)).body;
        assert.equal(reg.guardianName, GUARDIAN);
        for (const child of reg.children) {
          assert.equal(child.childName, CHILD);
          if (child.status === 'in_park') {
            // As cleanup-pickup.mjs of SCRUM-807: a separate synthetic pickup photo, then the release.
            const file = await call('POST', '/files', { contentType: 'image/png', ownerEntityType: 'registration', ownerEntityId: item.id, filename: `ZZ TEST SCRUM-${T} synthetic pickup.png` });
            assert.equal(file.status, 200);
            const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e0AAAAASUVORK5CYII=', 'base64');
            assert.equal((await call('PUT', '/files/' + file.body.id + '/content', pixel, { 'content-type': 'image/png' })).status, 204);
            const released = await call('POST', '/checkin/pickups/stays/' + child.id + '/release', { collector: { kind: 'dropper_off' }, pickupPhotoFileId: file.body.id });
            assert.equal(released.status, 200);
          }
        }
        const after = await steps.registrationState(item.id);
        receipt.cleanup.push({ kind: 'registration', step: item.step, ...after, inPark: after.children.filter(c => c.status === 'in_park').length });
        assert.ok(after.children.every(c => c.status !== 'in_park'));
      });
      let sales = [];
      await clean('read own sales', async () => {
        sales = await steps.stationSales();
        assert.ok(Array.isArray(sales));
        for (const sale of sales) assert.equal(sale.stationId, station.id);
      });
      for (const sale of sales.filter(s => s.status === 'tendering' || s.status === 'open')) await clean(`void ${sale.id}`, async () => {
        assert.equal((await call('POST', `/sales/${sale.id}/void`, { reason: `ZZ TEST SCRUM-${T} proof cleanup` })).status, 200);
        assert.equal((await call('GET', `/sales/${sale.id}`)).body.sale.status, 'voided');
        receipt.cleanup.push({ kind: 'sale', id: sale.id, status: 'voided', by: 'cleanup' });
      });
      for (const { id } of sales.filter(s => s.status === 'finalised')) await clean(`print ${id}`, async () => {
        let jobs;
        await expect.poll(async () => { jobs = (await call('GET', `/sales/${id}`)).body.printJobs; return jobs.every(j => j.status === 'printed'); }, { timeout: 60000 }).toBe(true);
        receipt.cleanup.push({ kind: 'finalised-test-sale', id, retained: true, printJobs: jobs.map(j => ({ id: j.id, status: j.status })) });
      });
      await clean('final sales read-back', async () => {
        const final = await steps.stationSales();
        receipt.cleanup.push({ kind: 'sales-read-back', sales: final.map(s => ({ id: s.id, status: s.status, grossSatang: s.totals?.grossSatang ?? null })) });
        assert.ok(final.every(s => ['finalised', 'voided'].includes(s.status)));
      });
      await clean('retire own till', async () => {
        assert.equal((await call('PATCH', `/stations/${station.id}`, { devices: [] })).status, 200);
        assert.equal((await call('DELETE', `/stations/${station.id}`)).status, 200);
        const retired = (await call('GET', `/branches/${branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === station.id);
        assert.ok(retired.archived); assert.equal(retired.devices.length, 0);
        receipt.cleanup.push({ kind: 'station', id: station.id, archived: true, devices: 0 });
      });
    }
  }
  if (campaign && ctx.voucherStatus) await clean('read the test voucher back', async () => {
    receipt.cleanup.push({ kind: 'voucher', campaign: campaign.id, ...(await ctx.voucherStatus()) });
  });
  if (definition && (definitionMadeHere === 'created' || definitionMadeHere === 'restored' || definitionMadeHere?.startsWith('found live'))) await clean('archive the ZZ TEST voucher type', async () => {
    assert.ok(definition.nameEn.startsWith('ZZ TEST SCRUM-854'));
    assert.equal((await call('DELETE', `/voucher-definitions/${definition.id}`)).status, 200);
    const back = (await call('GET', '/voucher-definitions?includeArchived=true')).body.definitions.find(d => d.id === definition.id);
    const listed = (await call('GET', '/voucher-definitions')).body.definitions.some(d => d.id === definition.id);
    receipt.cleanup.push({ kind: 'voucher-definition', id: definition.id, archived: Boolean(back?.archivedAt), inTheLiveList: listed });
    assert.ok(back?.archivedAt); assert.equal(listed, false);
  });
  for (const [key, phone] of Object.entries(ctx.numbers)) await clean(`check test number ${key}`, async () => {
    const member = (await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member;
    if (member) {
      assert.ok((member.nickname ?? '').startsWith(`ZZ TEST SCRUM-${T}`), 'only own named test members');
      assert.equal((await call('DELETE', `/members/${member.id}`)).status, 200);
      assert.equal((await call('GET', `/members/lookup?phone=${encodeURIComponent(phone)}`)).body.member, null);
      receipt.cleanup.push({ kind: 'member', key, id: member.id, archived: true });
    } else receipt.cleanup.push({ kind: 'test-number', key, member: null });
  });
  if (till) await clean('sign out till', async () => {
    const before = (await till.request.get('/api/me')).status();
    if (before === 200) assert.equal((await till.request.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    const me = await till.request.get('/api/me'); assert.equal(me.status(), 401);
    receipt.cleanup.push({ kind: 'till-session', signedInBefore: before === 200, signedOut: true, me: 401 });
  });
  await clean('sign out admin', async () => {
    if ((await admin.get('/api/me')).status() === 200) assert.equal((await admin.post('/api/auth/sign-out', { headers: { 'idempotency-key': randomUUID() } })).status(), 200);
    assert.equal((await admin.get('/api/me')).status(), 401);
    receipt.cleanup.push({ kind: 'admin-session', signedOut: true, me: 401 });
  });
  await ctx.browser?.close().catch(() => {}); await admin.dispose();
  receipt.phase = 'finished'; receipt.finishedAt = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: receipt.passed, steps: Object.fromEntries(Object.entries(receipt.steps).map(([k, v]) => [k, v.pass])), cleanupFailed: Boolean(receipt.cleanupFailures?.length) }));
if (failed) process.exitCode = 1;

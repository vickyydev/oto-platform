// SCRUM-1040 staging proof: the Mystery Box is a stock item, and using its
// voucher at the till takes one off the shelf.
// Run from the lane worktree after the api, Console and till deploys are live:
//   node docs/qa/proof-2026-11-19/SCRUM-1040/proof.mjs <phase> [full-sha]
// phases: reads | item | type | till <A|B> | after | cleanup
// Everything written is ZZ TEST and made through the apps' own screens: a stock
// item "ZZ TEST Mystery Box SCRUM-1040" at Central Floresta (no product), one
// ZZ TEST delivery, a voucher type "ZZ TEST Mystery Box SCRUM-1040" (a
// hand-over prize) linked to that item there, and vouchers issued and handed
// over at the till of the station "ZZ TEST setup traps 20261102" (Virtual
// box 1). No cookie, phone, password or voucher code is printed or saved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = import.meta.dirname;
const root = resolve(out, '../../../..');
const helperRoot = 'C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos';
const { need } = await import(pathToFileURL(resolve(helperRoot, 'scripts/agent/env.mjs')));
const { service, render } = await import(pathToFileURL(resolve(helperRoot, 'scripts/agent/render.mjs')));
const { chromium, request } = createRequire(resolve(root, 'apps/pos/package.json'))('@playwright/test');
const CONSOLE = 'https://oto-console-staging.onrender.com';
const POS = 'https://oto-pos-web-staging.onrender.com';
const STATION = 'ZZ TEST setup traps 20261102';
const ITEM = 'ZZ TEST Mystery Box SCRUM-1040';
const TYPE = 'ZZ TEST Mystery Box SCRUM-1040';
const PARK_CODE = 'hkt-central';
const PARK_NAME = 'Oto Play Park, Central Floresta';
const receiptFile = resolve(out, 'receipt.json');
const receipt = existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : { unit: 'SCRUM-1040', steps: {} };
const save = () => writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
mkdirSync(out, { recursive: true });
const rel = (p) => p.slice(root.length + 1).split(String.fromCharCode(92)).join('/');
const phase = process.argv[2];
const arg = process.argv[3];

async function deployments(names, sha) {
  const result = {};
  for (const name of names) {
    const svc = await service(name);
    const d = (await render('GET', `/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
    result[name] = { id: d?.id, status: d?.status, sha: d?.commit?.id };
    if (sha) assert.equal(d?.commit?.id, sha, `${name} runs the proved source`);
    assert.equal(d?.status, 'live', `${name} is live`);
  }
  return result;
}

async function apiAs(who, base = CONSOLE) {
  const ctx = await request.newContext({ baseURL: base });
  const r = await ctx.post('/api/auth/sign-in', { data: { phone: need(`STAGING_${who}_PHONE`), password: need(`STAGING_${who}_PASSWORD`) } });
  assert.equal(r.status(), 200, `${who} sign-in`);
  const call = async (method, path, data, headers = {}) => {
    const res = await ctx.fetch('/api' + path, { method, data, headers });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status(), body };
  };
  const signOut = async () => { await ctx.post('/api/auth/sign-out'); const me = await ctx.get('/api/me'); await ctx.dispose(); return me.status(); };
  return { call, signOut };
}

/** What the platform holds for the ZZ TEST item, its type and their movements. */
async function state(admin) {
  const branches = (await admin.call('GET', '/branches')).body?.branches ?? [];
  const park = branches.find((b) => b.code === PARK_CODE);
  assert.ok(park, 'Central Floresta');
  const levels = (await admin.call('GET', `/branches/${park.id}/stock/levels`)).body ?? {};
  const item = (levels.items ?? []).find((i) => i.name === ITEM) ?? null;
  const defs = (await admin.call('GET', '/voucher-definitions?includeArchived=true')).body?.definitions ?? [];
  const def = defs.find((d) => d.nameEn === TYPE) ?? null;
  const movements = item
    ? ((await admin.call('GET', `/branches/${park.id}/stock/movements?stockItemId=${item.id}&limit=50`)).body?.movements ?? [])
    : [];
  const attention = ((await admin.call('GET', `/branches/${park.id}/stock/attention`)).body?.attention ?? [])
    .filter((a) => item && a.stockItemId === item.id);
  return {
    park: { id: park.id, name: park.name },
    item: item ? { id: item.id, name: item.name, total: item.total, status: item.status, productKind: item.productKind, active: item.active ?? null } : null,
    type: def ? { id: def.id, nameEn: def.nameEn, kind: def.kind, active: def.active, archivedAt: def.archivedAt ?? null, parkStock: def.parkStock ?? [] } : null,
    movements: movements.map((m) => ({ kind: m.kind, quantity: m.quantity, levelAfter: m.levelAfter, shortfall: m.shortfall,
      saleId: m.saleId, saleLineId: m.saleLineId, reason: m.reason, stationId: m.stationId, offline: m.offline, occurredAt: m.occurredAt })),
    attention: attention.map((a) => ({ id: a.id, kind: a.kind, quantity: a.quantity, summary: a.summary, resolvedAt: a.resolvedAt ?? null })),
  };
}

async function browserFor(base, who, viewport = { width: 1440, height: 1000 }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport, timezoneId: 'Asia/Bangkok', locale: 'en-GB' });
  ctx.setDefaultTimeout(30000);
  const page = await ctx.newPage();
  const close = async () => {
    const o = await page.request.post(base + '/api/auth/sign-out');
    const me = await page.request.get(base + '/api/me');
    await browser.close();
    return { signOut: o.status(), meAfter: me.status() };
  };
  if (who) {
    const signIn = await page.request.post(base + '/api/auth/sign-in', {
      data: { phone: need(`STAGING_${who}_PHONE`), password: need(`STAGING_${who}_PASSWORD`) },
    });
    assert.equal(signIn.status(), 200, `${who} sign-in`);
  }
  return { page, close };
}

const debugShot = async (page, name) => { await page.screenshot({ path: resolve(out, `zz-debug-${name}.png`), fullPage: true }).catch(() => {}); };

async function onInventory(page) {
  await page.goto(CONSOLE + '/catalogue/inventory', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New item', exact: true }).waitFor();
  const chip = page.locator('select').filter({ has: page.locator('option', { hasText: PARK_NAME }) }).first();
  if (await chip.count()) await chip.selectOption({ label: PARK_NAME }).catch(() => {});
  await page.waitForTimeout(3000);
}

try {
  if (phase === 'reads') {
    const admin = await apiAs('ADMIN');
    receipt.steps.reads = { at: new Date().toISOString(), deployments: await deployments(['oto-api-staging', 'oto-console-staging', 'oto-pos-staging', 'oto-pos-web-staging'], arg), state: await state(admin), meAfterSignOut: await admin.signOut() };
    save();
    console.log(JSON.stringify(receipt.steps.reads, null, 1));
  }

  if (phase === 'item') {
    // Console > Inventory at Central Floresta: the Mystery Box, counted and never sold.
    const { page, close } = await browserFor(CONSOLE, 'ADMIN');
    try {
      await onInventory(page);
      await page.getByRole('button', { name: 'New item', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Display name *').fill(ITEM);
      await dialog.locator('#inv-kind').selectOption('merch');
      await dialog.locator('#inv-linkedid').selectOption({ label: '— none: counted, never sold —' });
      const label = dialog.locator('input[placeholder="Default"]').first();
      await label.fill('Default');
      const shot1 = resolve(out, '01-console-new-item-no-product.png');
      await dialog.locator('#inv-linkedid').scrollIntoViewIfNeeded();
      await dialog.screenshot({ path: shot1 });
      await dialog.getByRole('button', { name: 'Create item', exact: true }).click();
      await dialog.waitFor({ state: 'detached', timeout: 30000 });
      await page.waitForTimeout(2000);
      // The ZZ TEST delivery: Adjust, typed as a delivery, with its reason.
      const card = page.locator('div.rounded-2xl').filter({ hasText: ITEM }).filter({ has: page.getByRole('button', { name: 'Adjust' }) }).last();
      await card.getByRole('button', { name: 'Adjust', exact: true }).click();
      const adjust = page.getByRole('dialog');
      await adjust.locator('#adj-delta').fill('1');
      await adjust.getByRole('button', { name: 'Delivery', exact: true }).click();
      await adjust.getByPlaceholder('Or type a custom reason…').fill('ZZ TEST delivery SCRUM-1040');
      const shot2 = resolve(out, '02-console-zz-test-delivery.png');
      await adjust.screenshot({ path: shot2 });
      await adjust.getByRole('button', { name: 'Apply adjustment', exact: true }).click();
      await adjust.waitFor({ state: 'detached', timeout: 30000 });
      await page.waitForTimeout(3000);
      await card.scrollIntoViewIfNeeded();
      const shot3 = resolve(out, '03-console-mystery-box-count-1.png');
      await card.screenshot({ path: shot3 });
      receipt.steps.item = { at: new Date().toISOString(), pictures: [rel(shot1), rel(shot2), rel(shot3)] };
    } catch (e) { await debugShot(page, 'item'); throw e; } finally { receipt.steps.item = { ...(receipt.steps.item ?? {}), session: await close() }; }
    const admin = await apiAs('ADMIN');
    receipt.steps.item.state = await state(admin);
    receipt.steps.item.meAfterSignOut = await admin.signOut();
    save();
    console.log(JSON.stringify(receipt.steps.item, null, 1));
  }

  if (phase === 'type') {
    // Console > Voucher types: a ZZ TEST hand-over prize, then its stock item at Central Floresta.
    const { page, close } = await browserFor(CONSOLE, 'ADMIN');
    try {
      await page.goto(CONSOLE + '/catalogue/voucher-types', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'New voucher type' }).first().waitFor();
      const exists = await page.getByText(TYPE, { exact: true }).count();
      if (!exists) {
        await page.getByRole('button', { name: 'New voucher type' }).first().click();
        const drawer = page.getByRole('dialog');
        await drawer.locator('label', { hasText: 'Name (English)' }).locator('input').first().fill(TYPE);
        await drawer.getByRole('button', { name: 'Hand-over prize', exact: true }).click();
        await drawer.getByRole('button', { name: 'Create voucher type', exact: true }).click();
        await page.waitForTimeout(4000);
        if (await drawer.isVisible().catch(() => false)) await drawer.getByRole('button', { name: /Close/ }).first().click().catch(() => {});
      }
      await page.waitForTimeout(2000);
      await page.getByText(TYPE, { exact: true }).first().click();
      const drawer = page.getByRole('dialog');
      const picker = drawer.getByLabel(`Stock item at ${PARK_NAME}`);
      await picker.waitFor();
      await picker.selectOption({ label: ITEM });
      await page.waitForTimeout(4000);
      const section = drawer.getByTestId('voucher-type-park-stock');
      await section.scrollIntoViewIfNeeded();
      const shot = resolve(out, '04-console-voucher-type-takes-from-item.png');
      await drawer.screenshot({ path: shot });
      receipt.steps.type = { at: new Date().toISOString(), chosen: await picker.evaluate((el) => el.selectedOptions[0]?.textContent ?? null), pictures: [rel(shot)] };
    } catch (e) { await debugShot(page, 'type'); throw e; } finally { receipt.steps.type = { ...(receipt.steps.type ?? {}), session: await close() }; }
    const admin = await apiAs('ADMIN');
    receipt.steps.type.state = await state(admin);
    receipt.steps.type.meAfterSignOut = await admin.signOut();
    save();
    console.log(JSON.stringify(receipt.steps.type, null, 1));
  }

  if (phase === 'till') {
    // The ZZ TEST till: issue a voucher of the ZZ TEST type, scan it, hand it over.
    const run = arg ?? 'A';
    const { page, close } = await browserFor(POS, null, { width: 1600, height: 1000 });
    const step = {};
    try {
      await page.goto(POS, { waitUntil: 'domcontentloaded' });
      await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
      await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: STATION, exact: false }).first().click();
      await page.waitForTimeout(6000);
      for (let i = 0; i < 12 && await page.getByText('Another till is using this station').first().isVisible().catch(() => false); i += 1) await page.waitForTimeout(10000);
      // A walk-in on the till's own customer half (the test harness): English,
      // a ZZ TEST number nobody holds, "Continue as walk-in", then Tourist.
      const walkIn = run === 'A' ? '0891040401' : '0891040402';
      {
        const admin = await apiAs('ADMIN');
        const found = (await admin.call('GET', `/members/lookup?phone=${walkIn}`)).body?.member ?? null;
        await admin.signOut();
        assert.equal(found, null, 'the ZZ TEST walk-in number belongs to nobody');
      }
      const halfOf = (locator) => locator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " w-1/2 ")][1]');
      await page.locator('[data-testid="language-choice"],[data-testid="identify-safety"]').first().waitFor();
      if (await page.getByTestId('language-choice').isVisible()) await page.getByTestId('language-choice-en').click();
      await page.getByTestId('identify-safety').waitFor();
      const half = halfOf(page.getByTestId('identify-safety'));
      for (const digit of walkIn) await half.getByRole('button', { name: digit, exact: true }).last().click();
      await half.getByRole('button', { name: 'Continue', exact: true }).click();
      const offer = page.getByRole('dialog', { name: 'New member?', exact: true });
      await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
      await page.getByRole('heading', { name: 'Tourist', exact: true }).first().click();
      await page.waitForTimeout(1500);
      // The voucher: one issued earlier at this till and not yet used (REUSE_CODE,
      // never printed), or one issued now through the till's own "Issue a voucher…".
      let code = process.env.REUSE_CODE ?? null;
      if (!code) {
        await page.getByTestId('issue-voucher-open').click();
        const issueRow = page.getByTestId('issue-voucher');
        const select = issueRow.getByLabel('Voucher to issue');
        await expectOption(select, TYPE);
        const value = await select.locator('option', { hasText: TYPE }).first().getAttribute('value');
        await select.selectOption(value);
        await issueRow.getByRole('button', { name: 'Issue & print', exact: true }).click();
        const answer = issueRow.locator('div.text-xs').filter({ hasText: /^Issued / });
        await answer.waitFor();
        const text = await answer.textContent();
        code = /·\s*([A-Z0-9-]+)/.exec(text)?.[1] ?? null;
        assert.ok(code, 'the till names the issued code');
        step.issued = { said: text.replace(code, '<code>') };
        await issueRow.getByRole('button', { name: 'Close', exact: true }).click();
      } else {
        step.issued = { said: 'issued earlier at this till through "Issue a voucher…" and not yet used' };
      }
      await page.getByLabel('Redeem voucher').fill(code);
      await page.getByLabel('Redeem voucher').press('Enter');
      const card = page.getByTestId('voucher-card');
      // A voucher left on a ฿0 sale rung up earlier at this till and never
      // completed: the till's own offer voids that unpaid sale (today's,
      // ZZ TEST) and holds the voucher here. Nothing left the shelf for it.
      const offerVoid = page.getByRole('button', { name: 'Void that unpaid sale and use the voucher here', exact: true });
      await Promise.race([card.waitFor(), offerVoid.waitFor()]);
      if (await offerVoid.isVisible().catch(() => false)) {
        await offerVoid.click();
        step.voidedRungUp = true;
      }
      await card.waitFor();
      await page.waitForTimeout(2500);
      step.warning = await page.getByTestId('voucher-prize-stock').count() ? await page.getByTestId('voucher-prize-stock').textContent() : null;
      const shot1 = resolve(out, run === 'A' ? '05-till-voucher-scanned-count-1.png' : '07-till-voucher-scanned-count-0-warning.png');
      await page.screenshot({ path: shot1, mask: [page.locator('input[type="password"]'), page.getByLabel('Redeem voucher')] });
      const pay = page.getByRole('button', { name: /^Pay / }).last();
      await pay.click();
      const confirm = page.getByRole('button', { name: 'Complete Sale', exact: true });
      await confirm.waitFor();
      await confirm.click();
      await page.getByRole('heading', { name: 'Sale Confirmed', exact: true }).waitFor({ timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const shot2 = resolve(out, run === 'A' ? '06-till-prize-handed-over.png' : '08-till-prize-handed-over-at-zero.png');
      await page.screenshot({ path: shot2, mask: [page.getByLabel('Redeem voucher')] });
      step.pictures = [rel(shot1), rel(shot2)];
    } catch (e) { await page.screenshot({ path: resolve(out, `zz-debug-till-${run}.png`), mask: [page.getByLabel('Redeem voucher')] }).catch(() => {}); throw e; } finally { step.session = await close(); }
    const admin = await apiAs('ADMIN');
    step.at = new Date().toISOString();
    step.state = await state(admin);
    step.meAfterSignOut = await admin.signOut();
    receipt.steps[`till${run}`] = step;
    save();
    console.log(JSON.stringify(step, null, 1));
  }

  if (phase === 'finish') {
    // A ฿0 hand-over rung up at the ZZ TEST till and left on its payment
    // screen: the till offers "Resume this sale"; Complete Sale closes it.
    const run = arg ?? 'A';
    const { page, close } = await browserFor(POS, null, { width: 1600, height: 1000 });
    const step = {};
    try {
      await page.goto(POS, { waitUntil: 'domcontentloaded' });
      await page.locator('input[inputmode="tel"],input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
      await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: STATION, exact: false }).first().click();
      await page.waitForTimeout(6000);
      for (let i = 0; i < 12 && await page.getByText('Another till is using this station').first().isVisible().catch(() => false); i += 1) await page.waitForTimeout(10000);
      await page.getByTestId('resume-sale').first().click();
      const complete = page.getByRole('button', { name: 'Complete Sale', exact: true });
      await complete.waitFor();
      await complete.click();
      await page.waitForTimeout(6000);
      const shot = resolve(out, run === 'A' ? '06-till-prize-handed-over.png' : '08-till-prize-handed-over-at-zero.png');
      await page.screenshot({ path: shot });
      step.pictures = [rel(shot)];
    } catch (e) { await page.screenshot({ path: resolve(out, `zz-debug-finish-${run}.png`) }).catch(() => {}); throw e; } finally { step.session = await close(); }
    const admin = await apiAs('ADMIN');
    step.at = new Date().toISOString();
    step.state = await state(admin);
    step.meAfterSignOut = await admin.signOut();
    receipt.steps[`finish${run}`] = step;
    save();
    console.log(JSON.stringify(step, null, 1));
  }

  if (phase === 'after') {
    // Console > Inventory again: the count after the hand-overs.
    const { page, close } = await browserFor(CONSOLE, 'ADMIN');
    try {
      await onInventory(page);
      const card = page.locator('div.rounded-2xl').filter({ hasText: ITEM }).filter({ has: page.getByRole('button', { name: 'Adjust' }) }).last();
      await card.scrollIntoViewIfNeeded();
      const shot = resolve(out, '09-console-mystery-box-count-after.png');
      await card.screenshot({ path: shot });
      receipt.steps.after = { at: new Date().toISOString(), pictures: [rel(shot)] };
    } catch (e) { await debugShot(page, 'after'); throw e; } finally { receipt.steps.after = { ...(receipt.steps.after ?? {}), session: await close() }; }
    const admin = await apiAs('ADMIN');
    receipt.steps.after.state = await state(admin);
    receipt.steps.after.meAfterSignOut = await admin.signOut();
    save();
    console.log(JSON.stringify(receipt.steps.after, null, 1));
  }
  if (phase === 'card') {
    // The item's stock ledger as the platform reads it back: no screen lists
    // one item's movements, so a labelled test-run card shows them.
    // The evidence card of scripts/agent/evidence.mjs, drawn here: that helper
    // loads a second Playwright from another checkout.
    const card = async (page, s, outFile) => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.evaluate((spec) => {
        const esc = (x) => String(x ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
        const badge = (t, ok) => `<span style="display:inline-block;min-width:46px;text-align:center;border-radius:6px;padding:2px 8px;font-weight:700;background:${ok ? '#12351f' : '#3a1220'};color:${ok ? '#4ade80' : '#f87171'}">${esc(t)}</span>`;
        let h = `<div style="font-size:22px;font-weight:800;color:#fff">${esc(spec.title)}</div><div style="color:#9aa4bf;margin:2px 0 12px">${esc(spec.subtitle)}</div>`;
        h += `<div style="background:#131a2e;border:1px solid #263154;border-radius:8px;padding:10px 12px;margin-bottom:12px"><b style="color:#8bd4ff">Signed-in identity</b><br>${esc(spec.identity)}<br>captured ${esc(new Date().toISOString())}<br>${esc(spec.deploy)}</div>`;
        for (const r of spec.rows) {
          h += `<div style="margin:10px 0;border-left:3px solid ${r.ok ? '#2b6b3f' : '#7a2233'};padding:2px 0 2px 12px"><div>${badge(r.tag, r.ok)} <b>${esc(r.head)}</b> <span style="color:#9aa4bf">- ${esc(r.note)}</span></div>`;
          if (r.body) h += `<pre style="white-space:pre-wrap;margin:4px 0 0;color:#c7ccdb;background:#0f1526;border-radius:6px;padding:8px">${esc(r.body)}</pre>`;
          h += '</div>';
        }
        const el = document.createElement('div');
        el.id = 'zz-ev';
        el.style.cssText = 'position:absolute;left:0;top:0;width:1400px;background:#0b1020;color:#e6e9f0;font:14px/1.5 ui-monospace,Consolas,monospace;padding:22px 26px;box-sizing:border-box;';
        el.innerHTML = h;
        document.body.appendChild(el);
      }, s);
      const height = await page.evaluate(() => Math.ceil(document.getElementById('zz-ev').getBoundingClientRect().height));
      await page.setViewportSize({ width: 1400, height });
      await page.screenshot({ path: outFile, clip: { x: 0, y: 0, width: 1400, height } });
    };
    const admin = await apiAs('ADMIN');
    const now = await state(admin);
    const deploys = await deployments(['oto-api-staging', 'oto-console-staging', 'oto-pos-web-staging'], arg);
    await admin.signOut();
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent('<html><body style="margin:0;background:#0b1020"></body></html>');
    const lines = [...now.movements].reverse().map((m) =>
      `${m.occurredAt.slice(0, 19).replace('T', ' ')} UTC  ${m.kind.padEnd(12)} ${String(m.quantity).padStart(3)}  count after ${m.levelAfter}` +
      `${m.shortfall ? `  short ${m.shortfall}` : ''}${m.saleId ? '  on a ฿0 sale' : ''}${m.reason ? `  "${m.reason}"` : ''}`);
    const file = resolve(out, '10-ledger-card-movements.png');
    await card(page, {
      title: 'SCRUM-1040 — ZZ TEST Mystery Box at Central Floresta: its movements',
      subtitle: 'Read back from the platform after the till hand-overs (GET /branches/:id/stock/movements and /stock/attention)',
      identity: 'Console administrator (seeded demo account)',
      deploy: Object.entries(deploys).map(([n, d]) => `${n} ${d.status} ${String(d.sha).slice(0, 9)}`).join(' · '),
      rows: [
        { ok: true, tag: 'COUNT', head: `count now ${now.item?.total}`, note: `${now.item?.name}, no product (counted, never sold)` },
        { ok: true, tag: 'LEDGER', head: `${now.movements.length} movements, oldest first`, note: 'each hand-over is one line, once', body: lines.join('\n') },
        { ok: true, tag: 'ALERT', head: `${now.attention.length} stock alert(s) for the item`, note: 'a hand-over at zero asks someone to count the shelf',
          body: now.attention.map((a) => `${a.kind}: ${a.summary}${a.resolvedAt ? ' (resolved)' : ''}`).join('\n') || 'none' },
      ],
    }, file);
    await browser.close();
    receipt.steps.card = { at: new Date().toISOString(), picture: rel(file), state: now };
    save();
    console.log(JSON.stringify(receipt.steps.card, null, 1));
  }

  if (phase === 'cleanup') {
    // Unlink and archive the ZZ TEST voucher type; close the ZZ TEST shortfall
    // alert; retire the ZZ TEST item (it keeps its history).
    const { page, close } = await browserFor(CONSOLE, 'ADMIN');
    const done = {};
    try {
      await page.goto(CONSOLE + '/catalogue/voucher-types', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'New voucher type' }).first().waitFor();
      await page.waitForTimeout(2000);
      await page.getByText(TYPE, { exact: true }).first().click();
      const drawer = page.getByRole('dialog');
      const picker = drawer.getByLabel(`Stock item at ${PARK_NAME}`);
      await picker.waitFor();
      await picker.selectOption('');
      await page.waitForTimeout(4000);
      done.unlinked = (await picker.inputValue()) === '';
      await drawer.getByRole('button', { name: 'Archive voucher type', exact: true }).click();
      await drawer.getByRole('button', { name: 'Archive', exact: true }).click();
      await page.waitForTimeout(4000);
      await onInventory(page);
      await page.getByRole('button', { name: `Edit ${ITEM}`, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('label', { hasText: /^Active$/ }).locator('input[type="checkbox"]').uncheck();
      await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
      await dialog.waitFor({ state: 'detached', timeout: 30000 });
      done.retired = true;
    } catch (e) { await debugShot(page, 'cleanup'); throw e; } finally { done.session = await close(); }
    const admin = await apiAs('ADMIN');
    const before = await state(admin);
    done.resolved = [];
    for (const a of before.attention.filter((x) => !x.resolvedAt)) {
      const r = await admin.call('POST', `/branches/${before.park.id}/stock/attention/${a.id}/resolve`, undefined, { 'idempotency-key': `zz-s1040-resolve-${a.id}` });
      done.resolved.push({ kind: a.kind, status: r.status });
    }
    done.at = new Date().toISOString();
    done.state = await state(admin);
    done.meAfterSignOut = await admin.signOut();
    receipt.steps.cleanup = done;
    save();
    console.log(JSON.stringify(done, null, 1));
  }
} catch (e) {
  save();
  throw e;
}

async function expectOption(select, name) {
  for (let i = 0; i < 20; i += 1) {
    if (await select.locator('option', { hasText: name }).count()) return;
    await select.page().waitForTimeout(1000);
  }
  throw new Error(`the till offers no "${name}" to issue`);
}

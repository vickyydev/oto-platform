S.phase = "6: the BEO after the till's edit, the OTO App's Activity Logbook, the platform's audit row";
const page = S.app.page;
S.openBeo = async (id) => {
  await page.goto(S.APP + '/studio/events/kanban?beo=' + id, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.getByTestId('accordion-event-info').waitFor({ timeout: 120000 });
  await page.waitForTimeout(2500);
};
S.openSection = async (tid) => {
  const trig = page.getByTestId(tid).first();
  await trig.waitFor({ state: 'visible', timeout: 60000 });
  if ((await trig.getAttribute('data-state')) !== 'open') { await trig.click(); await page.waitForTimeout(900); }
};
S.appShot = async (name, tid, block = 'start') => {
  if (tid) { const l = page.getByTestId(tid).first(); await l.scrollIntoViewIfNeeded(); await l.evaluate((el, b) => el.scrollIntoView({ block: b }), block); await page.waitForTimeout(500); }
  await S.hideBoard(page);
  try { return await S.shot(page, name, [], { element: page.locator('[role=dialog]').first() }); } finally { await S.showBoard(page); }
};
S.beoRows = async () => ({
  kids: await page.evaluate(() => [...document.querySelectorAll('[data-testid^="menu-item-kids-"]')].filter(r => /^menu-item-kids-\d+$/.test(r.getAttribute('data-testid'))).map(r => (r.innerText || '').replace(/\s+/g, ' ').trim() + ' | inputs: ' + [...r.querySelectorAll('input')].map(i => i.value).join(' / '))),
});
const r = {};
S.inPlace = p => [];
await S.openBeo(S.p1);
await S.openSection('accordion-kitchen-plan');
await page.getByTestId('button-menu-tab-kids').click().catch(() => {});
await page.waitForTimeout(600);
r.kidsRows = (await S.beoRows()).kids;
r.setBlock = await page.evaluate(() => { const b = document.querySelector('.border-emerald-500\\/40'); return b ? (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 900) : null; });
r.cake = { time: await page.getByTestId('input-cake-time').first().inputValue().catch(() => null), timeText: S.flat(await page.getByTestId('input-cake-time').first().innerText().catch(() => '')), notes: await page.getByTestId('input-cake-notes').first().inputValue().catch(() => null) };
await S.appShot('06a-beo-kitchen-plan-set-menu.png', 'accordion-kitchen-plan', 'start');
const lastKid = r.kidsRows.length - 1;
await S.appShot('06b-beo-kitchen-plan-extra-lines.png', `menu-item-kids-${Math.max(0, lastKid)}`, 'center');
await S.appShot('06c-beo-cake.png', 'input-cake-notes', 'center');
await S.openSection('accordion-bar-plan');
r.barRows = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="bar-item-"]')].filter(x => /^bar-item-\d+$/.test(x.getAttribute('data-testid'))).map(x => (x.innerText || '').replace(/\s+/g, ' ').trim() + ' | inputs: ' + [...x.querySelectorAll('input')].map(i => i.value).join(' / ')));
r.barTimeText = await page.evaluate(() => { const el = document.querySelector('[data-testid="button-bar-time-edit"]'); return el ? (el.closest('div.flex')?.parentElement?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) : null; });
await S.appShot('06d-beo-bar-plan.png', 'accordion-bar-plan', 'start');
// the BEO's data, read back through the app's own route
const back = (await S.appCall('GET', `/events/${S.p1}/beo`)).body;
const show = l => `${l.source === 'set_menu' ? 'SET' : 'EXTRA'} ${l.itemName} x${l.quantity}${l.price ? ' @' + l.price : ''}${l.productCode ? ' [' + l.productCode + ']' : ''}${l.notes ? ' note "' + l.notes + '"' : ''}`;
r.beoApi = { kids: (back?.kitchenPlan?.menus?.kids ?? []).map(show), adults: (back?.kitchenPlan?.menus?.adults ?? []).map(show), bar: (back?.barPlan?.items ?? []).map(show), barTime: back?.barPlan?.serviceTime ?? null, cake: { time: back?.kitchenPlan?.cakeTime ?? null, notes: back?.kitchenPlan?.cakeNotes ?? null, qty: back?.kitchenPlan?.cakeQuantity ?? null } };
// the Activity Logbook, searched to this run's party
const logs = await S.appCall('GET', `/activity-logs?branchId=${S.APP_FLORESTA}&search=${encodeURIComponent('ZZ TEST 907')}&limit=20&offset=0`);
r.activityApi = { status: logs.status, total: logs.body?.totalCount ?? null, rows: (logs.body?.logs ?? []).map(l => ({ type: l.activityType ?? l.type, at: l.createdAt ? S.bkk(l.createdAt) : null, text: S.flat(l.description ?? l.message ?? l.title ?? '') })) };
for (const l of logs.body?.logs ?? []) { S.addName(l.userName); S.addName(l.performedByName); S.addName(l.user?.fullName); }
await page.goto(S.APP + '/activity-logbook', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByTestId('text-activity-logbook-title').waitFor({ timeout: 60000 });
await page.getByTestId('input-search-activity').fill('ZZ TEST 907');
await page.waitForTimeout(3500);
r.logbookRows = await page.locator('[data-testid^="activity-log-"]').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
S.inPlace = p => [p.locator('[data-testid^="activity-log-"]').filter({ hasNotText: 'ZZ TEST' })];
await S.shot(page, '06e-oto-app-activity-logbook.png');
S.inPlace = p => [];
// the platform's audit: party.kitchen_update rows for the party, as admin
const audit = await S.auditOf('party.kitchen_update', S.p1.toLowerCase());
r.audit = { rows: audit.length, entries: audit.map(e => ({ at: S.bkk(e.createdAt), action: e.action, entityType: e.entityType, before: e.before, after: { ...e.after, by: e.after?.by ? { name: '[name]', role: e.after.by.role } : null } })) };
for (const e of audit) S.addName(e.after?.by?.name);
S.receipt.reads.p6 = r;
return r;

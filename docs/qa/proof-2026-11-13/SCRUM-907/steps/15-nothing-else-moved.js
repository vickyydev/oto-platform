S.phase = "13: nothing else moved: reception's party page after the refund, reception's headcount edit, a party with no kitchen plan";
const r = {};
const till = S.pages.rec.page;
await S.unlock('rec');
await S.openParty(till, S.p1, S.P1);
await till.waitForTimeout(2500);
const buttons = async () => { const out = []; for (const b of await till.getByRole('button').all()) { const t = S.flat(await b.innerText().catch(() => '')); if (/Settle party|Edit party|Print party slips now|Take balance|Fully paid|Add F&B|Resume settlement|Settled/.test(t) && await b.isVisible()) out.push(t); } return out; };
r.p1AfterRefund = { bill: S.flat(await S.cardOf(till, 'Party bill').innerText().catch(() => '')), buttons: await buttons() };
await till.mouse.wheel(0, -3000); await till.waitForTimeout(400);
await S.shot(till, '13a-reception-party-page-after-refund.png');
// reception: Expected adults 2 -> 3 on party 1 (the kitchen cards read-only), Save
await S.unlock('rec');
await till.getByRole('button', { name: 'Edit party', exact: true }).first().click();
await till.getByRole('heading', { name: 'Edit party', exact: true }).waitFor({ timeout: 30000 });
await till.waitForTimeout(1500);
const adults = till.getByLabel('Expected adults', { exact: true });
r.adultsBefore = await adults.inputValue();
await adults.fill('3');
const resp = till.waitForResponse(x => /\/api\/parties\/[^/]+$/.test(new URL(x.url()).pathname) && ['PATCH', 'PUT'].includes(x.request().method()), { timeout: 120000 });
const kitchenCalls = [];
const onReq = q => { if (/\/kitchen-plan$/.test(new URL(q.url()).pathname) && q.method() === 'PUT') kitchenCalls.push(q.url()); };
till.on('request', onReq);
await till.getByRole('button', { name: 'Save changes', exact: true }).click();
const x = await resp.catch(e => null);
r.save = x ? { status: x.status(), method: x.request().method(), body: x.request().postDataJSON() ? Object.keys(x.request().postDataJSON()) : null, fields: (() => { const b = x.request().postDataJSON() ?? {}; const { editId, actionId, branchId, stationId, ...rest } = b; return rest; })() } : null;
await till.waitForTimeout(1500);
r.toast = await till.locator('li[data-state="open"], [role="status"]').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(t => t && !/out of stock/.test(t)));
await till.waitForTimeout(3000);
till.off('request', onReq);
r.kitchenWritesBySave = kitchenCalls.length;
r.headcountOnPage = S.flat(await till.getByText(/kids · \d+ adults/).first().innerText().catch(() => ''));
await till.mouse.wheel(0, -3000); await till.waitForTimeout(400);
await S.shot(till, '13b-reception-headcount-saved.png');
const app = await S.appCall('GET', `/admin/events/${S.p1}`);
r.otoApp = { status: app.status, numAdults: app.body?.numAdults ?? null, numChildren: app.body?.numChildren ?? null };
r.partyApi = { expectedAdults: (await S.party(S.p1)).body?.event?.party?.expectedAdults ?? (await S.party(S.p1)).body?.event?.numAdults ?? null };
r.kitchenAuditRows = (await S.auditOf('party.kitchen_update', S.p1.toLowerCase())).length;
// party 3: no kitchen plan at all
S.P3 = 'ZZ TEST 907 no kitchen plan';
const ev = await S.appCall('POST', '/admin/events', { eventType: 'birthday', title: S.P3, branchId: S.APP_FLORESTA, eventDate: S.bizDate, startTime: '17:00', endTime: '19:00', durationMinutes: 120, numChildren: 2, numAdults: 1, childName: 'ZZ TEST child three', status: 'upcoming' });
S.assert.equal(ev.status, 201, 'party 3 created');
S.p3 = ev.body.id;
S.receipt.created.push({ kind: 'oto-app party', id: S.p3, title: S.P3 }); S.save();
r.p3Till = await S.tillRead(S.p3, 'p3-made');
for (const [label, who] of [['rec', 'reception'], ['mgr', 'manager']]) {
  const pg = S.pages[label].page;
  await S.unlock(label);
  await pg.goto(`/parties?party=${S.p3}`); await pg.waitForTimeout(4000);
  if (!(await pg.getByText(S.P3).first().isVisible().catch(() => false))) { await pg.goto('/parties'); await pg.waitForTimeout(3000); await pg.getByText(S.P3).first().click(); await pg.waitForTimeout(3000); }
  const page = { kitchen: S.flat(await S.cardOf(pg, 'Kitchen plan').innerText().catch(() => '')).slice(0, 500) };
  await pg.getByRole('button', { name: 'Edit party', exact: true }).first().click();
  await pg.getByRole('heading', { name: 'Edit party', exact: true }).waitFor({ timeout: 30000 });
  await pg.waitForTimeout(2000);
  const kc = S.cardOf(pg, 'Kitchen plan');
  const bc = S.cardOf(pg, 'Bar plan');
  const sw = pg.getByRole('switch', { name: 'Kitchen service needed' });
  page.form = { kitchen: S.flat(await kc.innerText().catch(() => '')).slice(0, 600), bar: S.flat(await bc.innerText().catch(() => '')).slice(0, 300),
    kitchenServiceNeeded: (await sw.count()) ? await sw.first().getAttribute('aria-checked') : `no switch named so (${await pg.getByText('Kitchen service needed').count()} texts)`,
    addItem: await kc.getByRole('button', { name: /Add item/ }).count(), readOnlyLine: await kc.getByText('A manager changes the kitchen plan.', { exact: true }).count() };
  await S.tallShot(pg, `13${label === 'rec' ? 'c' : 'd'}-${who}-no-kitchen-plan-party-edit-cards.png`, kc);
  await pg.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await pg.waitForTimeout(1500);
  r[`p3${who}`] = page;
}
S.receipt.reads.p13 = r;
return r;

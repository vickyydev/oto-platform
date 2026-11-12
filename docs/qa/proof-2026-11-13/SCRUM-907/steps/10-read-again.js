S.phase = "10: Edit open on the till; Calamari removed in the BEO and saved there; the till's Calamari change refused; Cancel, Edit opens without Calamari";
const till = S.pages.mgr.page;
const page = S.app.page;
const r = {};
await S.unlock('mgr');
await S.openParty(till, S.p1, S.P1);
await till.getByRole('button', { name: 'Edit party', exact: true }).first().click();
await till.getByRole('heading', { name: 'Edit party', exact: true }).waitFor({ timeout: 30000 });
const kc = () => S.cardOf(till, 'Kitchen plan');
await kc().getByRole('button', { name: /Add item/ }).first().waitFor({ timeout: 30000 });
r.formHasCalamari = await kc().getByRole('button', { name: 'Add one Calamari quantity', exact: true }).count();
// in the BEO editor: remove Calamari, Save
S.inPlace = p => [];
await S.openBeo(S.p1);
await S.openSection('accordion-kitchen-plan');
await page.getByTestId('button-menu-tab-kids').click().catch(() => {});
await page.waitForTimeout(600);
const idx = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid^="menu-item-kids-"]')].filter(x => /^menu-item-kids-\d+$/.test(x.getAttribute('data-testid')));
  const row = rows.find(x => [...x.querySelectorAll('input')].some(i => /^Calamari$/.test(i.value.trim())) || /(^|\s)Calamari(\s|$)/.test(x.innerText));
  return row ? row.getAttribute('data-testid').split('-').pop() : null;
});
S.assert.ok(idx !== null, 'the Calamari row in the BEO');
r.beoRowRemoved = S.flat(await page.getByTestId(`menu-item-kids-${idx}`).innerText());
await page.getByTestId(`button-remove-menu-item-kids-${idx}`).click();
await page.waitForTimeout(500);
const done = page.waitForResponse(x => /\/api\/events\/[^/]+\/beo$/.test(new URL(x.url()).pathname) && x.request().method() === 'PUT', { timeout: 120000 });
await page.getByTestId('button-save-beo').click();
r.beoSave = (await done).status();
r.beoKidsAfter = ((await S.appCall('GET', `/events/${S.p1}/beo`)).body?.kitchenPlan?.menus?.kids ?? []).map(l => `${l.itemName} x${l.quantity}`);
// on the till, the form still open on the old read: Calamari +1, Save
await till.bringToFront();
await S.unlock('mgr');
await kc().getByRole('button', { name: 'Add one Calamari quantity', exact: true }).click();
const resp = till.waitForResponse(x => /\/api\/parties\/[^/]+\/kitchen-plan$/.test(new URL(x.url()).pathname) && x.request().method() === 'PUT', { timeout: 120000 });
await till.getByRole('button', { name: 'Save changes', exact: true }).click();
const x = await resp;
const xb = await x.json().catch(() => null);
r.put = { status: x.status(), code: xb?.error?.code ?? null, message: xb?.error?.message ?? null };
await till.waitForTimeout(1500);
r.toast = await till.locator('li[data-state="open"], [role="status"]').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
r.formStillOpen = { heading: await till.getByRole('heading', { name: 'Edit party', exact: true }).count(), save: await till.getByRole('button', { name: 'Save changes', exact: true }).count() };
await S.shot(till, '10a-till-refusal-form-still-open.png');
// Cancel, then Edit party
await till.waitForTimeout(3000);
await till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
await till.waitForTimeout(2500);
const presses = [];
for (let i = 0; i < 4; i++) {
  await till.getByRole('button', { name: 'Edit party', exact: true }).first().click();
  await till.waitForTimeout(2500);
  const open = await till.getByRole('heading', { name: 'Edit party', exact: true }).count();
  const toast = await till.locator('li[data-state="open"], [role="status"]').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
  presses.push({ open, toast });
  if (open) break;
  await till.waitForTimeout(2000);
}
r.editPresses = presses;
await kc().getByRole('button', { name: /Add item/ }).first().waitFor({ timeout: 30000 });
r.reopened = { calamariStepper: await kc().getByRole('button', { name: 'Add one Calamari quantity', exact: true }).count(), kitchen: S.flat(await kc().innerText()).slice(0, 1000) };
await kc().scrollIntoViewIfNeeded();
await S.tallShot(till, '10b-till-edit-reopened-without-calamari.png', kc());
await till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
await till.waitForTimeout(1500);
r.tillRead = await S.tillRead(S.p1, 'p1-after-read-again');
r.kitchenEditAudit = (await S.auditOf('party.kitchen_update', S.p1.toLowerCase())).length;
S.receipt.reads.p10 = r;
return r;

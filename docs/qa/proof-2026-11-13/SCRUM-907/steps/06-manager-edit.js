S.phase = '5: the branch manager edits the kitchen plan on the till and saves';
if (!S.pages.mgr) await S.signIn('mgr', 'STAGING_MANAGER_PHONE', 'STAGING_MANAGER_PASSWORD', { width: 1440, height: 900 });
const till = S.pages.mgr.page;
await S.unlock('mgr');
await S.openParty(till, S.p1, S.P1);
const r = {};
r.pageBefore = { kitchen: await S.cardText(till, 'Kitchen plan'), bar: await S.cardText(till, 'Bar plan') };
await till.getByRole('button', { name: 'Edit party', exact: true }).first().click();
await till.getByRole('heading', { name: 'Edit party', exact: true }).waitFor({ timeout: 30000 });
const kc = S.cardOf(till, 'Kitchen plan');
const bc = S.cardOf(till, 'Bar plan');
await kc.getByRole('button', { name: /Add item/ }).first().waitFor({ timeout: 30000 });
await till.waitForTimeout(2500);
r.formOpened = { kitchen: S.flat(await kc.innerText()).slice(0, 900), readOnlyLine: await kc.getByText('A manager changes the kitchen plan.', { exact: true }).count(),
  removeButtons: await kc.getByRole('button', { name: /^Remove .* item$/ }).evaluateAll(els => els.map(e => e.getAttribute('aria-label'))),
  choiceSelects: await kc.getByRole('combobox').evaluateAll(els => els.map(e => e.getAttribute('aria-label'))) };
await kc.scrollIntoViewIfNeeded();
await S.tallShot(till, '05a-manager-edit-kitchen-card-as-opened.png', kc);
// Calamari x2 -> x3, note "no sauce"
await kc.getByRole('button', { name: 'Add one Calamari quantity', exact: true }).click();
await kc.getByRole('textbox', { name: 'Calamari note', exact: true }).fill('no sauce');
// Fried rice: Veggie -> Chicken (the group's own options only)
const fr = kc.getByRole('combobox', { name: 'Fried rice choice', exact: true });
await fr.click();
await till.waitForTimeout(600);
r.friedRiceOptions = await till.getByRole('option').evaluateAll(els => els.map(e => ({ text: e.textContent.trim(), disabled: e.getAttribute('aria-disabled') === 'true' || e.hasAttribute('data-disabled') })));
await S.shot(till, '05b-manager-fried-rice-choices.png');
await till.getByRole('option', { name: 'Fried rice: Chicken', exact: true }).click();
await till.waitForTimeout(400);
// Add item: search "fries", pick French fries
await kc.getByRole('button', { name: /Add item/ }).first().click();
const newFood = () => kc.getByRole('textbox', { name: 'New food item', exact: true }).last();
await newFood().click();
await newFood().fill('fries');
await till.waitForTimeout(800);
r.friesMatches = await kc.locator('div.absolute button').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
await S.tallShot(till, '05c-manager-add-item-search-fries.png', kc);
await kc.locator('div.absolute button').filter({ hasText: /^French fries/ }).first().click();
await till.waitForTimeout(400);
r.friesPicked = { value: await newFood().inputValue(), hint: S.flat(await kc.getByText(/^Till item /).last().innerText().catch(() => '')) };
// Add item typed: ZZ TEST lemon cake
await kc.getByRole('button', { name: /Add item/ }).first().click();
await newFood().click();
await newFood().fill('ZZ TEST lemon cake');
await newFood().press('Tab');
await till.waitForTimeout(500);
r.lemonHint = S.flat(await kc.getByText('not on the till menu', { exact: true }).last().innerText().catch(() => ''));
// remove ZZ TEST fruit plate
await kc.getByRole('button', { name: 'Remove ZZ TEST fruit plate item', exact: true }).click();
// the cake 21:00 and "ZZ TEST rainbow"
await kc.getByLabel('Cake time', { exact: true }).fill('21:00');
await kc.getByLabel('Cake note', { exact: true }).fill('ZZ TEST rainbow');
// the bar: Mineral water x3
await bc.getByRole('button', { name: 'Add one Mineral water quantity', exact: true }).click();
await till.waitForTimeout(500);
r.formBeforeSave = { kitchen: S.flat(await kc.innerText()).slice(0, 1200), kitchenInputs: await kc.locator('input').evaluateAll(els => els.map(e => e.value).filter(Boolean)), bar: S.flat(await bc.innerText()).slice(0, 400) };
await kc.scrollIntoViewIfNeeded();
await S.tallShot(till, '05d-manager-kitchen-card-before-save.png', kc);
await bc.scrollIntoViewIfNeeded();
await S.tallShot(till, '05e-manager-bar-card-before-save.png', bc);
// Save
S.seenBeforeEdit = { kitchen: [...S.seen.kitchen], bar: [...S.seen.bar] };
const resp = till.waitForResponse(x => /\/api\/parties\/[^/]+\/kitchen-plan$/.test(new URL(x.url()).pathname) && x.request().method() === 'PUT', { timeout: 120000 });
r.savedAt = new Date().toISOString();
S.editSavedAt = r.savedAt;
await till.getByRole('button', { name: 'Save changes', exact: true }).click();
const x = await resp;
const xb = await x.json().catch(() => null);
r.put = { status: x.status(), request: x.request().postDataJSON()?.changes ?? null, kitchenEdit: xb?.kitchenEdit ?? null, error: xb?.error ?? null };
await till.waitForTimeout(1200);
r.toast = await till.locator('li[data-state="open"], [role="status"]').evaluateAll(els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));
await S.shot(till, '05f-manager-saved-toast.png');
await till.waitForTimeout(4000);
r.formClosed = { editHeading: await till.getByRole('heading', { name: 'Edit party', exact: true }).count() };
r.pageAfter = { kitchen: await S.cardText(till, 'Kitchen plan'), bar: await S.cardText(till, 'Bar plan') };
await S.cardOf(till, 'Kitchen plan').scrollIntoViewIfNeeded();
await S.tallShot(till, '05g-party-page-kitchen-card-after-save.png', S.cardOf(till, 'Kitchen plan'));
await S.tallShot(till, '05h-party-page-bar-card-after-save.png', S.cardOf(till, 'Bar plan'));
r.tillRead = await S.tillRead(S.p1, 'p1-after-manager-edit');
S.receipt.reads.p5edit = r;
return r;

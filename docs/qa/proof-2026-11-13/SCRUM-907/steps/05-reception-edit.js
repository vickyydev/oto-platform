S.phase = '4: reception opens Edit party: the Kitchen and Bar cards read-only, no Add item, no remove; Cancel';
const till = S.pages.rec.page;
await S.unlock('rec');
await S.openParty(till, S.p1, S.P1);
await till.getByRole('button', { name: 'Edit party', exact: true }).first().click();
await till.getByRole('heading', { name: 'Edit party', exact: true }).waitFor({ timeout: 30000 });
await till.waitForTimeout(2500);
const card = t => S.cardOf(till, t);
const r = {};
for (const t of ['Kitchen plan', 'Bar plan']) {
  const c = card(t);
  r[t] = {
    text: S.flat(await c.innerText().catch(() => '')).slice(0, 900),
    readOnlyLine: await c.getByText('A manager changes the kitchen plan.', { exact: true }).count(),
    addItem: await c.getByRole('button', { name: /Add item/ }).count(),
    remove: await c.getByRole('button', { name: /^Remove .* item$/ }).count(),
    steppers: await c.getByRole('button', { name: /^Add one / }).count(),
    enabledInputs: await c.locator('input:not([disabled])').count(),
    choiceSelects: await c.getByRole('combobox').evaluateAll(els => els.map(e => ({ label: e.getAttribute('aria-label'), disabled: e.hasAttribute('disabled') || e.getAttribute('data-disabled') !== null }))),
    values: await c.locator('input').evaluateAll(els => els.map(e => e.value).filter(Boolean)),
  };
}
await card('Kitchen plan').scrollIntoViewIfNeeded();
await S.tallShot(till, '04a-reception-edit-kitchen-card-read-only.png', card('Kitchen plan'));
await card('Bar plan').scrollIntoViewIfNeeded();
await S.tallShot(till, '04b-reception-edit-bar-card-read-only.png', card('Bar plan'));
await card('Kitchen plan').scrollIntoViewIfNeeded();
await S.shot(till, '04c-reception-edit-form-1440.png');
await till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
await till.waitForTimeout(2000);
r.afterCancel = { editHeading: await till.getByRole('heading', { name: 'Edit party', exact: true }).count(), editButton: await till.getByRole('button', { name: 'Edit party', exact: true }).count() };
S.receipt.reads.p4reception = r;
return r;

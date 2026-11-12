S.phase = '11: a set-menu dish is not removed on the till; a choice changes only within its own group (the form, then the door itself as the manager)';
const till = S.pages.mgr.page;
await S.unlock('mgr');
await S.openParty(till, S.p1, S.P1);
const r = {};
await till.getByRole('button', { name: 'Edit party', exact: true }).first().click();
await till.getByRole('heading', { name: 'Edit party', exact: true }).waitFor({ timeout: 30000 });
const kc = S.cardOf(till, 'Kitchen plan');
await kc.getByRole('button', { name: /Add item/ }).first().waitFor({ timeout: 30000 });
await till.waitForTimeout(1500);
r.form = {
  removeButtons: await kc.getByRole('button', { name: /^Remove .* item$/ }).evaluateAll(els => els.map(e => e.getAttribute('aria-label'))),
  setMenuRows: await kc.locator('input[disabled]').evaluateAll(els => els.map(e => e.value).filter(Boolean)),
  choiceSelects: await kc.getByRole('combobox').evaluateAll(els => els.map(e => e.getAttribute('aria-label')).filter(Boolean)),
};
// each choice group's options as the form offers them
r.form.options = {};
for (const label of r.form.choiceSelects) {
  await kc.getByRole('combobox', { name: label, exact: true }).click();
  await till.waitForTimeout(500);
  r.form.options[label] = await till.getByRole('option').evaluateAll(els => els.map(e => e.textContent.trim()));
  await till.keyboard.press('Escape');
  await till.waitForTimeout(300);
}
await till.getByRole('button', { name: 'Cancel', exact: true }).first().click();
await till.waitForTimeout(1500);
// the door itself, as the signed-in manager: a set-menu dish removed, and a choice from another group
const p = (await S.party(S.p1)).body;
const lines = p.kitchenPlan.setMenu;
const fries = lines.find(m => m.origin === 'set_menu' && m.name === 'French fries');
const rice = lines.find(m => m.choiceGroup === 'Fried rice');
const put = async (changes) => {
  const res = await till.request.put(`/api/parties/${S.p1}/kitchen-plan`, { data: { branchId: S.branchId, stationId: S.station.id, editId: S.randomUUID(), changes }, headers: { 'idempotency-key': S.randomUUID() } });
  const b = await res.json().catch(() => null);
  return { status: res.status(), code: b?.error?.code ?? null, message: b?.error?.message ?? null };
};
r.door = {
  removeSetMenuFries: await put([{ op: 'remove', lineId: fries.lineId }]),
  chooseOtherGroupsOption: await put([{ op: 'choose', choiceGroup: 'Fried rice', lineId: rice.lineId, option: 'Margherita' }]),
};
r.after = (await S.tillRead(S.p1, 'p1-after-guard')).kitchenPlan.lines.filter(l => /French fries|Fried rice/.test(l));
r.kitchenEditAudit = (await S.auditOf('party.kitchen_update', S.p1.toLowerCase())).length;
await S.facts('11a-set-menu-guard-door-answers.png', 'SCRUM-907 point 11: the kitchen-plan door refuses a set-menu removal and a choice from another group (as the branch manager)', [
  ['The form: remove buttons (EXTRAs only)', r.form.removeButtons.join(', ')],
  ['The form: choice selects', r.form.choiceSelects.join(', ')],
  ['The form: Fried rice options', (r.form.options['Fried rice choice'] ?? []).join(' / ')],
  ['PUT /api/parties/:id/kitchen-plan  remove the set-menu French fries', `${r.door.removeSetMenuFries.status} ${r.door.removeSetMenuFries.code}\n${r.door.removeSetMenuFries.message}`],
  ['PUT /api/parties/:id/kitchen-plan  Fried rice -> "Margherita" (a Pizza option)', `${r.door.chooseOtherGroupsOption.status} ${r.door.chooseOtherGroupsOption.code}\n${r.door.chooseOtherGroupsOption.message}`],
  ['The plan after both (GET /api/parties/:id)', r.after.join('\n')],
  ['party.kitchen_update audit rows for the party', String(r.kitchenEditAudit)],
]);
S.receipt.reads.p11 = r;
return r;

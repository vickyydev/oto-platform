// Plan step 11, read-only: the recorded "Residence certificate" check on ZZ TEST Tier Thai still reads as filed,
// on the till's member card and in the Console's proof picker. Nothing is rung up or saved.
export default async function (S) {
  const { text, lookup, unlockIfLocked } = S.lib;
  const id = S.st.steps.s11.zzMember.id;
  const m = await S.adminApi('GET', '/members/' + id);
  const phone = (m.body?.member ?? m.body).phone;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  await page.getByRole('button', { name: 'Tickets', exact: true }).click();
  await page.getByText('Membership Check', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1200);
  await lookup(page, phone);
  await page.waitForTimeout(1500);
  const st = (S.st.steps.s11.till = { at: new Date().toISOString() });
  st.card = (await text(page, 5000)).split('Select Customer Type')[1]?.slice(0, 700);
  st.readsResidence = /Residence certificate/.test(st.card ?? '');
  await page.getByText('Local pricing', { exact: true }).scrollIntoViewIfNeeded();
  await S.shot('till', 's773-st-11a-till-member-recorded-residence-certificate');
  // Leave the empty order without ringing anything up.
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await page.waitForTimeout(1500);
  st.afterCancel = (await text(page, 3000)).includes('Membership Check');
  const c = S.pages.console.page;
  await c.goto(S.CONSOLE + '/catalogue/members', { waitUntil: 'domcontentloaded' });
  const edit = c.locator('button[aria-label="Edit ZZ TEST Tier Thai"]:visible').first();
  await edit.waitFor({ timeout: 45000 });
  await edit.scrollIntoViewIfNeeded();
  await edit.click();
  const dlg = c.getByRole('dialog');
  await dlg.getByText('Edit member').waitFor({ timeout: 30000 });
  await c.waitForTimeout(1200);
  await dlg.getByRole('combobox', { name: 'Proof type' }).click();
  const list = c.getByRole('listbox');
  await list.waitFor({ timeout: 15000 });
  st.consoleOptions = (await list.getByRole('option').allTextContents()).map((t) => t.trim());
  st.consoleHolds = /Holds [^\n]*/.exec(await dlg.innerText())?.[0] ?? null;
  await c.waitForTimeout(500);
  await S.shot('console', 's773-st-11b-console-recorded-residence-certificate-option');
  await c.keyboard.press('Escape');
  await c.waitForTimeout(400);
  await c.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  st.consoleDialogClosed = (await c.getByRole('dialog').count()) === 0;
  S.save();
  return st;
}

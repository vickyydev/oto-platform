// Step 5: Thai Full Day Pass, one kid and the free adult (nobody earns a wallet), two pairs of socks.
export default async function (S) {
  const { text, LOOK, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const st = (S.st.steps.s5 = { startedAt: new Date().toISOString(), note: 'Thai Full Day Pass with the free adult: the only staging package and tier where nobody earns a wallet with an adult on the sale (a kid alone opens the children-playing-alone flow).' });
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Passport', exact: true }).click();
  await dlg.getByRole('button', { name: /^Verify Thai — Passport/ }).click();
  await dlg.waitFor({ state: 'detached', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.getByRole('heading', { name: 'Full Day Pass', exact: true }).click();
  await page.getByRole('heading', { name: /^Configure:/ }).waitFor();
  await page.getByRole('button', { name: 'Sizes' }).click();
  const sz = page.getByRole('dialog');
  await sz.waitFor();
  await sz.getByRole('button', { name: 'Add one Grip Socks M' }).click();
  await sz.getByRole('button', { name: 'Add one Grip Socks M' }).click();
  await sz.getByRole('button', { name: 'Add 2', exact: true }).click();
  await sz.waitFor({ state: 'detached' }).catch(() => {});
  await page.waitForTimeout(1200);
  st.configure = (await text(page, 6000)).split('Review →').pop()?.slice(0, 1600);
  await page.screenshot({ path: LOOK });
  S.save();
  return st;
}

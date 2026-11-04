export default async function (S) {
  const { LOOK, text } = S.lib;
  const page = S.pages.till.page;
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Add one Grip Socks M' }).click();
  await dlg.getByRole('button', { name: 'Add one Grip Socks M' }).click();
  await page.waitForTimeout(400);
  const dlgText = (await dlg.innerText()).slice(0, 600);
  await dlg.getByRole('button', { name: 'Close' }).click();
  await dlg.waitFor({ state: 'detached' }).catch(() => {});
  await page.getByRole('button', { name: 'Add one Bracelet Workshop' }).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: LOOK });
  return { dlgText, text: (await text(page, 5000)).split('Review →')[1]?.slice(0, 1800) };
}

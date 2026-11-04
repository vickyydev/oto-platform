export default async function (S) {
  const { LOOK, text } = S.lib;
  const page = S.pages.till.page;
  await page.getByRole('button', { name: 'Sizes' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.waitFor();
  await dlg.getByRole('button', { name: 'Add one Grip Socks M' }).click();
  await dlg.getByRole('button', { name: 'Add one Grip Socks M' }).click();
  await dlg.getByRole('button', { name: 'Add 2', exact: true }).click();
  await dlg.waitFor({ state: 'detached' }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: LOOK });
  return { text: (await text(page, 5000)).split('Current Order')[1]?.slice(0, 900) };
}

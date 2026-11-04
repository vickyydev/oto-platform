export default async function (S) {
  const { LOOK, text } = S.lib;
  const page = S.pages.till.page;
  const gridSocks = page.getByRole('button', { name: 'Add one Regular Socks' });
  const states = [];
  for (let i = 0; i < await gridSocks.count(); i += 1) states.push(await gridSocks.nth(i).isDisabled());
  await page.getByRole('button', { name: 'Sizes' }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: LOOK });
  const dlg = page.getByRole('dialog');
  return { regularSocksDisabled: states, dialog: (await dlg.count()) ? (await dlg.innerText()).slice(0, 1500) : null, buttons: (await page.getByRole('dialog').getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim()))).slice(0, 40) };
}

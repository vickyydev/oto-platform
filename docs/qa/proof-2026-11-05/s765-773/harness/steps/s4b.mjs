export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  await page.getByRole('button', { name: 'Reprint', exact: true }).click();
  await page.waitForTimeout(2000);
  const dlg = page.getByRole('dialog');
  const st = S.st.steps.s4screen;
  st.reprintList = (await dlg.count()) ? (await dlg.first().innerText()).slice(0, 1500) : (await text(page, 8000)).split('Reprint').slice(1).join('Reprint').slice(0, 1500);
  st.reprintButtons = (await ((await dlg.count()) ? dlg.first() : page).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim()))).slice(0, 30);
  await S.shot('till', 's765-st-04b-history-reprint-list-no-socks-slip');
  S.save();
  return st;
}

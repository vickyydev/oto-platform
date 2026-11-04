export default async function (S) {
  const { LOOK, text } = S.lib;
  const page = S.pages.console.page;
  const opens = page.getByText('Open →');
  const n = await opens.count();
  let idx = -1;
  for (let i = 0; i < n; i += 1) {
    const t = await opens.nth(i).evaluate((el) => { let p = el; for (let k = 0; k < 6 && p; k += 1) { p = p.parentElement; if (p && /virtual-1 ·/.test(p.textContent)) return p.textContent.slice(0, 80); } return null; });
    if (t && /Virtual box 1/.test(t) && !/Virtual box 2/.test(t)) { idx = i; break; }
  }
  if (idx < 0) throw new Error('no Virtual box 1 card');
  await opens.nth(idx).click();
  await page.waitForTimeout(3000);
  const printing = page.getByRole('heading', { name: 'Printing', exact: true });
  await printing.waitFor({ timeout: 30000 });
  await printing.scrollIntoViewIfNeeded();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: LOOK });
  const dlg = page.getByRole('dialog');
  return { idx, dialogs: await dlg.count(), text: ((await dlg.count()) ? await dlg.first().innerText() : await text(page, 8000)).split('Printing')[1]?.slice(0, 2500) };
}

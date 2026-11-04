export default async function (S) {
  const { LOOK } = S.lib;
  const page = S.pages.console.page;
  const dlg = page.getByRole('dialog').first();
  await dlg.getByRole('heading', { name: 'Printing', exact: true }).scrollIntoViewIfNeeded();
  await S.shot('console', 's765-st-03-console-virtual-box-1-print-queue');
  for (const [chip, name] of [['Receipt Printer 1', 's765-st-03e-console-receipt-printer-1-paper'], ['Band Printer (kids)', 's765-st-03f-console-band-printer-kids-paper'], ['Band Printer (adults)', 's765-st-03g-console-band-printer-adults-paper']]) {
    await dlg.getByRole('button', { name: chip, exact: true }).click();
    await page.waitForTimeout(3500);
    const img = dlg.locator('img[alt^="Printout"]').first();
    await img.waitFor({ timeout: 20000 }).catch(() => {});
    await dlg.getByRole('button', { name: chip, exact: true }).scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(800);
    await S.shot('console', name);
  }
  return S.st.images.slice(-4).map((i) => i.file);
}

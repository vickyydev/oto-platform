export default async function (S) {
  const { text, LOOK, tendering, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const t0 = await tendering(S);
  const net = [];
  page.on('request', (req) => { if (/\/api\/sales/.test(req.url()) && req.method() !== 'GET') net.push(req.method() + ' ' + new URL(req.url()).pathname); });
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await page.waitForTimeout(1500);
  const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  let dlgText = null;
  if (await dlg.count()) { dlgText = (await dlg.first().innerText()).slice(0, 600); }
  await page.screenshot({ path: LOOK });
  const t1 = await tendering(S);
  return { dlgText, net, same: JSON.stringify(t0) === JSON.stringify(t1), text: (await text(page, 3000)).split('Review →').pop()?.slice(0, 600) };
}

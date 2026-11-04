// Plan step 9: History > the walk-in sale reads "Priced on other (Work permit)"; the sale read back.
export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const st = S.st.steps.s9n;
  const id = st.network.find((n) => /\/finalise$/.test(n.path))?.path.split('/')[3];
  await page.getByRole('button', { name: 'Start New Sale' }).click();
  await page.getByText('Membership Check', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByText(st.receipt, { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByText(st.receipt, { exact: true }).first().click();
  await page.getByText('Back to history').waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  st.detail = (await text(page, 8000)).split('Back to history')[1]?.slice(0, 1400);
  st.pricedOnLine = /Priced on other \(Work permit\), checked [^\n]*/i.exec(st.detail ?? '')?.[0] ?? null;
  await S.shot('till', 's773-st-09j-history-walk-in-sale-priced-on-other-work-permit');
  const sale = await S.adminApi('GET', '/sales/' + id);
  const b = sale.body;
  st.readBack = { at: new Date().toISOString(), id, receipt: b.sale.receiptNumber, status: b.sale.status, tier: b.sale.customerTier, memberId: b.sale.memberId, gross: b.sale.totals?.grossSatang, tierClaim: b.sale.tierClaim, printJobs: (b.printJobs ?? []).map((j) => j.kind) };
  S.st.created.push({ kind: 'sale', id, name: 'walk-in Thai claim on Other (Work permit), cash, kept for the record', receipt: st.receipt });
  S.save();
  return { pricedOnLine: st.pricedOnLine, readBack: st.readBack };
}

export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  const st = S.st.steps.s9;
  await page.getByRole('button', { name: 'Start New Sale' }).click();
  await page.getByText('Membership Check', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByText('T1-000086', { exact: true }).click();
  await page.waitForTimeout(3500);
  st.detail = (await text(page, 8000)).split('Back to history')[1]?.slice(0, 1500);
  await S.shot('till', 's773-st-09c-history-sale-document-other-work-permit');
  const sale = await S.adminApi('GET', '/sales/01a1a844-310d-7af7-b9e7-a942a389d02d');
  st.readBack = { receipt: sale.body.sale.receiptNumber, status: sale.body.sale.status, tier: sale.body.sale.customerTier, gross: sale.body.sale.totals.grossSatang, tierClaim: sale.body.sale.tierClaim, printJobs: sale.body.printJobs.map((j) => j.kind) };
  S.save();
  return { detail: st.detail, readBack: st.readBack };
}

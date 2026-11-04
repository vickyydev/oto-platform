// Plan step 9, the sale's own document line, read in History on the walk-in Thai claim sale T1-000087.
export default async function (S) {
  const { text, unlockIfLocked } = S.lib;
  const page = S.pages.till.page;
  await unlockIfLocked(S, page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByText('T1-000087', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByText('T1-000087', { exact: true }).first().click();
  await page.getByText('Back to history').waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const detail = (await text(page, 8000)).split('Back to history')[1]?.slice(0, 1500);
  const priced = /Priced on other \(Work permit\)/i.test(detail ?? '');
  await S.shot('till', 's773-st-09f-history-walk-in-sale-priced-on-other-work-permit');
  const sale = await S.adminApi('GET', '/sales/01a1a847-4764-7baf-a0e1-f6f372c454f9');
  const b = sale.body;
  const readBack = { at: new Date().toISOString(), receipt: b.sale.receiptNumber, status: b.sale.status, tier: b.sale.customerTier, member: b.sale.member?.nickname ?? null, tierClaim: b.sale.tierClaim ? { documentKind: b.sale.tierClaim.documentKind, documentNote: b.sale.tierClaim.documentNote ?? null, expiresAt: b.sale.tierClaim.documentExpiresAt ?? b.sale.tierClaim.expiresAt ?? null, verifiedBy: b.sale.tierClaim.verifiedByName ?? b.sale.tierClaim.verifiedBy ?? null } : null };
  S.st.steps.s9h = { at: new Date().toISOString(), detail, priced, readBack };
  S.save();
  return S.st.steps.s9h;
}

export default async function (S) {
  const { text } = S.lib;
  const page = S.pages.till.page;
  const st = S.st.steps.s8;
  const dlg = page.getByRole('dialog');
  st.expiry = '2029-12-31';
  await dlg.locator('#tier-evidence-expiry').fill(st.expiry);
  await page.waitForTimeout(500);
  st.futureDialog = (await dlg.innerText()).slice(0, 1200);
  await S.shot('till', 's773-st-08c-other-work-permit-future-expiry');
  await dlg.getByRole('button', { name: /^Verify Thai — Other — Work permit/ }).click();
  await dlg.waitFor({ state: 'detached', timeout: 30000 });
  st.verifiedAt = new Date().toISOString();
  await page.waitForTimeout(2000);
  st.after = (await text(page, 6000)).split('Review →').pop()?.slice(-500);
  await S.shot('till', 's773-st-08d-thai-rate-verified-other-work-permit');
  const m = await S.pageApi('till', 'GET', `/members/${S.st.fixture.members.other.id}`);
  st.member = { status: m.status, tierCode: m.body?.member?.tierCode, tierVerification: m.body?.member?.tierVerification ?? null };
  S.save();
  return st;
}

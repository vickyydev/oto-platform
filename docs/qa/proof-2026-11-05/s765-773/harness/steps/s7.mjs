// Plan step 7: Driving licence with a future expiry, saved; the member then reads Driving licence with the expiry.
export default async function (S) {
  const { text } = S.lib;
  const page = S.pages.till.page;
  const st = (S.st.steps.s7 = { startedAt: new Date().toISOString(), expiry: '2030-06-30' });
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Driving licence', exact: true }).click();
  await dlg.locator('#tier-evidence-expiry').fill(st.expiry);
  await page.waitForTimeout(500);
  st.dialog = (await dlg.innerText()).slice(0, 900);
  await S.shot('till', 's773-st-07a-driving-licence-with-expiry');
  const verify = dlg.getByRole('button', { name: /^Verify Thai/ });
  st.verifyLabel = (await verify.textContent())?.trim();
  await verify.click();
  await dlg.waitFor({ state: 'detached', timeout: 30000 });
  st.verifiedAt = new Date().toISOString();
  await page.waitForTimeout(2000);
  st.after = (await text(page, 6000)).split('Review →').pop()?.slice(0, 1600);
  await S.shot('till', 's773-st-07b-thai-rate-verified-driving-licence');
  const m = await S.pageApi('till', 'GET', `/members/${S.st.fixture.members.licence.id}`);
  st.member = { status: m.status, tierCode: m.body?.member?.tierCode, tierVerification: m.body?.member?.tierVerification ?? null };
  S.save();
  return st;
}

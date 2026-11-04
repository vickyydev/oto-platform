import assert from 'node:assert/strict';
export default async function (S) {
  const { st, save, newPage, expect, need, POS, pageApi } = S;
  const label = 'till';
  const { page } = await newPage(label, { width: 1600, height: 1050 });
  await page.goto(POS + '/');
  await expect(page.getByRole('heading', { name: 'Oto POS is locked' })).toBeVisible({ timeout: 60000 });
  await page.locator('input[inputmode="tel"], input[type="tel"]').first().fill(need('STAGING_RECEPTION_PHONE').replace(/^\+66/, '0'));
  await page.locator('input[type="password"]').first().fill(need('STAGING_RECEPTION_PASSWORD'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which station are you on?' })).toBeVisible({ timeout: 30000 });
  const options = (await page.getByRole('button').allTextContents()).map((t) => t.trim()).filter(Boolean).slice(0, 40);
  await page.getByRole('button', { name: /^Reception Till 1/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Which station are you on?' })).toBeHidden({ timeout: 30000 });
  await page.waitForTimeout(2500);
  const me = await pageApi(label, 'GET', '/me');
  assert.equal(me.status, 200);
  const link = await pageApi(label, 'GET', '/me/station/link');
  st.tills = st.tills ?? {};
  st.tills[label] = { accountId: me.body.account.id, accountName: me.body.account?.displayName ?? me.body.employee?.name ?? null, signedInAt: new Date().toISOString(), stationId: link.body?.stationId, onReceptionTill1: link.body?.stationId === '01a0bbdc-8cd7-7208-8e05-84eaf2963a9a' };
  save();
  return { tills: st.tills[label], options, text: (await page.locator('body').innerText()).slice(0, 800) };
}

export const LOOK = 'C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/h765/look.png';
/** DISABLED (proof agent 3): never press any button on a till notice this run did not create. Read them only. */
export async function dismissLeftBehind() {
  throw new Error('dismissLeftBehind is disabled: never press a button on a notice this run did not create');
}
export async function readLeftBehind(page) {
  return (await page.getByTestId('left-behind-sale').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 160));
}
export async function lookup(page, phone) {
  await page.getByText('Membership Check', { exact: true }).first().waitFor({ timeout: 30000 });
  const digits = phone.replace(/^\+66/, '');
  for (const d of digits) await page.getByRole('button', { name: d, exact: true }).last().click();
  await page.getByRole('button', { name: 'Find my membership' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  const type = page.getByText('Select Customer Type');
  await Promise.race([skip.waitFor({ timeout: 20000 }).catch(() => {}), type.waitFor({ timeout: 20000 }).catch(() => {})]);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await type.waitFor({ timeout: 20000 });
}
export const text = async (page, n = 3000) => (await page.locator('body').innerText()).slice(0, n);
export async function tendering(S) {
  const r = await S.adminApi('GET', `/sales?branchId=${S.st.fixture.branchId}&stationId=${S.st.fixture.till.id}&status=tendering&limit=50`);
  return (r.body?.sales ?? []).map((s) => s.id).sort();
}
export async function unlockIfLocked(S, page) {
  if (await page.getByRole('button', { name: 'Unlock', exact: true }).isVisible().catch(() => false)) {
    await page.locator('input[type="password"]').first().fill(S.need('STAGING_RECEPTION_PASSWORD'));
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByRole('button', { name: 'Unlock', exact: true }).waitFor({ state: 'hidden', timeout: 30000 });
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

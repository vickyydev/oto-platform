// Read-only: the till's own "left unpaid" notices, as text. Nothing is pressed.
export default async function (S) {
  const page = S.pages.till.page;
  await page.waitForTimeout(1500);
  const notices = await S.lib.readLeftBehind(page);
  const all = (await S.lib.text(page, 9000)).split('Issue a voucher…')[1]?.slice(0, 1800);
  await page.screenshot({ path: S.lib.LOOK });
  return { count: notices.length, notices, all };
}

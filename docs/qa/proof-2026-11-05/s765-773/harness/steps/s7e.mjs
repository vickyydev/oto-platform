export default async function (S) {
  const page = S.pages.till.page;
  await page.getByText('Driving licence — no proof needed').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.evaluate(() => { const el = [...document.querySelectorAll('*')].find((e) => e.textContent?.trim() === 'Driving licence — no proof needed'); el?.scrollIntoView({ block: 'end' }); });
  await S.shot('till', 's773-st-07c-member-looked-up-again-thai-verified-driving-licence');
  return 'ok';
}

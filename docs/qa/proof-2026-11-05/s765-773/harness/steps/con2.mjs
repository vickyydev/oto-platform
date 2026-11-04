export default async function (S) {
  const { LOOK, text } = S.lib;
  const page = S.pages.console.page;
  await page.goto(S.CONSOLE + '/devices', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: LOOK });
  return { text: (await text(page, 4000)).slice(0, 3000) };
}

export default async function (S) {
  const { text } = S.lib;
  const page = S.pages.console.page;
  await page.goto(S.CONSOLE + '/catalogue/add-ons', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const t = await text(page, 20000);
  const i = t.indexOf('Grip Socks');
  return { around: t.slice(Math.max(0, i - 300), i + 500), hasCode: /AO-GRIPSOCKS/.test(t), hasRegular: /AO-SOCKS/.test(t) };
}

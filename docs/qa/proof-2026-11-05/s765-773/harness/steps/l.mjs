export default async function (S) {
  const { LOOK, text } = S.lib;
  const page = S.pages[process.env.P ?? 'till'].page;
  await page.screenshot({ path: LOOK });
  return { url: page.url(), text: (await text(page, 3000)).slice(0, 1500) };
}

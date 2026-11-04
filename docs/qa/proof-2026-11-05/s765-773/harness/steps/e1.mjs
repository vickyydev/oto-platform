export default async function (S) {
  const { lookup, LOOK, text } = S.lib;
  const page = S.pages.till.page;
  await lookup(page, S.st.fixture.members.socks.phone);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: LOOK });
  return { text: (await text(page, 4000)) };
}

export default async function (S) {
  const { pages } = S;
  const page = pages.till.page;
  const f = S.HERE ?? 'C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/h765/look.png';
  await page.screenshot({ path: f });
  return { text: (await page.locator('body').innerText()).slice(0, 3000) };
}

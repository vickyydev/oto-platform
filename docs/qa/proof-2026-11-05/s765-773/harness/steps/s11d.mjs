export default async function (S) {
  const c = S.pages.console.page;
  const st = S.st.steps.s11.till;
  const list = c.getByRole('listbox');
  const open = await list.count();
  if (open) st.consoleOptions = (await list.getByRole('option').allTextContents()).map((t) => t.trim());
  st.consoleHolds = /Holds [^\n]*/.exec(await c.locator('[role="dialog"]').first().innerText().catch(() => ''))?.[0] ?? null;
  await c.waitForTimeout(400);
  if (open) await S.shot('console', 's773-st-11b-console-recorded-residence-certificate-option');
  await c.keyboard.press('Escape');
  await c.waitForTimeout(400);
  await c.keyboard.press('Escape');
  await c.waitForTimeout(1000);
  st.consoleDialogClosed = (await c.locator('[role="dialog"]').count()) === 0;
  S.save();
  return { open, st };
}

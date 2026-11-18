// SCRUM-1014 — ring up two children playing alone, so the review opens.
export async function ringUp({ till, display, shot, run }) {
  await till.getByRole('heading', { name: 'Tourist', exact: true }).click();
  await till.getByRole('heading', { name: '1 Hour Play', exact: true }).click();
  await till.getByRole('button', { name: 'Remove one Adults', exact: true }).first().click();
  await till.getByRole('button', { name: 'Add one Kids', exact: true }).first().click();
  await till.waitForTimeout(1500);
  const next = till.getByRole('button', { name: 'Continue', exact: true });
  if (await next.isVisible().catch(() => false)) await next.click();
  else await till.getByRole('button', { name: /^Pay/ }).last().click();
  await display.getByTestId('display-child-review').waitFor({ timeout: 30000 }).catch(async (error) => {
    await shot(till, `explore-${run}-after-pay.png`);
    throw error;
  });
}

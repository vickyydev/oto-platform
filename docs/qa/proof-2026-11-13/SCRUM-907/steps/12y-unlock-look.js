S.phase = '12: unlock the reception till and look';
const till = S.pages.rec.page;
const un = await S.unlock('rec');
await till.waitForTimeout(1500);
await till.screenshot({ path: S.resolve(S.scratch, 'raw', 'look-rec2.png'), mask: [till.locator('input[type="password"]'), till.getByLabel('Lock screen').locator('..')], maskColor: '#18181b' });
return { unlocked: un, dialogs: await till.getByRole('dialog').count(), confirm: await till.getByRole('button', { name: /^Confirm/ }).count(), settleBtn: await till.getByRole('button', { name: 'Settle party', exact: true }).count() };

S.phase = '12: a look at the reception till (scratch picture)';
const till = S.pages.rec.page;
const locked = await till.getByRole('heading', { name: 'Locked', exact: true }).isVisible().catch(() => false);
await till.screenshot({ path: S.resolve(S.scratch, 'raw', 'look-rec.png'), mask: [till.locator('input[type="password"]'), till.getByLabel('Lock screen').locator('..')], maskColor: '#18181b' });
const sales = (await S.stationSales()).map(s => `${s.receiptNumber ?? '-'} ${s.status} ${(s.totals?.grossSatang ?? s.grossSatang ?? 0) / 100}`);
const settlement = (await S.party(S.p1)).body?.event?.party?.settlement ?? null;
return { locked, url: till.url(), dialogs: await till.getByRole('dialog').count(), buttons: (await till.getByRole('button').allInnerTexts()).map(S.flat).filter(Boolean).slice(0, 40), sales, settlement };

S.phase = "5 (hunt): the party bill on the party page after the kitchen edit, read again after a reload";
const till = S.pages.mgr.page;
await S.unlock('mgr');
const r = {};
const billText = async () => S.flat(await S.cardOf(till, 'Party bill').innerText().catch(() => ''));
r.beforeReload = { bill: await billText(), take: S.flat(await till.getByRole('button', { name: /^Take balance/ }).first().innerText().catch(() => '')) };
await till.reload(); await till.waitForTimeout(5000);
await S.openParty(till, S.p1, S.P1);
await till.waitForTimeout(2000);
r.afterReload = { bill: await billText(), take: S.flat(await till.getByRole('button', { name: /^Take balance/ }).first().innerText().catch(() => '')) };
await till.mouse.wheel(0, -3000); await till.waitForTimeout(400);
await S.shot(till, '05i-party-page-after-reload-bill.png');
// the settle preview the platform prices (no write)
const pv = await S.call('POST', `/parties/${S.p1}/settle/preview`, { branchId: S.branchId, stationId: S.station.id, kids: 2, adults: 2, socksGiven: 0, addOnIds: [], entertainmentIds: [] });
const q = pv.body?.quote;
r.preview = q ? { status: pv.status, package: q.packageSatang / 100, addOns: q.addOnsSatang / 100, total: q.totalSatang / 100, deposit: q.depositSatang / 100, balance: q.balanceSatang / 100,
  extras: (q.extras ?? []).map(e => `${e.name} · ${e.qty} × ${e.unitSatang == null ? '-' : e.unitSatang / 100} = ${e.totalSatang / 100} ${e.charged ? 'charged' : 'NOT charged'}`) } : { status: pv.status, error: pv.body?.error ?? null };
S.receipt.reads.p5bill = r;
return r;

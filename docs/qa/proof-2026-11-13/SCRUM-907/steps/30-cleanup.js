S.phase = 'clean-up: everything this run made, each read back';
const done = {};
const clean = async (what, fn) => { try { done[what] = await fn(); } catch (e) { done[what] = { failed: String(e?.message ?? e).split('\n')[0].slice(0, 300) }; } S.receipt.cleanup = { ...S.receipt.cleanup, ...done }; S.save(); };
await clean('slips printed while the ZZ TEST till was named', async () => {
  const n = await S.newPrintouts();
  const mine = new Set([S.p1, S.p2, S.p3].filter(Boolean).map(x => x.toLowerCase()));
  const rows = [];
  for (const action of ['party.slips_print', 'party.slips_change']) {
    const all = (await S.call('GET', `/audit?action=${encodeURIComponent(action)}&branchId=${S.branchId}&limit=100`)).body?.entries ?? [];
    for (const e of all.filter(x => Date.parse(x.createdAt) >= Date.parse(S.slipsFrom))) rows.push({ action, at: S.bkk(e.createdAt), mine: mine.has(String(e.entityId).toLowerCase()) });
  }
  return { unreadPrintouts: { kitchen: n.kitchen.length, bar: n.bar.length }, auditRowsSinceNamed: rows.length, notMine: rows.filter(x => !x.mine).length, jobsAtTill: (await S.jobsAtTill(S.slipsFrom)).map(j => `${j.bangkok} ${j.kind} ${j.status}`) };
});
await clean('party slips station put back as found', async () => {
  const found = S.receipt.foundAtStart.partySlipsStationId ?? null;
  let now = (await S.call('GET', '/branches')).body.branches.find(b => b.id === S.branchId).partySlipsStationId ?? null;
  let patch = null;
  if (now === S.station.id) { patch = (await S.call('PATCH', `/branches/${S.branchId}`, { partySlipsStationId: found })).status; now = (await S.call('GET', '/branches')).body.branches.find(b => b.id === S.branchId).partySlipsStationId ?? null; }
  S.assert.equal(now, found);
  S.stationNamed = false;
  return { foundAtStart: found, patch, readBack: now, sameAsFound: now === found };
});
await clean('the till sales', async () => {
  const sales = await S.stationSales();
  for (const s of sales) S.assert.equal(s.stationId, S.station.id);
  for (const s of sales.filter(x => ['open', 'tendering'].includes(x.status))) S.assert.equal((await S.call('POST', `/sales/${s.id}/void`, { reason: 'ZZ TEST SCRUM-907 proof cleanup' })).status, 200);
  const after = await S.stationSales();
  return { sales: after.map(s => `${s.receiptNumber ?? 'no receipt'} ${s.status} ${(s.totals?.grossSatang ?? s.grossSatang ?? 0) / 100}`) };
});
for (const [id, title] of [[S.p1, S.P1], [S.p2, S.P2], [S.p3, S.P3]]) {
  if (!id) continue;
  await clean(`party ${title}`, async () => {
    S.assert.ok(/^ZZ TEST/.test(title), 'only ZZ TEST parties');
    const del = await S.appCall('DELETE', `/admin/events/${id}`);
    const app = await S.appCall('GET', `/admin/events/${id}`);
    const beo = await S.appCall('GET', `/events/${id}/beo`);
    const till = await S.party(id);
    return { delete: del.status, appEvent: app.status, appBeo: beo.status, tillParty: till.status, tillCode: till.body?.error?.code ?? null };
  });
}
await clean('no ZZ TEST 907 party left', async () => {
  const list = await S.appCall('GET', `/admin/events?range=all&includeArchived=true&branchId=${S.APP_FLORESTA}`);
  const left = Array.isArray(list.body) ? list.body.filter(e => /ZZ TEST 907/.test(String(e.title || ''))).length : null;
  const tillToday = ((await S.call('GET', `/events?branchId=${S.branchId}&type=party`)).body?.events ?? []).filter(e => /ZZ TEST 907/.test(e.title)).length;
  return { appListStatus: list.status, leftInApp: left, leftOnTillToday: tillToday };
});
await clean('the ZZ TEST till', async () => {
  S.assert.equal((await S.call('PATCH', `/stations/${S.station.id}`, { devices: [] })).status, 200);
  const del = await S.call('DELETE', `/stations/${S.station.id}`);
  const row = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations.find(s => s.id === S.station.id);
  return { delete: del.status, archived: !!row?.archived, devices: row?.devices?.length ?? null };
});
await clean('the ZZ TEST printers', async () => {
  const out = [];
  for (const [role, d] of Object.entries(S.devices)) {
    const r = await S.call('DELETE', `/devices/${d.id}`);
    out.push(`${role} ${r.status}`);
  }
  const after = (await S.call('GET', `/boxes/${S.box.id}/devices?includeArchived=true`)).body.devices.filter(x => Object.values(S.devices).some(d => d.id === x.id));
  return { deletes: out, allArchived: after.length === Object.keys(S.devices).length && after.every(x => x.archived) };
});
return done;

S.phase = "12: a ZZ TEST extra of 1,300 baht added to party 1's BEO (the BEO's own save route)";
const b0 = (await S.appCall('GET', `/events/${S.p1}/beo`)).body;
const kp0 = b0?.kitchenPlan ?? {};
const kids = [...(kp0.menus?.kids ?? []), { id: 'zz907-platter', itemName: 'ZZ TEST party platter', quantity: 1, notes: '', included: false, price: 1300 }];
const put = await S.appCall('PUT', `/events/${S.p1}/beo`, {
  kitchenPlan: { foodRequired: kp0.foodRequired ?? true, setMenuEnabled: kp0.setMenuEnabled ?? true, setMenuTemplateId: kp0.setMenuTemplateId ?? null,
    cakeMode: kp0.cakeMode ?? 'INTERNAL', cakeTime: kp0.cakeTime ?? null, cakeNotes: kp0.cakeNotes ?? null,
    menus: { kids, adults: kp0.menus?.adults ?? [], adultsDiffer: kp0.menus?.adultsDiffer ?? false, kidsFoodTime: kp0.menus?.kidsFoodTime ?? '', adultsFoodTime: kp0.menus?.adultsFoodTime ?? '' } },
});
const back = (await S.appCall('GET', `/events/${S.p1}/beo`)).body;
const show = l => `${l.source === 'set_menu' ? 'SET' : 'EXTRA'} ${l.itemName} x${l.quantity}${l.price ? ' @' + l.price : ''}${l.productCode ? ' [' + l.productCode + ']' : ''}`;
const r = { put: put.status, kids: (back?.kitchenPlan?.menus?.kids ?? []).map(show), cake: { time: back?.kitchenPlan?.cakeTime, notes: back?.kitchenPlan?.cakeNotes, qty: back?.kitchenPlan?.cakeQuantity } };
const pv = await S.call('POST', `/parties/${S.p1}/settle/preview`, { branchId: S.branchId, stationId: S.station.id, kids: 2, adults: 2, socksGiven: 0, addOnIds: [], entertainmentIds: [] });
const q = pv.body?.quote;
r.preview = q ? { package: q.packageSatang / 100, addOns: q.addOnsSatang / 100, total: q.totalSatang / 100, deposit: q.depositSatang / 100, balance: q.balanceSatang / 100,
  extras: (q.extras ?? []).map(e => `${e.name} · ${e.qty} × ${e.unitSatang == null ? '-' : e.unitSatang / 100} = ${e.totalSatang / 100} ${e.charged ? 'charged' : 'NOT charged'}`),
  lines: (q.lines ?? []).map(l => `${l.role} | ${l.label} | ${l.quantity} x ${l.unitSatang / 100} = ${l.totalSatang / 100}`) } : { status: pv.status, error: pv.body?.error ?? null };
S.receipt.reads.p12add = r;
return r;

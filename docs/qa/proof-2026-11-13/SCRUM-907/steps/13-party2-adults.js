S.phase = '9: party 2, "Different for adults" on with the adults eating two of the kids\' dishes; read on the till';
S.P2 = 'ZZ TEST 907 adults differ';
const ev = await S.appCall('POST', '/admin/events', { eventType: 'birthday', title: S.P2, branchId: S.APP_FLORESTA, eventDate: S.bizDate, startTime: '18:00', endTime: '20:00', durationMinutes: 120, numChildren: 2, numAdults: 2, childName: 'ZZ TEST child two', status: 'upcoming' });
S.assert.equal(ev.status, 201, 'party 2 created ' + JSON.stringify(ev.body).slice(0, 200));
S.p2 = ev.body.id;
S.receipt.created.push({ kind: 'oto-app party', id: S.p2, title: S.P2 }); S.save();
const line = (id, itemName, quantity, price, productCode) => ({ id, itemName, quantity, notes: '', included: false, price, ...(productCode ? { productCode } : {}) });
const kids = [line('zz907b-cal-k', 'Calamari', 2, 120, 'CF-14'), line('zz907b-hum-k', 'Hummus', 1, 0, 'CF-13'), line('zz907b-nug-k', 'ZZ TEST nuggets', 2, 0, null)];
const adults = [line('zz907b-cal-a', 'Calamari', 2, 120, 'CF-14'), line('zz907b-hum-a', 'Hummus', 1, 0, 'CF-13'), line('zz907b-steak-a', 'ZZ TEST steak', 1, 0, null)];
const put = await S.appCall('PUT', `/events/${S.p2}/beo`, {
  kitchenPlan: { foodRequired: true, setMenuEnabled: false, setMenuTemplateId: null, cakeMode: 'NONE',
    menus: { kids, adults, adultsDiffer: true, kidsFoodTime: '18:30', adultsFoodTime: '19:00' } },
});
const back = (await S.appCall('GET', `/events/${S.p2}/beo`)).body;
const show = l => `${l.itemName} x${l.quantity}${l.productCode ? ' [' + l.productCode + ']' : ''}${l.notes ? ' note ' + l.notes : ''} id=${l.id}`;
const r = { put: put.status, beo: { adultsDiffer: back?.kitchenPlan?.menus?.adultsDiffer ?? null, kids: (back?.kitchenPlan?.menus?.kids ?? []).map(show), adults: (back?.kitchenPlan?.menus?.adults ?? []).map(show) } };
r.till = await S.tillRead(S.p2, 'p2-made');
S.receipt.reads.p9made = r;
return r;

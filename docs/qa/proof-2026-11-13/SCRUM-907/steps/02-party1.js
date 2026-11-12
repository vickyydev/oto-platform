S.phase = '2: party 1 made in the OTO App (Floresta package, set menu with a choice, extras, cake, bar)';
// The park's business day starts at 05:00: before then the till's "today" (its party list, the slips job's date)
// is the business date, read from the till's own events list; the parties are made for that date.
S.bizDate = (await S.call('GET', `/events?branchId=${S.branchId}&type=party`)).body.date;
S.assert.match(S.bizDate, /^\d{4}-\d{2}-\d{2}$/);
await S.openApp();
const r = { bizDate: S.bizDate, calendarDate: S.today };
const prod = code => S.menu.products.find(p => p.code === code && p.active && !p.archivedAt);
S.prods = { calamari: prod('CF-14'), hummus: prod('CF-13'), fries: prod('CF-11'), water: prod('CF-65-6') };
for (const [k, p] of Object.entries(S.prods)) S.assert.ok(p, 'till product ' + k);
r.tillProducts = Object.fromEntries(Object.entries(S.prods).map(([k, p]) => [k, `${p.code} ${p.name} ${p.priceSatang / 100}`]));
S.P1 = 'ZZ TEST 907 party';
const ev = await S.appCall('POST', '/admin/events', { eventType: 'birthday', title: S.P1, branchId: S.APP_FLORESTA, eventDate: S.bizDate, startTime: '19:00', endTime: '22:00', durationMinutes: 180, numChildren: 2, numAdults: 2, childName: 'ZZ TEST child', status: 'upcoming' });
S.assert.equal(ev.status, 201, 'party created ' + JSON.stringify(ev.body).slice(0, 200));
S.p1 = ev.body.id;
S.receipt.created.push({ kind: 'oto-app party', id: S.p1, title: S.P1 }); S.save();
const bill = await S.appCall('PUT', `/events/${S.p1}/beo/billing`, { depositRequired: true, depositAmount: 1000, depositPaid: true, depositPaidAmount: 1000 });
r.billing = bill.status;
const snap = await S.appCall('POST', `/beo/events/${S.p1}/package-snapshot`, { templateId: S.FLORESTA_PACKAGE });
S.assert.equal(snap.status, 201, 'package applied');
r.package = { status: snap.status, name: snap.body?.packageName ?? null, slipsTimeAtApply: snap.body?.slipsTime ?? null, readyOffset: snap.body?.readyOffsetMinutes ?? snap.body?.kitchenReadyOffsetMinutes ?? null };
// the schedule must not print party 1 by itself while the proof presses "Print party slips now"
const later = await S.appCall('PATCH', `/beo/events/${S.p1}/package-snapshot`, { slipsTime: '23:50' });
r.slipsTimeMoved = { status: later.status, slipsTime: later.body?.slipsTime ?? null };
const tmpls = (await S.appCall('GET', '/beo/set-menu-templates')).body;
S.tmpl = (Array.isArray(tmpls) ? tmpls : []).find(t => t.id === snap.body?.setMenuTemplateId);
S.assert.ok(S.tmpl, 'the package set menu template');
r.setMenu = { name: S.tmpl.name, items: S.tmpl.items.map(i => i.type === 'choice_group' ? `${i.label} [${i.options.join(' / ')}]${i.qty ? ' x' + i.qty : ''}` : `${i.label}${i.qty ? ' x' + i.qty : ''} ${i.productCode ?? ''}`) };
const beo = (await S.appCall('GET', `/events/${S.p1}/beo`)).body;
const kp0 = beo?.kitchenPlan ?? {};
const line = (id, itemName, quantity, price, productCode, source) => ({ id, itemName, quantity, notes: '', included: source === 'set_menu', price, ...(productCode ? { productCode } : {}), ...(source ? { source } : {}) });
S.p1Kids = [
  line('zz907-calamari', S.prods.calamari.name, 2, 120, S.prods.calamari.code),
  line('zz907-hummus', S.prods.hummus.name, 1, 0, S.prods.hummus.code),
  line('zz907-mango', 'ZZ TEST mango sticky rice', 2, 90, null),
  line('zz907-fruit', 'ZZ TEST fruit plate', 1, 0, null),
];
S.p1Bar = [line('zz907-water', S.prods.water.name, 2, 0, S.prods.water.code)];
const put = await S.appCall('PUT', `/events/${S.p1}/beo`, {
  kitchenPlan: { foodRequired: true, setMenuEnabled: kp0.setMenuEnabled ?? true, setMenuTemplateId: kp0.setMenuTemplateId ?? S.tmpl.id,
    cakeMode: 'INTERNAL', cakeTime: '20:30', cakeNotes: 'ZZ TEST unicorn',
    menus: { kids: S.p1Kids, adults: [], adultsDiffer: false, kidsFoodTime: '19:30', adultsFoodTime: '' } },
  barPlan: { serviceTime: '19:15', items: S.p1Bar },
});
r.put = { status: put.status, error: put.status < 300 ? null : put.body };
// the parent's choices through the link's public routes: Fried rice Veggie, the first option elsewhere
const link = await S.appCall('POST', '/beo/set-menu-selections', { eventId: S.p1, templateId: S.tmpl.id });
S.assert.equal(link.status, 201, 'parent link');
S.token = link.body.token; // memory only
const pub = await S.appCall('GET', `/beo/set-menu-selections/public/${S.token}`);
const groups = (pub.body?.template?.items ?? []).filter(i => i.type === 'choice_group');
const pickOf = g => (/fried rice/i.test(g.label) ? g.options.find(o => /veg/i.test(o)) : null) ?? g.options[0];
const sub = await S.appCall('POST', `/beo/set-menu-selections/public/${S.token}/submit`, { selections: groups.map(g => ({ groupId: g.id, chosenOptions: [pickOf(g)] })) });
r.parent = { submit: sub.status, chose: groups.map(g => `${g.label}: ${pickOf(g)}`) };
const back = (await S.appCall('GET', `/events/${S.p1}/beo`)).body;
const show = l => `${l.source === 'set_menu' ? 'SET' : 'EXTRA'} ${l.itemName} x${l.quantity}${l.price ? ' @' + l.price : ''}${l.productCode ? ' [' + l.productCode + ']' : ''}${l.notes ? ' note ' + l.notes : ''} id=${l.id}`;
r.beoReadBack = { kids: (back?.kitchenPlan?.menus?.kids ?? []).map(show), bar: (back?.barPlan?.items ?? []).map(show), barTime: back?.barPlan?.serviceTime ?? null,
  cake: { mode: back?.kitchenPlan?.cakeMode ?? null, time: back?.kitchenPlan?.cakeTime ?? null, notes: back?.kitchenPlan?.cakeNotes ?? null, qty: back?.kitchenPlan?.cakeQuantity ?? null },
  kidsFoodTime: back?.kitchenPlan?.menus?.kidsFoodTime ?? null };
S.tillRead = async (id, key) => {
  const p = await S.party(id);
  const kp = p.body?.kitchenPlan ?? null;
  const fmtLine = m => `${m.origin ?? '-'} | ${m.name}${m.chosenOption ? ': ' + m.chosenOption : ''}${m.qty == null ? '' : ' x' + m.qty} | code ${m.productCode ?? '-'}${m.unitPriceSatang != null ? ' | entered ' + m.unitPriceSatang / 100 : ''}${m.note ? ' | note ' + m.note : ''}${m.audience ? ' | ' + m.audience : ''}${m.choiceGroup ? ' | group ' + m.choiceGroup : ''} | line ${m.lineId ?? '-'}`;
  const rec = {
    at: new Date().toISOString(), status: p.status, error: p.status === 200 ? null : p.body?.error ?? null,
    title: p.body?.event?.title ?? null, planStatus: p.body?.planStatus ?? null,
    kitchenPlan: kp ? { kitchen: kp.kitchen, cake: kp.cake ?? null, lines: kp.setMenu.map(fmtLine),
      bar: kp.barItems.map(b => `${b.origin ?? '-'} | ${b.name} x${b.qty} | code ${b.productCode ?? '-'}${b.unitPriceSatang != null ? ' | entered ' + b.unitPriceSatang / 100 : ''}${b.note ? ' | note ' + b.note : ''} | line ${b.lineId ?? '-'}`) } : null,
    slips: p.body?.slips ? { slipsTime: p.body.slips.slipsTime ?? null, station: p.body.slips.station?.name ?? null, records: (p.body.slips.records ?? []).map(x => `${x.station} run ${x.run} ${x.trigger} ${x.status}${x.variant ? ' ' + x.variant : ''}`) } : null,
    deposit: p.body?.event?.party?.depositSatang ?? null,
    settlement: p.body?.event?.party?.settlement ? { state: p.body.event.party.settlement.state } : null,
  };
  if (key) (S.receipt.reads.tillReads ??= {})[key] = rec;
  return rec;
};
r.till = await S.tillRead(S.p1, 'p1-made');
S.receipt.reads.p1Made = r;
return r;

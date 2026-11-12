S.phase = 'setup: the branch business day (party dates at 02:00 Bangkok)';
const b = (await S.call('GET', '/branches')).body.branches.find(x => x.id === S.branchId);
const ev = (await S.call('GET', `/events?branchId=${S.branchId}&type=party`)).body;
return { businessDayStart: b.businessDayStart ?? null, timezone: b.timezone, keys: Object.keys(b), eventsDate: ev?.date ?? ev?.businessDate ?? null, eventKeys: Object.keys(ev ?? {}), eventDates: (ev?.events ?? []).map(e => e.date ?? e.eventDate ?? null) };

S.phase = "7: the slips after the till's edit (VOID and UPDATED kitchen, UPDATED bar), read from the simulated printers";
const r = {};
const t0 = Date.parse(S.editSavedAt);
const deadline = Date.now() + 180000;
let n = { kitchen: [], bar: [] };
while (Date.now() < deadline) { n = await S.newPrintouts(); if (n.kitchen.length >= 2 && n.bar.length >= 1) break; await S.sleep(4000); }
await S.sleep(8000);
n = await S.newPrintouts();
r.secondsFromSave = n.kitchen.concat(n.bar).map(p => Math.round((Date.parse(p.at) - t0) / 1000));
r.printouts = { kitchen: n.kitchen.map(p => ({ seq: p.seq, at: S.bkk(p.at), heightDots: p.heightDots })), bar: n.bar.map(p => ({ seq: p.seq, at: S.bkk(p.at), heightDots: p.heightDots })) };
const asc = a => [...a].sort((x, y) => x.seq - y.seq);
for (const [i, p] of asc(n.kitchen).entries()) await S.keepPreview('kitchen', p, `07${String.fromCharCode(97 + i)}-kitchen-slip-after-till-edit-${i + 1}.png`);
for (const [i, p] of asc(n.bar).entries()) await S.keepPreview('bar', p, `07${String.fromCharCode(97 + n.kitchen.length + i)}-bar-slip-after-till-edit-${i + 1}.png`);
S.markSeen(n.kitchen, n.bar);
r.audit = (await S.auditOf('party.slips_change', S.p1.toLowerCase())).map(e => ({ at: S.bkk(e.createdAt), run: e.after?.run, slips: (e.after?.slips ?? []).map(s => `${s.station} ${s.variant} ${s.status}`) }));
r.jobsAtTill = (await S.jobsAtTill(S.slipsFrom)).map(j => `${j.bangkok} ${j.kind} ${j.role} ${j.status}`);
S.receipt.reads.p7 = r;
return r;

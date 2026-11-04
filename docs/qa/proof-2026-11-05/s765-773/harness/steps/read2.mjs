import { writeFileSync } from 'node:fs';
export default async function (S) {
  const id = '01a1a841-a1e3-7969-a230-f401ceeaa981';
  const b = (await S.adminApi('GET', `/sales/${id}`)).body;
  writeFileSync('C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/h765/sale2.json', JSON.stringify(b, null, 2));
  const dev = { receipt: '01a0be8c-89a4-756b-aca1-3be1082c669d', kids: '01a0be8c-89af-7c2b-861f-f3d1f0f5d27b', adult: '01a0be8c-89b2-7f21-84e0-74c754838f5b' };
  const printouts = {};
  for (const [k, d] of Object.entries(dev)) printouts[k] = ((await S.adminApi('GET', `/devices/${d}/printouts?limit=20`)).body?.printouts ?? []).map((x) => ({ seq: x.seq, h: x.heightDots, bytes: x.jobBytes }));
  const out = { sale: { id, receipt: b.sale.receiptNumber, status: b.sale.status, gross: b.sale.totals.grossSatang, tier: b.sale.customerTier, member: b.sale.member?.nickname ?? b.sale.memberId }, lines: b.lines.map((l) => ({ kind: l.kind, label: l.label, qty: l.quantity })), grants: (b.grants ?? []).map((g) => ({ kind: g.kind, amount: g.amountSatang ?? null })), printJobs: b.printJobs.map((j) => ({ kind: j.kind, status: j.status, device: j.deviceLabel, subjectType: j.subjectType })), printouts };
  S.st.steps.s5.readBack = { at: new Date().toISOString(), ...out }; S.save();
  return out;
}

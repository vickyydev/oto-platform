import { writeFileSync } from 'node:fs';
export default async function (S) {
  const id = '01a1a839-f5d7-76d8-849c-b420828afbd3';
  const r = await S.adminApi('GET', `/sales/${id}`);
  const b = r.body;
  const dev = { receipt: '01a0be8c-89a4-756b-aca1-3be1082c669d', kids: '01a0be8c-89af-7c2b-861f-f3d1f0f5d27b', adult: '01a0be8c-89b2-7f21-84e0-74c754838f5b' };
  const printouts = {};
  for (const [k, d] of Object.entries(dev)) {
    const p = await S.adminApi('GET', `/devices/${d}/printouts?limit=20`);
    printouts[k] = (p.body?.printouts ?? []).map((x) => ({ seq: x.seq, h: x.heightDots, w: x.widthDots, bytes: x.jobBytes, at: x.printedAt ?? x.createdAt, truncated: x.truncated }));
  }
  const out = { status: r.status, keys: Object.keys(b ?? {}), sale: { id: b?.sale?.id, receipt: b?.sale?.receiptNumber, status: b?.sale?.status, gross: b?.sale?.totals?.grossSatang, member: b?.sale?.member?.nickname ?? b?.sale?.memberId }, lines: (b?.lines ?? []).map((l) => ({ kind: l.kind, label: l.label, qty: l.quantity, productCode: l.productCode ?? null })), printJobs: (b?.printJobs ?? b?.print?.jobs ?? []).map((j) => ({ kind: j.kind, status: j.status, role: j.role, device: j.deviceLabel, label: j.label ?? null })), grants: (b?.grants ?? []).length, printouts };
  S.st.steps.s4 = { readAt: new Date().toISOString(), ...out }; S.save();
  writeFileSync('C:/Users/waqar/AppData/Local/Temp/claude/9d4c56906b777e8e/317fcfce-2754-44c9-bec5-9a762ab18d03/scratchpad/h765/sale1.json', JSON.stringify(b, null, 2));
  return out;
}

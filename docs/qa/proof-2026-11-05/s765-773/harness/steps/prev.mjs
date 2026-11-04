import { writeFileSync } from 'node:fs';
export default async function (S) {
  const dev = { 'receipt-printer': '01a0be8c-89a4-756b-aca1-3be1082c669d', 'kids-band-printer': '01a0be8c-89af-7c2b-861f-f3d1f0f5d27b', 'adult-band-printer': '01a0be8c-89b2-7f21-84e0-74c754838f5b' };
  const want = JSON.parse(process.env.WANT ?? 'null') ?? S.st.wantPreviews;
  const out = [];
  for (const [name, seq, file] of want) {
    const r = await S.raw('GET', `/devices/${dev[name]}/printouts/${seq}/preview.png`);
    if (r.status !== 200) throw new Error(name + ' ' + seq + ' ' + r.status);
    writeFileSync(S.OUT + '/' + file + '.png', r.buf);
    out.push({ name, seq, file, bytes: r.buf.length });
    (S.st.printoutFiles = S.st.printoutFiles ?? []).push({ printer: name, seq, file: S.REL + '/' + file + '.png', at: new Date().toISOString() });
  }
  S.save();
  return out;
}

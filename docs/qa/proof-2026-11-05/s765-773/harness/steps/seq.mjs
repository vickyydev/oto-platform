export default async function (S) {
  const { st, save, adminApi } = S;
  const dev = { receipt: '01a0be8c-89a4-756b-aca1-3be1082c669d', kids: '01a0be8c-89af-7c2b-861f-f3d1f0f5d27b', adult: '01a0be8c-89b2-7f21-84e0-74c754838f5b' };
  const out = {};
  for (const [k, id] of Object.entries(dev)) {
    const r = await adminApi('GET', `/devices/${id}/printouts?limit=20`);
    const ps = r.body?.printouts ?? [];
    out[k] = { status: r.status, max: Math.max(0, ...ps.map((p) => p.seq)), n: ps.length, last: ps.slice(-1).map((p) => ({ seq: p.seq, at: p.printedAt ?? p.at ?? p.createdAt, h: p.heightDots })) };
  }
  st.seqBaseline = st.seqBaseline ?? {};
  st.seqBaseline[new Date().toISOString()] = out; save();
  return out;
}

export default async function (S) {
  const BR = S.st.fixture.branchId;
  const out = {};
  for (const id of ['01a0cb02-13a9-790f-85a1-73e71f2f57f7', '01a0d4ed-9353-7325-9684-72605ecc7f09']) {
    const r = await S.adminApi('GET', `/branches/${BR}/menu/products/${id}`);
    const p = r.body?.product ?? r.body;
    out[id] = { status: r.status, name: p?.name, code: p?.code ?? null, kind: p?.kind ?? p?.productKind ?? null };
  }
  S.st.products = out; S.save();
  return out;
}

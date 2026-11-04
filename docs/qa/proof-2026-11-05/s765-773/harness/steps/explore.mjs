export default async function (S) {
  const { adminApi, st, save } = S;
  const me = await adminApi('GET', '/me');
  const BR = me.body.operatorContext?.branchId;
  const boxes = (await adminApi('GET', `/branches/${BR}/boxes`)).body;
  const stations = (await adminApi('GET', `/branches/${BR}/stations`)).body;
  const rt = (stations.stations ?? []).map((s) => ({ id: s.id, name: s.name, kind: s.kind, prefix: s.codePrefix, box: s.boxName ?? s.boxId, archived: s.archivedAt }));
  st.fixture.branchId = BR; st.adminActorId = me.body.account?.id; save();
  return { branch: BR, boxes: (boxes.boxes ?? []).map((b) => ({ id: b.id, name: b.name, slot: b.slot, status: b.status })), stations: rt };
}

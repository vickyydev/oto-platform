export default async function (S) {
  const { adminApi, st, save } = S;
  const T1 = '01a0bbdc-8cd7-7208-8e05-84eaf2963a9a';
  const s = await adminApi('GET', `/stations/${T1}`);
  const sb = s.body.station ?? s.body;
  const out = { status: s.status, name: sb.name, ready: sb.ready, reasons: sb.reasons, paymentRouting: sb.paymentRouting, accessScope: sb.accessScope, devices: (sb.devices ?? []).map((d) => ({ role: d.role, label: d.label, transport: d.transport, deviceId: d.deviceId ?? d.id })) };
  st.fixture.till = { id: T1, ...out }; save();
  return out;
}

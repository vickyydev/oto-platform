S.phase = 'setup: ZZ TEST simulated printers on Virtual box 1 and a ZZ TEST till';
S.assert.ok(S.box, 'Virtual box 1 online');
const ADDRESS = { kids_band: '192.0.2.97:9201', adult_band: '192.0.2.97:9202', receipt: '192.0.2.97:9203', kitchen: '192.0.2.97:9204', bar: '192.0.2.97:9205' };
const defs = {
  kids_band: { kind: 'band_printer', label: 'ZZ TEST SCRUM-907 kids band printer', model: '4B-2082A', protocol: 'tspl2' },
  adult_band: { kind: 'band_printer', label: 'ZZ TEST SCRUM-907 adult band printer', model: '4B-2082A', protocol: 'tspl2' },
  receipt: { kind: 'receipt_printer', label: 'ZZ TEST SCRUM-907 receipt printer', model: 'Xprinter XP-80', protocol: 'escpos' },
  kitchen: { kind: 'kitchen_printer', label: 'ZZ TEST SCRUM-907 kitchen printer', model: 'Xprinter XP-80', protocol: 'escpos' },
  bar: { kind: 'bar_printer', label: 'ZZ TEST SCRUM-907 bar printer', model: 'Xprinter XP-80', protocol: 'escpos' },
};
S.devices = S.devices ?? {};
for (const [role, d] of Object.entries(defs)) {
  if (S.devices[role]) continue;
  const id = S.randomUUID();
  const r = await S.call('POST', `/boxes/${S.box.id}/devices`, { id, kind: d.kind, label: d.label, transport: 'simulated', model: d.model, protocol: d.protocol, address: ADDRESS[role] });
  S.assert.equal(r.status, 200, `device ${role} ${JSON.stringify(r.body).slice(0, 200)}`);
  S.devices[role] = { id: r.body.device.id, label: d.label, kind: d.kind };
  S.receipt.created.push({ kind: 'device', role, id: r.body.device.id, label: d.label }); S.save();
}
const stations = (await S.call('GET', `/branches/${S.branchId}/stations?includeArchived=true`)).body.stations;
const prefix = Array.from({ length: 99 }, (_, i) => `Z907${String(i + 1).padStart(2, '0')}`).find(p => !stations.some(s => s.codePrefix === p));
S.fixtureName = `ZZ TEST SCRUM-907 proof till ${Date.now()}`;
const devices = Object.keys(defs).map(role => ({ role, deviceId: S.devices[role].id }));
const made = await S.call('POST', `/branches/${S.branchId}/stations`, { name: S.fixtureName, kind: 'till', boxId: S.box.id, codePrefix: prefix, accessScope: 'all_staff', paymentRouting: { card: 'manual', qr: 'none' }, capabilities: [], devices });
S.assert.equal(made.status, 200, 'station ' + JSON.stringify(made.body).slice(0, 300));
S.station = made.body.station;
S.receipt.created.push({ kind: 'station', id: S.station.id, name: S.fixtureName, prefix }); S.save();
return { station: S.fixtureName, prefix, devices: S.station.devices.map(d => `${d.role}: ${d.label}`) };

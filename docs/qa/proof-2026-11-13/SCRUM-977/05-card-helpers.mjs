const {expect,assert}=S;
S.stationRow=async(id=S.station.id)=>(await S.call('GET',`/branches/${S.branchId}/stations?includeArchived=true`)).body.stations.find(x=>x.id===id);
S.rolesOf=row=>Object.fromEntries((row?.devices??[]).map(d=>[d.role,d.label]));
S.walkIn = async (page, number) => {
  await page.goto('/');
  await S.landing(page).waitFor();
  if (await page.getByTestId('language-choice').isVisible()) await page.getByTestId('language-choice-en').click();
  await page.getByTestId('identify-safety').waitFor();
  const scope = S.halfOf(page.getByTestId('identify-safety'));
  await S.keypad(scope, number);
  await scope.getByRole('button', { name: 'Continue', exact: true }).click();
  const offer = page.getByRole('dialog', { name: 'New member?', exact: true });
  await expect(offer).toContainText(S.spaced(number));
  await offer.getByRole('button', { name: 'Continue as walk-in', exact: true }).click();
  return scope;
};
S.withoutTerminal = row => row.devices.filter(d => d.role !== 'card_terminal').map(d => ({ role: d.role, deviceId: d.deviceId }));
S.assignTerminal = async (stationId = S.station.id) => {
  const row = await S.stationRow(stationId);
  const devices = S.withoutTerminal(row).concat([{ role: 'card_terminal', deviceId: S.dev.card.id }]);
  const p = await S.call('PATCH', `/stations/${stationId}`, { devices, paymentRouting: { card: 'card_terminal', qr: 'none' } });
  S.lastAssignAt = Date.now();
  return { status: p.status, code: p.body?.error?.code ?? null, roles: S.rolesOf(p.body?.station), paymentRouting: p.body?.station?.paymentRouting ?? null, configVersion: p.body?.station?.configVersion ?? null, at: new Date(S.lastAssignAt).toISOString() };
};
S.unassignTerminal = async (stationId = S.station.id) => {
  const row = await S.stationRow(stationId);
  const p = await S.call('PATCH', `/stations/${stationId}`, { devices: S.withoutTerminal(row), paymentRouting: { card: 'manual', qr: 'none' } });
  S.lastUnassignAt = Date.now();
  return { status: p.status, code: p.body?.error?.code ?? null, roles: S.rolesOf(p.body?.station), paymentRouting: p.body?.station?.paymentRouting ?? null, configVersion: p.body?.station?.configVersion ?? null, at: new Date(S.lastUnassignAt).toISOString() };
};
return {helpers:true};

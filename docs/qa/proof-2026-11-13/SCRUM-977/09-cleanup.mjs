S.phase='exact own fixture cleanup';const {assert}=S;
const result={sales:[],stations:[],devices:[]};
for(const st of S.stations){
 const row=(await S.call('GET',`/stations/${st.id}`)).body.station;assert.equal(row.name,st.name);assert.ok(row.name.startsWith('ZZ TEST SCRUM-977'));
 const sales=await S.stationSales(st);
 for(const v of sales){
  const s=await S.sale(v.id);assert.equal(s.sale.stationId,st.id);
  assert.ok(!(s.attempts??[]).some(a=>['approved','sent_to_terminal','awaiting_staff_confirmation','pending'].includes(a.status)),'only known unpaid attempts may be voided here');
  if(['open','tendering'].includes(s.sale.status))assert.equal((await S.call('POST',`/sales/${v.id}/void`,{reason:'ZZ TEST 977 unpaid proof cleanup'})).status,200);
  const after=await S.sale(v.id);assert.equal(after.sale.status,'voided');result.sales.push({id:v.id,status:after.sale.status});
 }
}
for(const label of Object.keys(S.displays))await S.dropDisplay(label);
for(const st of S.stations){
 assert.equal((await S.call('PATCH',`/stations/${st.id}`,{devices:[],paymentRouting:{card:'manual',qr:'none'}})).status,200);
 assert.equal((await S.call('DELETE',`/stations/${st.id}`)).status,200);
 const after=(await S.call('GET',`/branches/${S.branchId}/stations?includeArchived=true`)).body.stations.find(x=>x.id===st.id);
 assert.ok(after.archived);assert.equal(after.devices.length,0);result.stations.push({id:st.id,archived:after.archived,devices:after.devices.length});
}
for(const dev of Object.values(S.dev)){
 const all=(await S.call('GET',`/boxes/${S.box.id}/devices?includeArchived=true`)).body.devices;
 const row=all.find(x=>x.id===dev.id);assert.ok(row.label.startsWith('ZZ TEST 977'));
 assert.equal((await S.call('DELETE',`/devices/${dev.id}`)).status,200);
 const after=(await S.call('GET',`/boxes/${S.box.id}/devices?includeArchived=true`)).body.devices.find(x=>x.id===dev.id);assert.ok(after.archived);result.devices.push({id:dev.id,archived:after.archived});
}
assert.equal(S.receipt.registrationsPosted.length,0,'no family registration submitted by this proof');
for(const label of Object.keys(S.pages)){const r=await S.signOut(label);assert.equal(r.meAfter,401);}
S.receipt.cleanup.records=result;S.save();return result;

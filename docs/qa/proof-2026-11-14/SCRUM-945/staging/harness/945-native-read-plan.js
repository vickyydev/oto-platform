await S.owned();S.assert.equal(await S.runtime(),S.SHA);const f=S.st.fixtures[0];
const r=await S.pos('GET','/parties/'+f.id+'?branchId=01a0bbdc-8c42-7753-b7e3-5ae19fb66d33&date='+f.eventDate);S.assert.equal(r.status,200);
const rows=r.body.kitchenPlan?.setMenu;S.assert.ok(Array.isArray(rows),'the actual platform kitchen plan is available');
const fixed=rows.find(x=>x.origin==='set_menu'&&x.name===S.st.template.fixed.label);S.assert.ok(fixed,'template base SET published');
const own=rows.find(x=>x.lineId==='zz945-own-adult');S.assert.ok(own);S.assert.equal(own.qty,3);S.assert.equal(own.audience,'adults');S.assert.equal(own.productCode,S.st.firstPlan.adult.productCode);
const actualSet=!!S.st.secondPlan;
if(!actualSet){S.assert.equal(fixed.audience,undefined,'EXTRA does not make base kids-only');const extra=rows.find(x=>x.lineId==='zz945-kids-extra');S.assert.ok(extra);S.assert.equal(extra.origin,'extra');S.assert.equal(extra.qty,2);S.assert.equal(extra.audience,'kids');}
else{S.assert.equal(fixed.audience,'kids','actual kids SET remains kids-only');S.assert.equal(fixed.lineId,'zz945-kids-set');S.assert.equal(fixed.qty,S.st.secondPlan.kids.quantity);}
const result={case:actualSet?'actual-kids-only-set':'extra-does-not-mark-base',appRuntime:await S.runtime(),eventId:f.id,kitchenPlanRows:rows.map(x=>({lineId:x.lineId,origin:x.origin,name:x.name,qty:x.qty,productCode:x.productCode,audience:x.audience,adultsNote:x.adultsNote})),at:new Date().toISOString()};S.st.results.push(result);S.save();return result;

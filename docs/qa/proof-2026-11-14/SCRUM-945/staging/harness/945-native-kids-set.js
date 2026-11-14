await S.owned();S.assert.equal(await S.runtime(),S.SHA);
const f=S.st.fixtures[0],fixed=S.st.template.fixed;
const kids={id:'zz945-kids-set',itemName:fixed.label,quantity:fixed.qty??1,notes:'',source:'set_menu',groupId:fixed.id,included:true,price:0,...(fixed.productCode?{productCode:fixed.productCode}:{})};
const body={setMenuEnabled:true,setMenuTemplateId:S.st.template.id,foodRequired:true,cakeMode:'NONE',menus:{kids:[kids],adults:[S.st.firstPlan.adult],adultsDiffer:true}};
const saved=await S.call('PUT','/events/'+f.id+'/beo/kitchen-plan',body);S.assert.equal(saved.status,200);
S.st.secondPlan={status:saved.status,kids,adult:S.st.firstPlan.adult};S.st.phase='actual-kids-set-ready';S.save();return S.st.secondPlan;

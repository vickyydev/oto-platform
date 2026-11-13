S.phase='phone both rotations retain typed child and guardian';
const p=S.phone,{expect,assert}=S;
await p.getByTestId('consent-child-name').fill('ZZ TEST 977 child rotated');
await p.getByTestId('consent-guardian').fill('ZZ TEST 977 parent rotated');
const reads=[];
for(const [width,height] of [[390,844],[844,390],[390,844],[360,740],[740,360],[360,740]]){
 await p.setViewportSize({width,height});await p.waitForTimeout(800);
 await expect(p.getByTestId('consent-child-name')).toHaveValue('ZZ TEST 977 child rotated');
 await expect(p.getByTestId('consent-guardian')).toHaveValue('ZZ TEST 977 parent rotated');
 const r=await p.getByTestId('consent-form-body').evaluate(el=>({width:innerWidth,height:innerHeight,formHeight:el.getBoundingClientRect().height,share:el.getBoundingClientRect().height/innerHeight,scrollWidth:document.documentElement.scrollWidth,touch:navigator.maxTouchPoints}));
 assert.equal(r.scrollWidth,width,'no horizontal page overflow');if(width>height)assert.ok(r.share>=.5,'form keeps at least half the height');reads.push(r);
 await S.shot(p,`02-phone-${width}x${height}-kept-form.png`);
}
S.receipt.reads.phoneRotation=reads;S.save();
return {reads,registrationWrites:S.receipt.registrationsPosted.length,sales:(await S.stationSales(S.phoneStation)).map(x=>({id:x.id,status:x.status}))};

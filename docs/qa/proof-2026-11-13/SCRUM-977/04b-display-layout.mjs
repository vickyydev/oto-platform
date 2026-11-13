S.phase='French form heading and category arrows on deployed build';const {assert}=S,d=S.d,p=S.till;
await S.chooseLang(d,'Fran?ais');await d.waitForTimeout(500);
const overlap=await d.evaluate(()=>{const h=[...document.querySelectorAll('h2')].find(x=>x.getBoundingClientRect().width);const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')?.includes('langue'));const r=h?.getBoundingClientRect(),l=b?.getBoundingClientRect();return {heading:h?.textContent,language:b?.textContent,overlap:r&&l?Math.max(0,Math.min(r.right,l.right)-Math.max(r.left,l.left))*Math.max(0,Math.min(r.bottom,l.bottom)-Math.max(r.top,l.top)):null};});assert.equal(overlap.overlap,0);
await S.shot(d,'04d-display-french-heading-clear.png');await S.chooseLang(d,'English');
const sw=await d.evaluate(async()=>({registrations:(await navigator.serviceWorker.getRegistrations()).length,controller:Boolean(navigator.serviceWorker.controller)}));
await p.setViewportSize({width:700,height:900});await p.waitForTimeout(500);
const deskKept=await p.getByRole('heading',{name:'Children playing alone',exact:true}).isVisible();assert.ok(deskKept);await p.setViewportSize({width:1440,height:900});
S.receipt.reads.displayLayout={overlap,sw,deskKept};S.save();return {overlap,sw,deskKept};

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';

const ROOT='C:/oto-lanes/codex-beo-money-stage3-20261114';
const ATTEMPT=process.argv[2]??'attempt-01';
assert.match(ATTEMPT,/^attempt-\d{2}$/);
const OUT=ROOT+'/docs/qa/proof-2026-11-14/SCRUM-945/staging/'+ATTEMPT;
fs.mkdirSync(OUT,{recursive:true});
const APP='https://oto-app-staging.onrender.com';
const LAUNCHER='https://oto-launcher-staging.onrender.com';
const POS='https://oto-pos-web-staging.onrender.com';
const SHA=process.argv[3];
assert.match(SHA,/^[a-f0-9]{40}$/);
const { chromium }=createRequire(ROOT+'/apps/pos/package.json')('@playwright/test');
const st={unit:'SCRUM-945',startedAt:new Date().toISOString(),expectedSha:SHA,phase:'auth',fixtures:[],results:[],images:[],failures:[]};
const save=()=>fs.writeFileSync(OUT+'/receipt.json',JSON.stringify(st,null,2)+'\n');
save();
const browser=await chromium.launch({headless:true,channel:'msedge'});
const ctx=await browser.newContext({viewport:{width:1440,height:1200}});
ctx.setDefaultTimeout(30000);
const callOrigin=async(origin,method,route,body)=>{
 const r=await ctx.request.fetch(origin+'/api'+route,{method,data:body,headers:{origin,...(method==='GET'?{}:{'Idempotency-Key':randomUUID()})},timeout:180000});
 let value;try{value=await r.json()}catch{value=null}
 return {status:r.status(),body:value};
};
const call=(method,route,body)=>callOrigin(APP,method,route,body);
let aborting=false;
const abort=async(error)=>{
 if(aborting)process.exit(1);aborting=true;
 const safe={name:error?.name??'Error',message:String(error?.message??error).split('Call log:')[0].replace(/https?:\/\/\S+/g,'[url withheld]').slice(0,900),phase:st.phase,at:new Date().toISOString()};
 st.failures.push(safe);
 try{
  for(const f of st.fixtures){
   const read=await call('GET','/admin/events/'+f.id);
   if(read.status===200&&read.body.title===f.title&&read.body.branchId===f.branchId&&/^ZZ TEST 945/.test(f.title)){
    const archived=await call('POST','/admin/events/'+f.id+'/archive',{archived:true});
    const again=await call('GET','/admin/events/'+f.id);
    st.abortFixtureCleanup={id:f.id,status:archived.status,archivedAt:again.body?.archivedAt??null};
   }
  }
 }catch{st.abortFixtureCleanupNeeded=true;}
 try{
  await callOrigin(POS,'POST','/auth/sign-out',{});await call('POST','/logout',{});await callOrigin(LAUNCHER,'POST','/auth/sign-out',{});
  st.abortSessionReadback={pos:(await callOrigin(POS,'GET','/me')).status,app:(await call('GET','/user')).status,launcher:(await callOrigin(LAUNCHER,'GET','/me')).status};
 }catch{st.abortSessionCleanupNeeded=true;}
 try{await ctx.close();await browser.close();st.browserClosedAt=new Date().toISOString();}catch{}
 try{save();}catch{}
 console.error(JSON.stringify({unit:'SCRUM-945',phase:st.phase,error:safe,closed:!!st.browserClosedAt}));process.exit(1);
};
process.on('uncaughtException',error=>void abort(error));
process.on('unhandledRejection',error=>void abort(error));

assert.equal((await callOrigin(POS,'POST','/auth/sign-in',{phone:need('STAGING_ADMIN_PHONE'),password:need('STAGING_ADMIN_PASSWORD')})).status,200,'POS admin sign-in');
const posMe=await callOrigin(POS,'GET','/me');assert.equal(posMe.status,200);
assert.equal((await callOrigin(LAUNCHER,'POST','/auth/sign-in',{phone:need('STAGING_ADMIN_PHONE'),password:need('STAGING_ADMIN_PASSWORD')})).status,200,'launcher sign-in');
const handoff=await callOrigin(LAUNCHER,'POST','/auth/handoff',{app:'oto_app'});
assert.equal(handoff.status,200,'launcher handoff');
const page=await ctx.newPage();
const exchange=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/handoff'&&r.request().method()==='POST',{timeout:90000});
await page.goto(handoff.body.launchUrl,{waitUntil:'domcontentloaded',timeout:120000});
assert.equal((await exchange).status(),200,'app handoff exchange');
await page.waitForURL(u=>!u.hash.includes('handoff'),{timeout:60000});
const user=await call('GET','/user');assert.equal(user.status,200);
const names=[posMe.body.employee?.name,posMe.body.employee?.nickname,user.body.fullName,user.body.firstName,user.body.lastName,user.body.nickname,user.body.username,user.body.name].filter(x=>typeof x==='string'&&x.trim().length>=3);
st.role=user.body.role;
const branches=await call('GET','/branches');assert.equal(branches.status,200);
const branch=branches.body.find(x=>/Central Floresta/.test(x.name));assert.ok(branch);
st.branch={id:branch.id,name:branch.name};
const runtime=async()=>{const r=await call('GET','/qa-reports/config');assert.equal(r.status,200);return r.body.version};
st.runtimeAtAuth=await runtime();assert.equal(st.runtimeAtAuth,SHA,'exact live app source before fixtures');st.phase='ready';st.browser=browser.version();save();
const owned=async()=>{assert.equal(st.fixtures.length,1);const r=await call('GET','/admin/events/'+st.fixtures[0].id);assert.equal(r.status,200);assert.equal(r.body.title,st.fixtures[0].title);assert.equal(r.body.branchId,st.branch.id);assert.match(r.body.title,/^ZZ TEST 945/);return r.body};
const shot=async(name,locator=page.locator('[role="dialog"]').last())=>{
 assert.match(name,/^[a-z0-9-]+\.png$/);const masks=names.map(x=>page.getByText(x,{exact:true}).filter({visible:true}));
 await locator.screenshot({path:OUT+'/'+name,mask:masks,maskColor:'#111827'});st.images.push({name,at:new Date().toISOString(),masked:'signed-in account names only'});save();return name;
};
const posPage=await ctx.newPage();
const shotFor=async(which,name,locator)=>{
 const target=which==='pos'?posPage:page;assert.match(name,/^[a-z0-9-]+\.png$/);
 await (locator??target.locator('body')).screenshot({path:OUT+'/'+name,mask:names.map(x=>target.getByText(x,{exact:true}).filter({visible:true})),maskColor:'#111827'});
 st.images.push({name,surface:which,at:new Date().toISOString(),masked:'visible signed-in account names only'});save();return name;
};
const S={assert,fs,APP,LAUNCHER,POS,SHA,OUT,st,save,browser,ctx,page,posPage,branch,call,callOrigin,pos:(method,route,body)=>callOrigin(POS,method,route,body),runtime,owned,shot,shotFor,randomUUID,sleep:ms=>new Promise(r=>setTimeout(r,ms))};
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
let busy=false;
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/state'){res.end(JSON.stringify(st));return}
 if(req.url==='/STOP'&&req.method==='POST'){
  const ps=await callOrigin(POS,'POST','/auth/sign-out',{});const pr=await callOrigin(POS,'GET','/me');
  const a=await call('POST','/logout',{});const l=await callOrigin(LAUNCHER,'POST','/auth/sign-out',{});
  const ar=await call('GET','/user');const lr=await callOrigin(LAUNCHER,'GET','/me');
  st.signout={pos:ps.status,posReadback:pr.status,app:a.status,launcher:l.status,appReadback:ar.status,launcherReadback:lr.status,at:new Date().toISOString()};save();
  await ctx.close();await browser.close();st.browserClosedAt=new Date().toISOString();save();res.end(JSON.stringify(st.signout));server.close();return;
 }
 if(req.url!=='/run'||req.method!=='POST'){res.statusCode=404;res.end('{}');return}
 if(busy){res.statusCode=409;res.end('{}');return}
 busy=true;let code='';for await(const chunk of req)code+=chunk;
 try{const result=await new AsyncFunction('S',code)(S);save();res.end(JSON.stringify({ok:true,result}))}
 catch(e){const error={name:e.name,message:String(e.message).replace(/https?:\/\/\S+/g,'[url withheld]').slice(0,900),phase:st.phase,at:new Date().toISOString()};st.failures.push(error);save();res.statusCode=500;res.end(JSON.stringify({ok:false,error}))}
 finally{busy=false}
});
server.listen(47985,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port:47985,role:st.role,branch:st.branch,runtime:st.runtimeAtAuth,fixtures:st.fixtures.length})));

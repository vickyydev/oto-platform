import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'../..'), out=resolve(import.meta.dirname,'native-evidence');mkdirSync(out,{recursive:true});
const req=createRequire(resolve(root,'apps/console/package.json')), dbReq=createRequire(resolve(root,'packages/db/package.json')), apiReq=createRequire(resolve(root,'apps/api/package.json'));
const {chromium,expect}=req('@playwright/test'),pg=dbReq('pg');
const harness=readFileSync(resolve(root,'apps/console/e2e/run.mjs'),'utf8');
const serverUrl=process.env.TEST_DATABASE_URL||harness.match(/'(postgres:\/\/[^']+)'/)[1];
const fixture=readFileSync(resolve(root,'apps/console/e2e/console.ts'),'utf8');
const phone=fixture.match(/phone: '([^']+)'/)[1],password=fixture.match(/password: '([^']+)'/)[1];
const databaseName=`oto_snapshot_evidence_${Date.now()}`,db=new URL(serverUrl);db.pathname='/'+databaseName;
const children=[],checks=[];let browser,made=false,stage='database';
const pass=name=>{checks.push(name);process.stdout.write('PASS '+name+'\n');};
const freePort=()=>new Promise(done=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>done(String(p)));});});
async function sql(q){const c=new pg.Client({connectionString:serverUrl});await c.connect();try{await c.query(q);}finally{await c.end();}}
function start(bin,args,env={},cwd=root){const c=spawn(process.execPath,[bin,...args],{cwd,env:{...process.env,...env},stdio:'ignore',windowsHide:true});children.push(c);return c;}
async function run(bin,args,env,cwd){const c=start(bin,args,env,cwd);await new Promise((ok,fail)=>{c.on('exit',n=>n===0?ok():fail(new Error('Child check failed')));c.on('error',fail);});}
async function wait(url){for(let i=0;i<120;i++){try{if((await fetch(url)).ok)return;}catch{}await new Promise(ok=>setTimeout(ok,500));}throw new Error('Readiness failed');}
async function json(request,url,method='GET',data,headers={}){const r=await request.fetch(url,{method,data,headers:{'Idempotency-Key':randomUUID(),...headers}});if(!r.ok())throw new Error('HTTP '+r.status());return r.json();}
async function shot(page,name){await page.evaluate(()=>{let e=document.getElementById('proof-label');if(!e){e=document.createElement('div');e.id='proof-label';document.body.appendChild(e);}e.textContent='LOCAL CHECK · SCRUM-201 · disposable presentation · 29 September 2026';e.setAttribute('style','position:fixed;bottom:0;right:0;z-index:2147483647;background:#172554;color:white;padding:6px 10px;font:12px sans-serif;pointer-events:none');});await page.screenshot({path:resolve(out,name),animations:'disabled',mask:[page.locator('input[type="password"]'),page.getByTestId('display-pairing-code')]});}
try{
 await sql('CREATE DATABASE '+databaseName);made=true;
 stage='migration';await run(resolve(dbReq.resolve('drizzle-kit'),'../bin.cjs'),['migrate'],{DATABASE_URL:db.toString()},resolve(root,'packages/db'));
 await run(apiReq.resolve('tsx/cli'),['packages/db/src/seed/index.ts'],{DATABASE_URL:db.toString(),SEED_PROFILE:'staging'});
 const apiPort=await freePort(),consolePort=await freePort(),posPort=await freePort();
 const apiEnv={DATABASE_URL:db.toString(),API_PORT:apiPort,PROCESS_ROLES:'api,edge',DEPLOY_ENV:'local',NODE_ENV:'development',COOKIE_SECURE:'false',LOG_LEVEL:'silent'};
 let api=start(apiReq.resolve('tsx/cli'),['apps/api/src/index.ts'],apiEnv);
 const vite=resolve(req.resolve('vite/package.json'),'../bin/vite.js');
 start(vite,['--config','apps/console/vite.config.ts'],{API_PORT:apiPort,CONSOLE_PORT:consolePort});start(vite,['--config','apps/pos/vite.config.ts'],{API_PORT:apiPort,POS_PORT:posPort});
 const origin='http://127.0.0.1:'+consolePort,pos='http://127.0.0.1:'+posPort;
 await Promise.all([wait('http://127.0.0.1:'+apiPort+'/health'),wait(origin),wait(pos)]);
 browser=await chromium.launch({channel:'msedge',headless:true});
 const managerContext=await browser.newContext({viewport:{width:1440,height:1024}}),staffContext=await browser.newContext(),displayContext=await browser.newContext({viewport:{width:1024,height:768}});
 const manager=await managerContext.newPage(),display=await displayContext.newPage();
 stage='sign in';await json(manager.request,origin+'/api/auth/sign-in','POST',{phone,password});await json(staffContext.request,pos+'/api/auth/sign-in','POST',{phone,password});
 const park=(await json(manager.request,origin+'/api/branches')).branches.find(b=>b.name.includes('Central Floresta'));
 const target=(await json(manager.request,origin+'/api/branches/'+park.id+'/stations')).stations.find(s=>s.name==='Reception Till 1');
 await json(staffContext.request,pos+'/api/me/session/station','PUT',{stationId:target.id});
 const token=randomBytes(32).toString('hex'),auth={Authorization:'Bearer '+token};
 const mint=await json(displayContext.request,pos+'/api/display/pairing','POST',{},auth);
 const paired=await json(manager.request,origin+'/api/stations/'+target.id+'/displays/claim','POST',{pairingCode:mint.pairingCode,name:'Snapshot proof display'});
 const savedUrl=origin+'/api/credentials/'+paired.device.id+'/display-snapshot';
 if((await json(manager.request,savedUrl)).snapshot!==null)throw new Error('Expected empty history');pass('History stays empty before the first protected response');
 const cart={supported:true,nickname:'Guest',sale:{id:randomUUID(),tier:'tourist',total:420,lines:[{id:randomUUID(),name:'1 Hour Play',lineTotal:420,breakdown:{rows:[{key:'adults',kind:'adults',label:'Adults',unitPrice:420,quantity:1,subtotal:420}],priced:true,lengthChosen:true}}],manualDiscounts:[],creditGrants:[],bracelets:{adults:1,children:0}},voucherPrize:null,nothingToPay:false};
 async function publish(next){const claim=await json(staffContext.request,pos+'/api/stations/'+target.id+'/lease','POST',{holder:'snapshot-native-proof'});const current=await json(staffContext.request,pos+'/api/stations/'+target.id+'/session');await json(staffContext.request,pos+'/api/stations/'+target.id+'/intents','POST',{type:'session.publish_display',leaseId:claim.lease.leaseId,lastSeenSequence:current.document.sequence,actionId:randomUUID(),payload:{stage:next,step:3,cart,member:null,totals:{manualAmounts:{},discountAmount:0,total:420,taxBreakdown:{serviceChargeTotal:0,categories:[]}},payment:next==='payment'?{saleId:cart.sale.id,amountSatang:42000,qrPayload:null,qrImageUrl:null,expiresAt:null,status:'idle',offline:false,online:true}:null,prompt:null}});}
 stage='order';await publish('order');await displayContext.addInitScript(value=>localStorage.setItem('oto.display.credential',value),token);await display.goto(pos+'/display');
 await expect(display.getByText('1 Hour Play',{exact:true})).toBeVisible({timeout:30000});
 await expect.poll(async()=>(await json(manager.request,savedUrl)).snapshot?.document.stage).toBe('order');
 await manager.goto(origin+'/health');await expect(manager.getByRole('heading',{name:'Health',exact:true})).toBeVisible({timeout:30000});await manager.getByRole('link',{name:'Devices',exact:true}).click();await manager.getByLabel('Branch').selectOption(park.id);
 const row=manager.locator('li').filter({hasText:'Snapshot proof display'});
 await row.getByRole('button',{name:'Snapshot',exact:true}).click();await expect(manager.getByLabel('Last recorded display snapshot')).toContainText('1 Hour Play');
 await shot(manager,'20-local-console-recorded-response.png');await manager.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();pass('Actual display poll records a safe order visible in the Console');
 stage='disconnection';await displayContext.setOffline(true);await expect(display.getByRole('alert')).toBeVisible({timeout:15000});
 const retained=(await json(manager.request,savedUrl)).snapshot;await publish('payment');
 const current=await json(staffContext.request,pos+'/api/stations/'+target.id+'/session');if(current.document.stage!=='payment')throw new Error('Till did not advance');
 await row.getByRole('button',{name:'Snapshot',exact:true}).click();await manager.getByRole('button',{name:'Refresh snapshot',exact:true}).click();
 await expect(manager.getByLabel('Last recorded display snapshot')).toContainText('order');
 const still=(await json(manager.request,savedUrl)).snapshot;if(JSON.stringify(still)!==JSON.stringify(retained))throw new Error('History replaced without delivery');
 await shot(manager,'21-local-console-disconnected-history.png');await manager.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();pass('Offline display retains the same saved response and time while staff advances to payment');
 stage='reconnection';await displayContext.setOffline(false);await expect.poll(async()=>(await json(manager.request,savedUrl)).snapshot?.document.stage,{timeout:15000}).toBe('payment');pass('Reconnected display replaces saved order with its actual payment response');
 stage='revocation';await row.getByRole('button',{name:'Revoke',exact:true}).click();await expect(display.getByRole('heading',{name:'Set up this display',exact:true})).toBeVisible({timeout:15000});
 await displayContext.setOffline(true);await manager.getByRole('button',{name:'Show revoked',exact:true}).click();
 const saved=await json(manager.request,savedUrl);if(!saved.revoked||!saved.snapshot)throw new Error('Missing revoked history');
 await row.getByRole('button',{name:'Snapshot',exact:true}).click();await expect(manager.getByLabel('Last recorded display snapshot')).toBeVisible();await shot(manager,'22-local-console-revoked-response.png');pass('Revoked display retains history after its protected requests are rejected');
 stage='restart';spawnSync('taskkill',['/PID',String(api.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await new Promise(ok=>api.exitCode!==null?ok():api.once('exit',ok));api=start(apiReq.resolve('tsx/cli'),['apps/api/src/index.ts'],apiEnv);await wait('http://127.0.0.1:'+apiPort+'/health');
 const restored=await json(manager.request,savedUrl);if(JSON.stringify(restored.snapshot)!==JSON.stringify(saved.snapshot)||!restored.revoked)throw new Error('History changed after restart');pass('Cold API restart retains the exact saved response and prepared time');
 writeFileSync(resolve(out,'report.json'),JSON.stringify({result:'PASS',environment:'local disposable database; real protected API and browser; synthetic public order only',checks,limitations:['No sale or payment executed in this focused rerun','Earlier23 full ticket/browser checks passed but their temporary images and report were cleared by a test output path error','No staging or physical Pi verification']},null,2));
}catch(error){process.stdout.write('FAIL '+stage+' '+error.name+' '+String(error.message).split('\n')[0].replaceAll(password,'[masked]').replaceAll(phone,'[masked]').slice(0,140)+'\n');process.exitCode=1;writeFileSync(resolve(out,'report.json'),JSON.stringify({result:'FAIL',stage,checks},null,2));}
finally{await browser?.close();for(const c of children.reverse())if(c.exitCode===null&&c.pid)spawnSync('taskkill',['/PID',String(c.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});if(made)await sql('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');}

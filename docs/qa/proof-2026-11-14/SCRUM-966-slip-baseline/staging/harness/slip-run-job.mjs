// Prepared unexecuted exact-image rollback proof coordinator.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {render,service} from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/render.mjs';
const OUT='C:/oto-lanes/codex-slip-baseline-20261114/docs/qa/proof-2026-11-14/SCRUM-966-slip-baseline/staging/runtime-job.json';
const mode=process.argv[2];assert.ok(['start','poll'].includes(mode));
const svc=await service('oto-api-staging');assert.ok(svc);
let receipt;
if(mode==='start'){
 const args=process.argv.slice(3);assert.equal(args.length,5);assert.match(args[0],/^[a-f0-9]{40}$/);
 if(fs.existsSync(OUT)){const old=JSON.parse(fs.readFileSync(OUT));assert.ok(['succeeded','failed','canceled'].includes(old.status),'Previous job must be terminal');}
 const deps=await render('GET',`/services/${svc.id}/deploys?limit=8`);const live=deps.map(x=>x.deploy).find(x=>x.status==='live');assert.equal(live?.commit?.id,args[0]);
 const bytes=fs.readFileSync('C:/oto-lanes/audit-takeover-20261113/slip-runtime-worker.mjs');
 const b64=bytes.toString('base64');const arg64=Buffer.from(JSON.stringify(args)).toString('base64');
 const remote=`import fs from "node:fs";import{spawnSync}from"node:child_process";fs.writeFileSync(".qa966-slip-proof.mjs",Buffer.from("${b64}","base64"));let r;try{r=spawnSync(process.execPath,["--import","tsx",".qa966-slip-proof.mjs",...JSON.parse(Buffer.from("${arg64}","base64").toString())],{stdio:"inherit"});}finally{fs.unlinkSync(".qa966-slip-proof.mjs");}process.exitCode=r.status??1;`;
 assert.ok(!remote.includes("'"));
 const job=await render('POST',`/services/${svc.id}/jobs`,{startCommand:`cd apps/api && node --input-type=module -e '${remote}'`});assert.ok(job.id);
 receipt={unit:'SCRUM-966-slip-baseline',expectedSha:args[0],eventId:args[1],branchId:args[2],deployId:live.id,jobId:job.id,workerSha256:crypto.createHash('sha256').update(bytes).digest('hex'),startedAt:new Date().toISOString(),status:job.status,markers:[],results:[],errors:[]};
 fs.mkdirSync(OUT.slice(0,OUT.lastIndexOf('/')),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify({jobId:job.id,status:job.status,eventId:args[1],expectedSha:args[0]}));
}else{
 receipt=JSON.parse(fs.readFileSync(OUT));const job=await render('GET',`/services/${svc.id}/jobs/${receipt.jobId}`);receipt.status=job.status;receipt.checkedAt=new Date().toISOString();
 const qs=new URLSearchParams({ownerId:svc.ownerId,resource:receipt.jobId,startTime:receipt.startedAt,limit:'100',direction:'forward'});
 const logs=await render('GET',`/logs?${qs}`);const messages=(logs.logs??[]).map(x=>x.message).filter(x=>typeof x==='string');
 const take=prefix=>messages.filter(x=>x.startsWith(prefix)).map(x=>JSON.parse(x.slice(prefix.length)));
 receipt.markers=take('SCRUM966_READY ');receipt.results=take('SCRUM966_RESULT ');receipt.errors=take('SCRUM966_ERROR ');
 fs.writeFileSync(OUT,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({status:receipt.status,markers:receipt.markers,results:receipt.results,errors:receipt.errors}));
}

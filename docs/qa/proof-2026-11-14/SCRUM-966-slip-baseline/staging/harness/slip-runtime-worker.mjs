// Prepared exact-fixture proof only. Do not execute before release-slot prerequisites.
import assert from 'node:assert/strict';
import { getDb, closeDb, partySlipBaseline, partySlipPrint, prepSlipPrint, printJob, branch, auditLog, station } from '@oto/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { newId } from '@oto/shared';
import { readPartyPlan } from './src/services/party-plan.ts';
import { getBranchEvent } from './src/services/otoapp-events.ts';
import { printPartySlips, printPartySlipChanges } from './src/services/party-slips.ts';

const [expectedSha,eventId,branchId,expectedTitle,expectedLine]=process.argv.slice(2);
const uuid=/^[a-f0-9-]{36}$/;
assert.match(expectedSha??'',/^[a-f0-9]{40}$/);
assert.equal(process.env.RENDER_GIT_COMMIT,expectedSha);
for(const id of [eventId,branchId])assert.match(id??'',uuid);
assert.match(expectedTitle??'',/^ZZ TEST966 SLIP /);
assert.match(expectedLine??'',/^ZZ TEST966 /);
const db=getDb(undefined,{max:1,statementTimeoutMs:10000,applicationName:'zz-test-966-slip-rollback-proof'});
const receipt={version:1,expectedSha,eventId,branchId,simulation:'Older composer mark only; native event edits are real; platform transaction always rolls back',cases:[],printJobIds:[],limits:['No physical printer acceptance','Publication-format and missing-row boundaries are local actual-view test evidence']};
const rollback=new Error('EXPECTED_QA_ROLLBACK');
let phase='preflight';let operatorId;
const rows=(tx,table)=>tx.select().from(table).where(eq(table.eventId,eventId));
const markOlder=async tx=>{
 const current=await rows(tx,partySlipBaseline);assert.equal(current.length,2);
 for(const m of current)await tx.update(partySlipBaseline).set({composer:'qa_previous:'+m.composer.split(':').at(-1)}).where(eq(partySlipBaseline.id,m.id));
};
const action=()=>`zz-test-966-slip-${newId()}`;
const tick=(tx,partyDate)=>printPartySlipChanges(tx,{operatorId,branchId,eventId,partyDate,actionId:action(),now:new Date()});
const brief=r=>({outcome:r.outcome,slips:(r.slips??[]).map(x=>({station:x.station,variant:x.variant,lines:x.document?.lines??[]}))});
const captureJobs=async tx=>{
 const slips=[...await rows(tx,partySlipPrint),...await rows(tx,prepSlipPrint)];
 receipt.printJobIds=[...new Set([...receipt.printJobIds,...slips.map(x=>x.printJobId).filter(Boolean)])];
 assert.equal(receipt.printJobIds.length,0,'No printer job may be allocated in the bounded proof');
};
const waitPlan=async(tx,predicate,phase)=>{
 console.log('SCRUM966_READY '+JSON.stringify({eventId,phase}));
 const until=Date.now()+150000;
 while(Date.now()<until){const r=await readPartyPlan(tx,{branchId,eventId});const event=await getBranchEvent(tx,{branchId,eventId});if(predicate(r,event))return r;await new Promise(r=>setTimeout(r,750));}
 throw Object.assign(new Error(),{code:'NATIVE_PHASE_TIMEOUT'});
};
try{
 try{
  await db.transaction(async tx=>{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
   await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`party-slips:${eventId}:qa-preflight`},0))`);
   const own=await getBranchEvent(tx,{branchId,eventId});assert.ok(own);assert.equal(own.title,expectedTitle);assert.equal(own.archived,false);assert.equal(own.type,'party');
   const [b]=await tx.select({operatorId:branch.operatorId,partySlipsStationId:branch.partySlipsStationId,archivedAt:branch.archivedAt}).from(branch).where(eq(branch.id,branchId));assert.ok(b);assert.equal(b.archivedAt,null);assert.match(b.operatorId,uuid);operatorId=b.operatorId;
   if(b.partySlipsStationId){const [named]=await tx.select({boxId:station.boxId,archivedAt:station.archivedAt}).from(station).where(and(eq(station.id,b.partySlipsStationId),eq(station.branchId,branchId),eq(station.operatorId,operatorId)));if(named&&!named.archivedAt&&named.boxId)throw Object.assign(new Error(),{code:'PARTY_PRINTER_ROUTE_PRESENT'});}
   // With no box route, this long-lived rollback proof cannot hold a shared box queue lock.

   const plan=await readPartyPlan(tx,{branchId,eventId});assert.ok(plan.kitchen);assert.equal(plan.source,'kitchen_plan_1');
   assert.equal(plan.kitchen.setMenu.filter(x=>x.name===expectedLine&&x.qty===2).length,1);
   const partyDate=plan.kitchen.partyDate;assert.ok(partyDate>new Date().toISOString().slice(0,10),'Own event must be future dated');
   for(const table of [partySlipBaseline,partySlipPrint,prepSlipPrint])assert.equal((await rows(tx,table)).length,0);
   const first=await printPartySlips(tx,{operatorId,branchId,eventId,trigger:'schedule',actorAccountId:null,actionId:action(),now:new Date()});
   assert.equal(first.outcome,'printed');await captureJobs(tx);
   const saved=await rows(tx,partySlipBaseline);assert.equal(saved.length,2);assert.ok(saved.every(x=>x.held?.composeInput?.version===1));
   const initial=saved.find(x=>x.station==='kitchen');assert.ok(initial.held.lines.some(x=>x.name===expectedLine&&x.qty===2));receipt.initialGivenLines=initial.held.lines;
   await tx.execute(sql`SAVEPOINT proof_base`);
   phase='unchanged-upgrade';await markOlder(tx);const unchanged=await tick(tx,partyDate);assert.equal(unchanged.outcome,'rebased');assert.equal((await rows(tx,prepSlipPrint)).length,0);
   assert.equal((await tick(tx,partyDate)).outcome,'unchanged');receipt.cases.push({name:'unchanged older composer',passed:true});
   await tx.execute(sql`ROLLBACK TO SAVEPOINT proof_base`);
   phase='historical-fallback';await markOlder(tx);await tx.update(partySlipBaseline).set({held:sql`${partySlipBaseline.held} - 'composeInput'`}).where(eq(partySlipBaseline.eventId,eventId));
   assert.equal((await tick(tx,partyDate)).outcome,'rebased');assert.equal((await rows(tx,prepSlipPrint)).length,0);
   const [fallbackAudit]=await tx.select({after:auditLog.after}).from(auditLog).where(and(eq(auditLog.entityId,eventId),eq(auditLog.action,'party.slips_rebase')));
   assert.ok(fallbackAudit?.after?.stations?.every(x=>x.reason==='historical_without_snapshot'));
   assert.ok((await rows(tx,partySlipBaseline)).every(x=>x.held?.composeInput?.version===1));
   receipt.cases.push({name:'historical snapshot fallback',passed:true,auditReason:'historical_without_snapshot'});
   await tx.execute(sql`ROLLBACK TO SAVEPOINT proof_base`);
   await markOlder(tx);
   phase='native-edit';await waitPlan(tx,r=>r.kitchen?.setMenu.some(x=>x.name===expectedLine&&x.qty===3),'edit-own-line-2-to-3');
   const edited=await tick(tx,partyDate);receipt.observedEdit=brief(edited);assert.equal(edited.outcome,'printed','A real edit must emit correction slips');
   const k=(edited.slips??[]).filter(x=>x.station==='kitchen');assert.deepEqual(k.map(x=>x.variant),['updated'],'Adding portions has no removed food to VOID');
   assert.ok(k[0].document.lines.some(x=>x.name===expectedLine&&x.qty===3));
   assert.equal((await tick(tx,partyDate)).outcome,'unchanged');receipt.cases.push({name:'native edit before upgraded tick',passed:true,result:brief(edited)});await captureJobs(tx);
   phase='native-archive';await waitPlan(tx,(r,event)=>event?.status==='cancelled'||event?.archived===true,'archive-own-event');
   const cancelled=await tick(tx,partyDate);assert.equal(cancelled.outcome,'printed');assert.equal(cancelled.cancelled,true);
   assert.ok(cancelled.slips.every(x=>x.variant==='void'));assert.ok(cancelled.slips.some(x=>x.document.lines.some(y=>y.name.includes(expectedLine)&&y.qty===3)));
   receipt.cases.push({name:'native archival voids actual lines',passed:true,result:brief(cancelled)});await captureJobs(tx);
   throw rollback;
  });
 }catch(e){if(e!==rollback)throw e;}
 receipt.rollbackVerified={};
 for(const [name,table]of [['baseline',partySlipBaseline],['print',partySlipPrint],['prep',prepSlipPrint]]){const n=(await rows(db,table)).length;assert.equal(n,0);receipt.rollbackVerified[name]=n;}
 if(receipt.printJobIds.length)assert.equal((await db.select({id:printJob.id}).from(printJob).where(inArray(printJob.id,receipt.printJobIds))).length,0);
 receipt.rollbackVerified.printJobs=0;receipt.passed=true;console.log('SCRUM966_RESULT '+JSON.stringify(receipt));
}catch(e){console.error('SCRUM966_ERROR '+JSON.stringify({name:e?.name??'Error',code:e?.code??'UNKNOWN',phase,eventId,assertion:e?.name==='AssertionError'?String(e.message).replace(/https?:\/\/\S+/g,'[URL withheld]').slice(0,1500):undefined,observedEdit:receipt.observedEdit}));process.exitCode=1;}
finally{await closeDb();}

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';

/** SCRUM-522: real camp routes and PostgreSQL with a provider double.
 * Passing pins drive another park, another camp, altered phone, expired
 * proof, grant replay and all public saved-profile mutation paths.
 * No provider message is sent and no phone, code or grant is printed.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
let results: Record<string, boolean>;

describe.skipIf(!available)('camp returning-family SMS review', () => {
  afterAll(stopTestServer);
  beforeAll(async () => {
    const database = await createTestDatabase();
    const directory = mkdtempSync(join(tmpdir(), 'oto-camp-sms-review-'));
    const env = { ...process.env, DATABASE_URL: database.url, DB_SCHEMA: 'otoapp',
      APP_ENV: 'dev', DEPLOY_ENV: 'local', OBJECT_STORAGE: 'local', STORAGE_ENV_PREFIX: 'zz-camp-sms',
      OTOAPP_JOBS: 'platform', NODE_ENV: 'test', SESSION_SECRET: randomBytes(32).toString('hex') };
    try {
      for (let pass = 0; pass < 2; pass++) {
        const migration = spawnSync(process.execPath, [join(APP, 'script/migrate.mjs')],
          { cwd: APP, env, encoding: 'utf8', timeout: 120_000 });
        expect(migration.status, 'App migration and replay complete').toBe(0);
      }
      const script = join(directory, 'camp.mts');
      writeFileSync(script, String.raw`
import { randomUUID, randomInt, randomBytes, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const app=${JSON.stringify(APP)},moduleUrl=path=>pathToFileURL(app+path).href;
let stage='imports';
const report=error=>{console.log('CAMP_SETUP_ERROR='+JSON.stringify({stage,name:error?.name,code:error?.code,column:error?.column,table:error?.table,constraint:error?.constraint}));process.exit(1);};
process.on('uncaughtException',report);process.on('unhandledRejection',report);
const require=createRequire(app+'package.json'),express=require('express'),pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('set search_path to otoapp');
const q=async(text,values=[])=>{stage='SQL '+text.split(/\s+/).slice(0,3).join(' ');return (await c.query(text,values)).rows;};
const {registerCampRegistrationRoutes}=await import(moduleUrl('server/camp-registration-routes.ts'));
const {fullPickupPhone}=await import(moduleUrl('server/camp-family-verification.ts'));
const codes=new Map(),byPhone=new Map();let sends=0,checks=0,configured=true,providerFailure=false;
const provider={configured:()=>configured,send:async phone=>{if(providerFailure)throw new Error('ZZ TEST provider private detail');const id=randomUUID();codes.set(id,String(randomInt(100000,1000000)));byPhone.set(phone,id);sends++;return id;},verify:async(id,code)=>{checks++;return codes.get(id)===code;}};
const api=express();api.use(express.json());let allowedPhotoOwner;
registerCampRegistrationRoutes(api,{provider,campPreviewUrl:(registration,_field,_branch,expiry)=>registration.childPhotoUrl?'/zz-test-preview?exp='+expiry:null,
 resolveCampAttachment:async(supplied,_field,_event,_actor,identity)=>supplied==null||supplied===''?null:identity.registrationIds?.includes(allowedPhotoOwner)?supplied:false});
let server,photoServer;
try {
 const phone=()=>'+669'+String(randomInt(10000000,100000000));
 const groups=[];
 for(const label of ['A','B']){
  const tenant=randomUUID();await q('insert into tenants(id,name,slug) values($1,$2,$3)',[tenant,'ZZ TEST Camp SMS '+label,'zz-camp-sms-'+tenant]);
  const branch=(await q("insert into branches(tenant_id,name,address) values($1,$2,'ZZ TEST address') returning id",[tenant,'ZZ TEST Branch '+label]))[0].id;
  const event=(await q("insert into core_events(tenant_id,branch_id,event_type,title,event_date,start_time) values($1,$2,'camp',$3,'2099-04-01','09:00') returning id",[tenant,branch,'ZZ TEST Camp '+label]))[0].id;
  groups.push({tenant,branch,event});
 }
 const [a,b]=groups;
 const otherEvent=(await q("insert into core_events(tenant_id,branch_id,event_type,title,event_date,start_time) values($1,$2,'camp','ZZ TEST Prior Camp','2099-03-01','09:00') returning id",[a.tenant,a.branch]))[0].id;
 const addReg=async(group,contact,name='ZZ TEST Child',event=group.event)=> (await q("insert into camp_registrations(tenant_id,event_id,child_full_name,date_of_birth,parent_guardian_name,emergency_contact_number,parent_signature,signature_date,agreed_camp_rules,agreed_child_healthy,agreed_camp_rules_date,allergies,child_photo_url) values($1,$2,$3,'2090-01-01','ZZ TEST Guardian',$4,'ZZ TEST signature','2099-01-01',true,true,'2099-01-01','ZZ TEST original','/api/files/camp-photos-private/zz-owned.png') returning id",[group.tenant,event,name,contact]))[0].id;
 const sharedPhone=phone(),reg=await addReg(a,sharedPhone),oldReg=await addReg(a,sharedPhone,'ZZ TEST Child',otherEvent),foreignReg=await addReg(b,sharedPhone);
 allowedPhotoOwner=reg;
 const account=randomUUID();await q("insert into users(id,email,password,full_name,role,phone_e164,phone_verified) values($1,$2,'ZZ TEST unused credential','ZZ TEST Account','staff',$3,false)",[account,account+'@zz-test.invalid',sharedPhone]);
 server=await new Promise(resolve=>{const s=api.listen(0,'127.0.0.1',()=>resolve(s));});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,body,grant,method='POST')=>{stage='HTTP '+path;const response=await fetch(origin+path,{method,headers:{'content-type':'application/json',...(grant?{'x-camp-family-grant':grant}:{})},body:method==='GET'?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const data=await response.json();return {status:response.status,data,grant:response.headers.get('x-camp-family-grant')};};
 const root='/api/public/camp-registrations';
 const request=(eventId,contact)=>call(root+'/sms/request',{purpose:'camp-family',eventId,phone:contact});
 const verify=(eventId,contact,challengeId,code)=>call(root+'/sms/verify',{purpose:'camp-family',eventId,phone:contact,challengeId,code});
 const lookup=(eventId,contact,grant)=>call(root+'/lookup',{eventId,phone:contact},grant);
 const body=(eventId,contact,extra={})=>({eventId,childFullName:'ZZ TEST Child',dateOfBirth:'2090-01-01',parentGuardianName:'ZZ TEST Guardian',emergencyContactNumber:contact,parentSignature:'ZZ TEST fresh signature',signatureDate:'2099-04-01',agreedCampRules:true,agreedChildHealthy:true,attendanceDays:['2099-04-01'],allergies:'ZZ TEST updated',...extra});
 const rows={};
 const initial=await lookup(a.event,sharedPhone);const legacy=await call(root+'/lookup?eventId='+a.event+'&phone='+encodeURIComponent(sharedPhone),undefined,undefined,'GET');
 rows.noSavedDisclosure=initial.status===200&&initial.data.verificationRequired===true&&!('children' in initial.data)&&!('parentContacts' in initial.data)&&!('children' in legacy.data);
 rows.noSavedMutation=(await call(root,body(a.event,sharedPhone,{existingRegistrationId:reg}))).status===403&&(await call(root,body(a.event,sharedPhone))).status===403&&(await call(root,body(otherEvent,sharedPhone))).status===403&&(await q('select allergies from camp_registrations where id=$1',[reg]))[0].allergies==='ZZ TEST original';
 const beforeSends=sends;configured=false;const unavailable=await request(a.event,sharedPhone);configured=true;
 rows.providerUnavailable=unavailable.status===503&&sends===beforeSends;
 const wrongPurpose=await call(root+'/sms/request',{purpose:'account-phone',eventId:a.event,phone:sharedPhone});
 const challenge=await request(a.event,sharedPhone);if(challenge.status!==200)throw new Error('Challenge setup');
 const code=codes.get(byPhone.get(sharedPhone));
 rows.purposeAndCamp=wrongPurpose.status===400&&(await verify(otherEvent,sharedPhone,challenge.data.challengeId,code)).status===403&&(await verify(b.event,sharedPhone,challenge.data.challengeId,code)).status===403;
 const approved=await verify(a.event,sharedPhone,challenge.data.challengeId,code);if(approved.status!==200)throw new Error('Verification setup');
 const checkCount=checks;
 rows.challengeReplay=(await verify(a.event,sharedPhone,challenge.data.challengeId,code)).status===403&&checks===checkCount;
 rows.lookupGrantCannotWrite=(await call(root,body(a.event,sharedPhone,{existingRegistrationId:reg}),approved.data.grant)).status===403;
 const found=await lookup(a.event,sharedPhone,approved.data.grant);if(found.status!==200)throw new Error('Verified lookup setup');
 let writeGrant=found.data.familyGrant;
 rows.verifiedLookup=found.data.children.length===1&&found.data.children[0].existingRegistrationId===reg&&found.data.children[0].allergies==='ZZ TEST original'&&!!found.data.children[0].childPhotoPreviewUrl&&!!found.data.agreedCampRulesDate;
 rows.previewExpiry=Number(new URL(found.data.children[0].childPhotoPreviewUrl,origin).searchParams.get('exp'))===new Date(approved.data.expiresAt).getTime();
 rows.lookupReplay=(await lookup(a.event,sharedPhone,approved.data.grant)).status===403&&(await lookup(a.event,sharedPhone,writeGrant)).status===403;
 rows.swappedGrant=(await call(root,body(b.event,sharedPhone,{existingRegistrationId:foreignReg}),writeGrant)).status===403&&(await call(root,body(otherEvent,sharedPhone,{existingRegistrationId:oldReg}),writeGrant)).status===403&&(await call(root,body(a.event,phone(),{existingRegistrationId:reg}),writeGrant)).status===403&&(await call(root,body(a.event,sharedPhone,{existingRegistrationId:foreignReg}),writeGrant)).status===403;
 const userBefore=(await q('select phone_verified,phone_verified_at from users where id=$1',[account]))[0];
 rows.accountUntouched=userBefore.phone_verified===false&&userBefore.phone_verified_at===null;
 const failedBatch=await call(root+'/batch',{registrations:[body(a.event,sharedPhone,{existingRegistrationId:reg}),body(a.event,sharedPhone,{childFullName:'ZZ TEST Sibling',dateOfBirth:''})]},writeGrant);
 rows.batchRollback=failedBatch.status===400&&(await q('select allergies from camp_registrations where id=$1',[reg]))[0].allergies==='ZZ TEST original';
 await q("create function zz_camp_fail() returns trigger language plpgsql as $$ begin if OLD.event_id <> NEW.event_id then return NEW; end if; raise exception 'ZZ TEST injected'; end $$");
 await q('create trigger zz_camp_fail before update on camp_registrations for each row when (OLD.id = '+"'"+oldReg+"'"+') execute function zz_camp_fail()');
 const failedPropagation=await call(root,body(a.event,sharedPhone,{existingRegistrationId:reg}),writeGrant);
 await q('drop trigger zz_camp_fail on camp_registrations');
 rows.propagationRollback=failedPropagation.status===500&&(await q('select allergies from camp_registrations where id=$1',[reg]))[0].allergies==='ZZ TEST original';
 const saved=await call(root,body(a.event,sharedPhone,{existingRegistrationId:reg,parentSignature:undefined,usePriorAgreement:true,childPhotoUrl:'/api/files/camp-photos-private/zz-owned.png'}),writeGrant);
 rows.savedAndPriorAgreement=saved.status===200&&saved.data.parentSignature==='ZZ TEST signature'&&saved.data.agreedCampRulesDate.startsWith('2099-01-01')&&(await q('select allergies from camp_registrations where id=$1',[oldReg]))[0].allergies==='ZZ TEST updated'&&(await q('select allergies from camp_registrations where id=$1',[foreignReg]))[0].allergies==='ZZ TEST original';
 rows.writeReplay=(await call(root,body(a.event,sharedPhone,{existingRegistrationId:reg}),writeGrant)).status===403;
 writeGrant=saved.grant;
 const raced=await Promise.all([1,2].map(()=>call(root,body(a.event,sharedPhone,{existingRegistrationId:reg}),writeGrant)));
 rows.concurrentReplay=raced.map(result=>result.status).sort().join(',')==='200,403';
 writeGrant=raced.find(result=>result.status===200)?.grant;
 const returningBatch=await call(root+'/batch',{registrations:[body(a.event,sharedPhone,{existingRegistrationId:reg}),body(a.event,sharedPhone,{childFullName:'ZZ TEST Verified Sibling'})]},writeGrant);
 const siblingId=returningBatch.data?.[1]?.id;
 const siblingUpdate=await call(root,body(a.event,sharedPhone,{childFullName:'ZZ TEST Verified Sibling',existingRegistrationId:siblingId}),returningBatch.grant);
 rows.returningBatch=returningBatch.status===200&&returningBatch.data.length===2&&siblingUpdate.status===200;
 writeGrant=siblingUpdate.grant;
 await q("update camp_family_challenges set expires_at=now()-interval '1 second' where id=$1",[challenge.data.challengeId]);
 rows.expiredGrant=(await call(root,body(a.event,sharedPhone,{existingRegistrationId:reg}),writeGrant)).status===403;
 const freshPhone=phone();const fresh=await call(root+'/batch',{registrations:[body(a.event,freshPhone,{childFullName:'ZZ TEST New One'}),body(a.event,freshPhone,{childFullName:'ZZ TEST New Two'})]});
 const sibling=await call(root,body(a.event,freshPhone,{childFullName:'ZZ TEST New Three'}));
 rows.newFamiliesAndSiblings=fresh.status===200&&fresh.data.length===2&&sibling.status===201&&!fresh.grant&&!sibling.grant&&(await call(root,body(a.event,freshPhone,{childFullName:'ZZ TEST New One'}))).status===403;
 const escaped=await call(root,body(a.event,phone(),{existingRegistrationId:reg}));
 const copied=await call(root,body(a.event,phone(),{usePriorAgreement:true,parentSignature:undefined}));
 rows.explicitAndPriorBypass=escaped.status===403&&copied.status===403;
 const secondary=phone(),pickup=phone();await q('update camp_registrations set parent_contacts=$1,authorized_pickup_persons=$2 where id=$3',[JSON.stringify([{name:'ZZ TEST Additional',phone:secondary}]),'ZZ TEST pickup '+pickup,reg]);
 rows.matchingContacts=(await lookup(a.event,secondary)).data.verificationRequired===true&&(await lookup(a.event,pickup)).data.verificationRequired===true&&!fullPickupPhone('ZZ TEST '+pickup,pickup.slice(2))&&!fullPickupPhone('ZZ TEST '+pickup,pickup.slice(0,-1));
 rows.partialPickup=!fullPickupPhone('ZZ TEST '+pickup,pickup.slice(1));
 await q("delete from auth_rate_limits where key like 'camp-family:%'");
 const ratePhone=phone();await addReg(a,ratePhone,'ZZ TEST Rate Child');const first=await request(a.event,ratePhone);await request(a.event,ratePhone);const latest=await request(a.event,ratePhone);
 rows.requestPhoneLimit=(await request(a.event,ratePhone)).status===429&&(await verify(a.event,ratePhone,first.data.challengeId,codes.get(byPhone.get(ratePhone)))).status===403;
 await q("delete from auth_rate_limits where key like 'camp-family:verify-phone:%'");
 const invalid=String((Number(codes.get(byPhone.get(ratePhone)))+1)%1000000).padStart(6,'0');const attempts=[];
 for(let attempt=0;attempt<6;attempt++)attempts.push((await verify(a.event,ratePhone,latest.data.challengeId,invalid)).status);
 rows.verifyLimit=attempts.slice(0,5).every(status=>status===400)&&attempts[5]===429;
 await q("delete from auth_rate_limits where key like 'camp-family:%'");
 const ipStatuses=[];for(let attempt=0;attempt<11;attempt++)ipStatuses.push((await request(a.event,phone())).status);
 rows.requestIpLimit=ipStatuses.slice(0,10).every(status=>status===200)&&ipStatuses[10]===429;
 await q("delete from auth_rate_limits where key like 'camp-family:%'");
 providerFailure=true;const providerError=await request(a.event,sharedPhone);providerFailure=false;
 rows.providerErrorPrivate=providerError.status===503&&!JSON.stringify(providerError.data).includes('private detail');
 const expiryChallenge=await request(a.event,sharedPhone);await q("update camp_family_challenges set expires_at=now()-interval '1 second' where id=$1",[expiryChallenge.data.challengeId]);
 const checksBefore=checks;rows.expiredChallenge=(await verify(a.event,sharedPhone,expiryChallenge.data.challengeId,codes.get(byPhone.get(sharedPhone)))).status===403&&checks===checksBefore;
 stage='actual photo route';
 process.chdir(${JSON.stringify(directory)});
 mkdirSync('camp-photos-private',{recursive:true});writeFileSync('camp-photos-private/zz-owned.png',Buffer.from([137,80,78,71,13,10,26,10]));
 const {registerRoutes}=await import(moduleUrl('server/routes.ts'));
 const photoApi=express();photoApi.use(express.json());const photoHttp=createServer(photoApi);await registerRoutes(photoHttp,photoApi);
 photoServer=await new Promise(resolve=>photoHttp.listen(0,'127.0.0.1',()=>resolve(photoHttp)));
 const photoOrigin='http://127.0.0.1:'+photoServer.address().port;
 const proof=randomBytes(32).toString('hex'),deadline=Date.now()+60000;
 await q("update camp_family_challenges set state='verified',grant_purpose='lookup',grant_hash=$1,expires_at=$2 where id=$3",[createHmac('sha256',process.env.SESSION_SECRET).update('camp-family:'+proof).digest('hex'),new Date(deadline),expiryChallenge.data.challengeId]);
 const realLookup=await fetch(photoOrigin+root+'/lookup',{method:'POST',headers:{'content-type':'application/json','x-camp-family-grant':proof},body:JSON.stringify({eventId:a.event,phone:sharedPhone})});
 const realFamily=await realLookup.json();const preview=realFamily.children?.find(child=>child.childPhotoPreviewUrl)?.childPhotoPreviewUrl;
 if(!preview)throw new Error('Actual photo preview setup');
 const visible=await fetch(photoOrigin+preview);await visible.arrayBuffer();
 const originalNow=Date.now;let expired;
 try{Date.now=()=>deadline+1;expired=await fetch(photoOrigin+preview);await expired.arrayBuffer();}finally{Date.now=originalNow;}
 rows.actualPhotoExpiry=realLookup.status===200&&Number(new URL(preview,photoOrigin).searchParams.get('exp'))===deadline&&visible.status===200&&expired.status===404;
 console.log('CAMP_RESULTS='+JSON.stringify(rows));
} finally {if(photoServer)await new Promise(resolve=>photoServer.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));await c.end();const {pool}=await import(moduleUrl('server/db.ts'));await pool.end();}
process.exit(0);
`);
      const run = spawnSync(process.execPath, [join(APP, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(APP, 'tsconfig.json'), script],
        { cwd: APP, env, encoding: 'utf8', timeout: 240_000 });
      const match = /CAMP_RESULTS=(.+)/.exec(run.stdout ?? '');
      if (run.status !== 0) {
        const output = (run.stdout ?? '') + (run.stderr ?? '');
        console.info('Camp review setup', /CAMP_SETUP_ERROR=(.+)/.exec(output)?.[1] ?? 'No result marker');
        console.info('Camp review frames', [...output.matchAll(/[A-Za-z0-9_-]+\.(?:ts|mts|js|mjs):\d+:\d+/g)].map(x => x[0]));
      }
      expect(run.status, 'Camp child completes').toBe(0);
      expect(match, 'Camp result recorded').toBeTruthy();
      results = JSON.parse(match![1]!);
    } finally {
      await database.drop();
      const absolute = resolve(directory), bound = relative(resolve(tmpdir()), absolute);
      expect(!isAbsolute(bound) && !bound.startsWith('..') && bound.startsWith('oto-camp-sms-review-')).toBe(true);
      rmSync(absolute, { recursive: true, force: true });
    }
  }, 420_000);

  it('ordinary and legacy lookup reveal no saved family payload before verification', () => expect(results.noSavedDisclosure).toBe(true));
  it('explicit, implicit and prior-camp saved mutations require verification', () => expect(results.noSavedMutation).toBe(true));
  it('provider availability is explicit and unavailable configuration sends nothing', () => expect(results.providerUnavailable).toBe(true));
  it('challenge purpose and the owning camp/park are required', () => expect(results.purposeAndCamp).toBe(true));
  it('an approved challenge cannot be reused and a lookup grant cannot write', () => expect(results.challengeReplay && results.lookupGrantCannotWrite).toBe(true));
  it('verified lookup retains children, private photo previews and prior agreement eligibility', () => expect(results.verifiedLookup).toBe(true));
  it('FINDING 1 high, fixed: public photo previews inherit proof expiry; prescribed fix: cap preview authority at the verified session deadline', () => expect(results.previewExpiry).toBe(true));
  it('the actual signed photo reader serves an owned file and refuses it after the proof deadline', () => expect(results.actualPhotoExpiry).toBe(true));
  it('lookup consumes its grant and write grants cannot reopen lookup', () => expect(results.lookupReplay).toBe(true));
  it('another phone, camp, park or registration cannot use the grant', () => expect(results.swappedGrant).toBe(true));
  it('camp verification does not verify an account phone', () => expect(results.accountUntouched).toBe(true));
  it('a later child validation response rolls back the complete batch', () => expect(results.batchRollback).toBe(true));
  it('profile propagation and grant rotation roll back together', () => expect(results.propagationRollback).toBe(true));
  it('owned updates preserve prior signature/photo behavior and propagate only within the park', () => expect(results.savedAndPriorAgreement).toBe(true));
  it('consumed and concurrent write grants authorize exactly one submission', () => expect(results.writeReplay && results.concurrentReplay).toBe(true));
  it('expired challenges and grants stop before provider or saved mutations', () => expect(results.expiredGrant && results.expiredChallenge).toBe(true));
  it('new families and fresh siblings can register without authority over saved children', () => expect(results.newFamiliesAndSiblings).toBe(true));
  it('a returning-family batch records all children under one rotating proof', () => expect(results.returningBatch).toBe(true));
  it('a new phone cannot smuggle an existing ID or a prior signature', () => expect(results.explicitAndPriorBypass).toBe(true));
  it('additional and complete pickup contact phones remain eligible', () => expect(results.matchingContacts).toBe(true));
  it('FINDING 2 high, fixed: partial pickup numbers cannot select a family; prescribed fix: match the complete recorded phone', () => expect(results.partialPickup).toBe(true));
  it('phone requests, IP requests and verification attempts retain the existing ceilings', () => expect(results.requestPhoneLimit && results.requestIpLimit && results.verifyLimit).toBe(true));
  it('provider error details remain private', () => expect(results.providerErrorPrivate).toBe(true));
});

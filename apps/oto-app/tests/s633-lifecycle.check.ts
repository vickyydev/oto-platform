// Own transaction-contained fixtures. Root runs this only in its disposable SCRUM-633 database.
// Transport tests inject all HTTP; they never contact the platform or a provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

let target: URL;
try { target = new URL(process.env.DATABASE_URL ?? ''); } catch { throw new Error('Isolated lifecycle database required'); }
if (process.env.SCRUM_633_LIFECYCLE_TESTS !== '1' || target.hostname !== process.env.SCRUM_633_EXPECT_DB_HOST
  || target.pathname.slice(1) !== process.env.SCRUM_633_EXPECT_DB_NAME || !/^zz_test_633_[a-z0-9_]+$/.test(target.pathname.slice(1))) {
  throw new Error('Isolated lifecycle database guard refused');
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=otoapp', max: 2 });
const results: Record<string, boolean> = {};
async function check(name: string, action: () => Promise<void> | void) {
  try { await action(); results[name] = true; } catch { results[name] = false; }
  console.log(`${results[name] ? 'ok' : 'not ok'} lifecycle: ${name}`);
}
async function fixture(action: (client: pg.PoolClient, userId: string, accountId: string) => Promise<void>, options: { linked?: boolean; active?: boolean } = {}) {
  const client = await pool.connect(), userId = randomUUID(), accountId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO users (id,email,password,full_name,role,is_active,platform_user_id)
      VALUES ($1,$2,'!','ZZ TEST 633 lifecycle','staff',$3,$4)`,
    [userId, `zz-test-633-${userId}@example.invalid`, options.active ?? true, options.linked === false ? null : accountId]);
    await action(client, userId, accountId);
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
}
const events = async (client: pg.PoolClient, userId: string) =>
  (await client.query('SELECT * FROM login_lifecycle_events WHERE user_id=$1 ORDER BY created_at,id', [userId])).rows;

await check('durable queue is installed with private immutable identity snapshots and bounded state fields', async () => {
  const { rows } = await pool.query(`SELECT column_name,data_type,is_nullable FROM information_schema.columns
    WHERE table_schema='otoapp' AND table_name='login_lifecycle_events' ORDER BY ordinal_position`);
  assert.deepEqual(rows.map(row => row.column_name), ['id','user_id','platform_account_id','created_at','state','settled_at','attempt_count','last_error_code']);
  assert.equal(rows[0].data_type, 'uuid'); assert.equal(rows[2].data_type, 'uuid');
  assert.equal(rows[3].data_type, 'timestamp with time zone'); assert.equal(rows[5].data_type, 'timestamp with time zone');
});
await check('a linked true-to-false update queues exactly one event; repeated false updates never duplicate it', () => fixture(async (client, userId, accountId) => {
  await client.query('UPDATE users SET is_active=false WHERE id=$1', [userId]);
  const [event] = await events(client, userId);
  assert.ok(event); assert.match(event.id, /^[a-f0-9-]{36}$/);
  assert.equal(event.user_id,userId); assert.equal(event.platform_account_id,accountId);
  assert.equal(event.state,'pending'); assert.equal(event.attempt_count,0); assert.equal(event.settled_at,null);
  await client.query('UPDATE users SET is_active=false WHERE id=$1', [userId]);
  assert.deepEqual((await events(client,userId)).map(row => row.id), [event.id]);
}));
await check('unlinked disable and an initially inactive linked insert queue nothing; no backfill occurs', async () => {
  await fixture(async (client,userId) => {
    await client.query('UPDATE users SET is_active=false WHERE id=$1',[userId]); assert.equal((await events(client,userId)).length,0);
  }, {linked:false});
  await fixture(async (client,userId) => { assert.equal((await events(client,userId)).length,0); }, {active:false});
});
await check('rolling back the disable also rolls back its event in the same transaction', () => fixture(async (client,userId) => {
  await client.query('SAVEPOINT before_disable');
  await client.query('UPDATE users SET is_active=false WHERE id=$1',[userId]); assert.equal((await events(client,userId)).length,1);
  await client.query('ROLLBACK TO SAVEPOINT before_disable');
  assert.equal((await events(client,userId)).length,0);
  assert.equal((await client.query('SELECT is_active FROM users WHERE id=$1',[userId])).rows[0].is_active,true);
}));
await check('reactivation supersedes the old pending ID and a later disable creates a distinct immutable event', () => fixture(async (client,userId,accountId) => {
  await client.query('UPDATE users SET is_active=false WHERE id=$1',[userId]); const [first] = await events(client,userId);
  await client.query('UPDATE users SET is_active=true WHERE id=$1',[userId]);
  const [settled] = await events(client,userId); assert.equal(settled.id,first.id); assert.equal(settled.state,'superseded'); assert.ok(settled.settled_at);
  await client.query('UPDATE users SET is_active=false WHERE id=$1',[userId]);
  const all = await events(client,userId); assert.equal(all.length,2);
  const pending = all.find(row=>row.state==='pending'); assert.ok(pending); assert.notEqual(pending.id,first.id);
  assert.equal(pending.user_id,userId); assert.equal(pending.platform_account_id,accountId);
}));
await check('unlink followed by an otherwise allowed user delete retains the pending identity snapshot without an FK side effect', () => fixture(async (client,userId,accountId) => {
  await client.query('UPDATE users SET is_active=false WHERE id=$1',[userId]); const [before] = await events(client,userId);
  await client.query('UPDATE users SET platform_user_id=null WHERE id=$1',[userId]);
  await client.query('DELETE FROM users WHERE id=$1',[userId]);
  const [after] = await events(client,userId); assert.equal(after.id,before.id); assert.equal(after.user_id,userId);
  assert.equal(after.platform_account_id,accountId); assert.equal(after.state,'pending');
}));

const modulePath = new URL('../server/lib/platformLifecycle.ts', import.meta.url);
const lifecycle = existsSync(modulePath) ? await import(modulePath.href) : null;
type Summary = { selected: number; delivered: number; superseded: number; failed: number };
function transport(respond: (id: string, attempt: number) => Promise<Response>) {
  const event = {id:randomUUID(),user_id:randomUUID(),platform_account_id:randomUUID(),state:'pending'};
  const calls: {url:string;init:RequestInit}[] = [], queries: {sql:string;values:unknown[]}[] = [];
  const key = 'ZZ TEST local-only unused lifecycle key';
  const dependencies = {
    database: {async query(sql:string,values:unknown[]=[]){ queries.push({sql,values}); return {rows:/^\s*SELECT/i.test(sql)?[event]:[],rowCount:1}; }},
    config:{apiUrl:'https://platform.invalid',key},
    fetch: async (url:string,init:RequestInit) => { calls.push({url,init}); const body=JSON.parse(String(init.body));
      assert.deepEqual(Object.keys(body),['eventId']); assert.equal(body.eventId,event.id);
      assert.equal((init.headers as Record<string,string>).authorization,`Bearer ${key}`);
      assert.equal(init.redirect,'error'); assert.ok(init.signal); return respond(body.eventId,calls.length); },
  };
  return {event,calls,queries,dependencies};
}
const response = (eventId:string,state='delivered') => new Response(JSON.stringify({ok:true,eventId,state,replayed:false}),{status:200});
async function drain(dependencies:unknown,limit=25):Promise<Summary> {
  assert.ok(lifecycle && typeof lifecycle.drainPlatformLifecycleEvents==='function','transport is built');
  return lifecycle.drainPlatformLifecycleEvents(dependencies,limit);
}
await check('transport posts only eventId with a timeout and no redirect, uses bounded unlocked reads, and leaves terminal settlement to core', async () => {
  const h=transport(async id=>response(id)), summary=await drain(h.dependencies,3);
  assert.equal(summary.selected,1); assert.equal(summary.delivered,1); assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].url,'https://platform.invalid/admin/apps/oto_app/lifecycle-deactivations');
  assert.ok(h.queries.some(row=>/^\s*SELECT/i.test(row.sql)&&row.values.includes(3)));
  for(const row of h.queries){ assert.doesNotMatch(row.sql,/\b(BEGIN|FOR UPDATE|LOCK TABLE|COMMIT)\b/i);
    assert.doesNotMatch(row.sql,/SET\s+state\s*=/i); }
});
await check('timeout or lost response retains the event and a later drain retries exactly the same ID', async () => {
  const h=transport(async (id,n)=>{if(n===1)throw new Error('PRIVATE_TRANSPORT_DETAIL');return response(id)});
  assert.equal((await drain(h.dependencies)).failed,1); assert.equal((await drain(h.dependencies)).delivered,1);
  assert.equal(h.calls.length,2); assert.equal(h.calls[0].init.body,h.calls[1].init.body);
  assert.equal(JSON.stringify(h.queries).includes('PRIVATE_'),false);
  assert.ok(h.queries.some(row=>/last_error_code/i.test(row.sql)));
});
await check('HTTP refusal, redirect, unsafe extra fields and wrong event receipts record only safe error codes and never count as delivered', async () => {
  for(const respond of [async()=>new Response('PRIVATE_BODY',{status:403}),async()=>new Response('PRIVATE_BODY',{status:500}),
    async()=>new Response(null,{status:302}),async()=>response(randomUUID()),
    async(id:string)=>new Response(JSON.stringify({ok:true,eventId:id,state:'delivered',replayed:false,private:'PRIVATE_BODY'}),{status:200})]){
    const h=transport(respond), summary=await drain(h.dependencies); assert.equal(summary.delivered,0); assert.equal(summary.failed,1);
    assert.equal(JSON.stringify(h.queries).includes('PRIVATE_'),false);
    assert.ok(h.queries.some(row=>/last_error_code/i.test(row.sql)));
  }
});
await check('a validated superseded acknowledgement is terminal without an app-side state update', async () => {
  const h=transport(async id=>response(id,'superseded')); assert.equal((await drain(h.dependencies)).superseded,1);
  assert.ok(h.queries.every(row=>!/SET\s+state\s*=/i.test(row.sql)));
});
await check('transport starts beside the existing schedule entry, independently of the original night-job mode', () => {
  const index=readFileSync(new URL('../server/index.ts',import.meta.url),'utf8');
  assert.ok(index.includes('startPlatformLifecycleTransport(')); assert.ok(index.includes('startScheduledJobs();'));
  assert.ok(lifecycle && typeof lifecycle.startPlatformLifecycleTransport==='function');
});
await pool.end();
const passed=Object.values(results).filter(Boolean).length;
console.log(`s633-lifecycle.check: ${passed}/${Object.keys(results).length} checks passed`);
if(passed!==Object.keys(results).length)process.exitCode=1;

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { need } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/env.mjs';
const { request } = createRequire('C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/apps/pos/package.json')('@playwright/test');
const ctx = await request.newContext({ baseURL: 'https://oto-pos-web-staging.onrender.com' });
const result = { at: new Date().toISOString() };
try {
  if ((await ctx.post('/api/auth/sign-in', {data:{phone:need('STAGING_ADMIN_PHONE'),password:need('STAGING_ADMIN_PASSWORD')}})).status() !== 200) throw Error('Sign-in failed');
  const response = await ctx.get('/api/ops/health');
  if (response.status() !== 200) throw Error('Health read failed');
  result.alerts = (await response.json()).alerts.filter(a => a.key.startsWith('payments.awaiting_staff:')).map(a => ({key:a.key,title:a.title,detail:a.detail,resolvedAt:a.resolvedAt}));
} finally {
  result.signOut = (await ctx.post('/api/auth/sign-out')).status();
  result.me = (await ctx.get('/api/me')).status();
  await ctx.dispose();
}
writeFileSync(resolve(import.meta.dirname,process.argv[2]),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
if(result.me!==401)throw Error('Sign-out not verified');

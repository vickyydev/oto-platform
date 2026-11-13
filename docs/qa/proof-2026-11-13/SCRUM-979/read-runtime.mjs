import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, stagingServices } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/render.mjs';
const services = (await stagingServices()).filter(s => ['oto-api-staging','oto-pos-web-staging','oto-console-staging'].includes(s.name));
const results = await Promise.allSettled(services.map(async s => {
  const rows = await render('GET', `/services/${s.id}/deploys?limit=10`);
  const live = rows.map(r=>r.deploy).find(d=>d.status==='live');
  if(!live)throw Error('No live deployment for '+s.name);
  return {service:s.name,id:live.id,status:live.status,sha:live.commit?.id,finishedAt:live.finishedAt};
}));
const rows = results.map(r=>{if(r.status==='rejected')throw r.reason;return r.value;});
if(rows.find(r=>r.service==='oto-api-staging')?.sha!=='0ea85faaf5b4e62204eaabdda5d691dd2b9a248c')throw Error('API deployment changed during proof');
const receipt={at:new Date().toISOString(),services:rows};
writeFileSync(resolve(import.meta.dirname,process.argv[2]??'runtime-end.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));

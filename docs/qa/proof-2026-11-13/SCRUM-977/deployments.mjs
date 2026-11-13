import {render,stagingServices} from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/render.mjs';
import {writeFileSync} from 'node:fs';
const names=['oto-pos-staging','oto-pos-web-staging','oto-api-staging'];
const services=await stagingServices();const result=[];
for(const name of names){const s=services.find(x=>x.name===name);const ds=await render('GET',`/services/${s.id}/deploys?limit=8`);result.push({name,deploys:ds.map(x=>({id:x.deploy.id,status:x.deploy.status,sha:x.deploy.commit?.id,finishedAt:x.deploy.finishedAt}))});}
writeFileSync(new URL(process.argv[2]??'deploys-start.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));

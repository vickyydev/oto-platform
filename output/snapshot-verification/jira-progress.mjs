import { readFileSync } from 'node:fs';
import { jget,jpost,comment,statusOf,attach } from '../../scripts/session/jira-lib.mjs';
const [mode,...args]=process.argv.slice(2),key='SCRUM-201';
if(mode==='attach'){
 const result=await attach(key,args);process.stdout.write(JSON.stringify(result)+'\n');
 if(result.status!==200)process.exitCode=1;
}else if(mode==='comment'||mode==='checkpoint'){
 if(mode==='checkpoint'){
  const transitions=await jget('/rest/api/3/issue/'+key+'/transitions');
  const next=transitions.transitions?.find(t=>t.to.name==='In Progress');
  if(!next)throw new Error('In Progress transition unavailable');
  const result=await jpost('/rest/api/3/issue/'+key+'/transitions',{transition:{id:next.id}});
  if(result.status!==204)throw new Error('Status update failed');
 }
 const result=await comment(key,readFileSync(args[0],'utf8'));
 process.stdout.write(JSON.stringify({commentStatus:result.status,status:await statusOf(key)})+'\n');
 if(result.status!==201)process.exitCode=1;
}else throw new Error('Unknown action');

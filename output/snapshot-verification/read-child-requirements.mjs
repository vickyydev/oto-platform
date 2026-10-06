import {jget} from '../../scripts/session/jira-lib.mjs';
const plain=node=>typeof node==='string'?node:Array.isArray(node)?node.map(plain).join('\n'):node&&typeof node==='object'?(node.text||plain(node.content||[])):'';
for(const key of ['SCRUM-201','SCRUM-233','SCRUM-337']){
 const issue=await jget('/rest/api/3/issue/'+key+'?fields=summary,status,description');
 process.stdout.write(JSON.stringify({key,summary:issue.fields?.summary,status:issue.fields?.status?.name,description:plain(issue.fields?.description).slice(0,6000)})+'\n');
}

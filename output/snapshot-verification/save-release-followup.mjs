import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
for(const file of ['docs/progress/STATUS.md','docs/progress/SESSION_HANDOVER.md','docs/progress/SPRINT_2_PROGRESS.md']){
 const p=resolve(root,file);let text=readFileSync(p,'utf8');
 text=text.replace("SCRUM-201's per-display recorded response Snapshot is checked locally on\nfeat/display-response-snapshot, ready to fast-forward to main after cbce199.","SCRUM-201's per-display recorded response Snapshot is committed and pushed\non main c8f6375. Online saved-child review is now in progress on\nfeat/display-child-review.");
 text=text.replace('Last verified CI is cbce199 run 36581970114: zero steps, GitHub Actions','Exact-main CI c8f6375 run 36585794087 / check 109465628907: zero steps,\nGitHub Actions');
 text=text.replace('No new staging deployment or CI-packed Pi release is claimed. Check the exact\nnew main run after this push. Rebuild lost temporary payment/offline proof','No new staging deployment or CI-packed Pi release is claimed. Render was\nrechecked after the push and remains on those live commits. Rebuild lost\ntemporary payment/offline proof');writeFileSync(p,text);
}
for(const file of ['docs/progress/OPEN_QUESTIONS.md','docs/qa/separate-display/README.md']){
 const p=resolve(root,file);let text=readFileSync(p,'utf8').replaceAll('cbce199','c8f6375').replaceAll('36581970114','36585794087');
 text=text.replace('Main c8f6375 includes the checked sign-out handover and earlier display/payment work.','Main c8f6375 includes recorded display responses, sign-out handover and earlier display/payment work.');writeFileSync(p,text);
}

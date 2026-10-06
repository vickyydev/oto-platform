import { readFileSync, writeFileSync } from 'node:fs';
for (const path of ['docs/progress/STATUS.md', 'docs/progress/SESSION_HANDOVER.md', 'docs/progress/SPRINT_2_PROGRESS.md']) {
  let text = readFileSync(path, 'utf8');
  text = text.replace('SCRUM-201 now includes online saved-child review on the separate display.\n',
    'Main 88140af is pushed and includes SCRUM-201 online saved-child review.\nF&B guest display integration is in progress on feat/display-fnb-guest.\n');
  text = text.replace('The prior main checkpoint c8f6375 added recorded display responses. Its CI\n36585794087 ran zero steps due to GitHub Actions billing/spending availability.',
    'Exact-main CI 88140af run 36589992120 / check 109480274224 ran zero steps\ndue to GitHub Actions billing/spending availability.');
  text = text.replace('Launcher/Booth is 0468c38; OTO App is c416065. Recheck the next exact main CI\nand deployment after push. No new CI-packed Pi artifact is available yet.',
    'Launcher/Booth is 0468c38; OTO App is c416065. Render was checked after the\npush and has not advanced. No new CI-packed Pi artifact is available yet.');
  writeFileSync(path, text);
}
const open = 'docs/progress/OPEN_QUESTIONS.md';
writeFileSync(open, readFileSync(open, 'utf8').replace('Main source c8f6375', 'Main source 88140af')
  .replace('CI 36585794087', 'CI 36589992120'));
const qa = 'docs/qa/separate-display/README.md';
writeFileSync(qa, readFileSync(qa, 'utf8').replace('Main c8f6375 includes recorded display responses, sign-out handover and earlier display/payment work.\nGitHub Actions run 36585794087 stopped before any step because billing/spending availability',
  'Main 88140af includes saved-child review, recorded responses and the earlier display/payment work.\nGitHub Actions run 36589992120 / check 109480274224 stopped before any step because billing/spending availability'));
console.log('Exact pushed-main CI failure and unchanged staging saved.');

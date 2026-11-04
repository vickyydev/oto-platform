import { render, service } from 'file:///C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos/scripts/agent/render.mjs';
import { writeFileSync } from 'node:fs';
const out = { readAt: new Date().toISOString(), services: {} };
for (const n of ['oto-api-staging', 'oto-pos-web-staging', 'oto-pos-staging', 'oto-console-staging']) {
  const s = await service(n);
  const d = (await render('GET', `/services/${s.id}/deploys?limit=3`)).map((r) => r.deploy);
  const live = d.find((x) => x.status === 'live');
  out.services[n] = { liveDeploy: live?.id, commit: live?.commit?.id, finishedAt: live?.finishedAt, newest: { id: d[0]?.id, status: d[0]?.status, commit: d[0]?.commit?.id } };
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));

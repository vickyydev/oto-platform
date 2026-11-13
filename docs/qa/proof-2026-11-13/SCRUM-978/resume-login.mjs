S.phase='resume only sign-in and runtime check';
const {pathToFileURL}=await import('node:url');
await (await import(pathToFileURL(S.HERE+'steps/app-in.mjs'))).default(S);
await (await import(pathToFileURL(S.HERE+'steps/inbox-in.mjs'))).default(S);
const api=await S.request.newContext({baseURL:S.POS});
S.assert.equal((await api.post('/api/auth/sign-in',{data:{phone:S.need('STAGING_ADMIN_PHONE'),password:S.need('STAGING_ADMIN_PASSWORD')}})).status(),200);S.ctxs.pos={api};
const version=await S.appCall('GET','/qa-reports/config');
S.st.resumeRuntime={at:new Date().toISOString(),status:version.status,sha:version.body?.commitSha??version.body?.buildSha??version.body?.commit??null,keys:Object.keys(version.body??{})};S.save();
return {app:!!S.ctxs.app,inbox:!!S.ctxs.inbox,pos:!!S.ctxs.pos,runtime:S.st.resumeRuntime};
